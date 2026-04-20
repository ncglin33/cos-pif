const functions = require("firebase-functions/v1");
const admin = require("firebase-admin");
const express = require("express");
const cors = require("cors");
const nodemailer = require("nodemailer");
const { defineSecret } = require("firebase-functions/params");

// Gmail secrets (Cloud Secret Manager)
// Required for App Password mode:
const MAIL_FROM_GMAIL = defineSecret("MAIL_FROM_GMAIL");
const MAIL_APP_PASSWORD = defineSecret("MAIL_APP_PASSWORD");
const { google } = require("googleapis");
const crypto = require("crypto");
const nomnoml = require("nomnoml");

// --- Express Apps (needed for exports.api / generatePifId / createPifProject) ---
const app = express();
const pifApp = express();
const createPifApp = express();
// --- END Express Apps ---

admin.initializeApp();
const db = admin.firestore();

// --- CONFIGURATION (Gmail via Nodemailer) ---
// ✅ 建議：使用 Secret Manager（不要 .env / 不要 functions:config）
//    firebase functions:secrets:set MAIL_FROM_GMAIL        # 你的 Gmail，例如 ncglin33@gmail.com
//    firebase functions:secrets:set MAIL_APP_PASSWORD      # 16 碼 App Password
//    firebase deploy --only functions:processMailQueue

// 支援兩種模式（擇一設定即可）：
// A) OAuth2（建議；可長期穩定）
//    （舊）firebase functions:config:set gmail.user="xxx@gmail.com" gmail.client_id="..." gmail.client_secret="..." gmail.refresh_token="..."
// B) App Password（僅適用已開啟 2FA 的 Gmail/Workspace 帳號）
//    （舊）firebase functions:config:set gmail.user="xxx@gmail.com" gmail.app_password="xxxx xxxx xxxx xxxx"
//
// 可選：
//    firebase functions:config:set gmail.from_email="xxx@gmail.com" gmail.from_name="CosPIF"
//
const GMAIL_TRANSPORT_TTL_MS = 50 * 60 * 1000; // 50 分鐘（OAuth2 access token 通常 60 分鐘有效）
let _gmailTransporterCache = null;
let _gmailTransporterCacheAt = 0;

function _getGmailConfig() {
  // 讀取優先順序：
  // 1) Secret Manager（defineSecret + runWith(secrets)）
  // 2) process.env（本機/CI 測試用）
  // 3) functions.config().gmail.*（舊版相容；建議逐步移除）
  const cfg = (typeof functions.config === "function") ? functions.config() : {};
  const g = (cfg && cfg.gmail) ? cfg.gmail : {};

  const env = (name) => (process.env[name] || "").toString().trim();
  const secret = (s) => {
    try {
      if (!s || typeof s.value !== "function") return "";
      return (s.value() || "").toString().trim();
    } catch (e) {
      return "";
    }
  };
  const pick = (...vals) => {
    for (const v of vals) {
      const s = (v || "").toString().trim();
      if (s) return s;
    }
    return "";
  };

  const user = pick(
    secret(MAIL_FROM_GMAIL),     // ✅ Secret Manager（建議）
    env("MAIL_FROM_GMAIL"),      // 本機/CI（非必要）
    env("GMAIL_USER"),           // 舊命名相容
    g.user                       // functions:config 相容
  );

  return {
    user,
    // App Password（2FA + App Password）
    appPassword: pick(
      secret(MAIL_APP_PASSWORD), // ✅ Secret Manager（建議）
      env("MAIL_APP_PASSWORD"),  // 本機/CI（非必要）
      env("GMAIL_APP_PASSWORD"), // 舊命名相容
      g.app_password             // functions:config 相容
    ),

    // OAuth2（若你仍要用，可維持用 env / functions:config；若要 Secret Manager 再另做一版）
    clientId: pick(env("MAIL_CLIENT_ID"), env("GMAIL_CLIENT_ID"), g.client_id),
    clientSecret: pick(env("MAIL_CLIENT_SECRET"), env("GMAIL_CLIENT_SECRET"), g.client_secret),
    refreshToken: pick(env("MAIL_REFRESH_TOKEN"), env("GMAIL_REFRESH_TOKEN"), g.refresh_token),

    // 寄件者顯示（非敏感：用 env 即可；未設則預設）
    fromEmail: pick(env("MAIL_FROM_EMAIL"), env("GMAIL_FROM_EMAIL"), g.from_email, user),
    fromName: pick(env("MAIL_FROM_NAME"), env("GMAIL_FROM_NAME"), g.from_name, "CosPIF"),
  };
}

async function _buildGmailTransporter() {
  const c = _getGmailConfig();
  if (!c.user) {
    throw new Error("Gmail is not configured: missing MAIL_FROM_GMAIL (or gmail.user / GMAIL_USER).");
  }

  // 模式 B：App Password（最簡單，但必須是 2FA + App Password）
  if (c.appPassword) {
    return nodemailer.createTransport({
      service: "gmail",
      auth: { user: c.user, pass: c.appPassword },
    });
  }

  // 模式 A：OAuth2（推薦）
  if (c.clientId && c.clientSecret && c.refreshToken) {
    const oauth2Client = new google.auth.OAuth2(c.clientId, c.clientSecret);
    oauth2Client.setCredentials({ refresh_token: c.refreshToken });

    const accessTokenObj = await oauth2Client.getAccessToken();
    const accessToken = (typeof accessTokenObj === "string") ? accessTokenObj : accessTokenObj?.token;
    if (!accessToken) {
      throw new Error("Failed to obtain Gmail OAuth2 access token. Please verify refresh_token / client credentials.");
    }

    return nodemailer.createTransport({
      service: "gmail",
      auth: {
        type: "OAuth2",
        user: c.user,
        clientId: c.clientId,
        clientSecret: c.clientSecret,
        refreshToken: c.refreshToken,
        accessToken,
      },
    });
  }

  throw new Error("Gmail is not configured: provide MAIL_APP_PASSWORD OR (MAIL_CLIENT_ID / MAIL_CLIENT_SECRET / MAIL_REFRESH_TOKEN).");
}

async function _getGmailTransporter() {
  const now = Date.now();
  if (_gmailTransporterCache && (now - _gmailTransporterCacheAt) < GMAIL_TRANSPORT_TTL_MS) {
    return _gmailTransporterCache;
  }
  _gmailTransporterCache = await _buildGmailTransporter();
  _gmailTransporterCacheAt = now;
  return _gmailTransporterCache;
}

// --- END CONFIGURATION ---



// --- QA Chat: Defaults + Settings (Firestore) + Helpers ---
const QA_CHAT_SETTINGS_DOC_PATH = "settings/qaChat";
const QA_CHAT_SETTINGS_TTL_MS = 60 * 1000; // 60s cache
let _qaChatSettingsCache = null;
let _qaChatSettingsCacheAt = 0;


// --- OpenAI (ChatGPT) helpers for QA Chat / QA Search ---
function _getOpenAIKey() {
  try {
    const cfg = (typeof functions.config === "function") ? functions.config() : {};
    const key = (cfg?.openai?.key || process.env.OPENAI_API_KEY || "").toString().trim();
    return key || null;
  } catch (e) {
    return (process.env.OPENAI_API_KEY || "").toString().trim() || null;
  }
}

function _extractOpenAIOutputText(respJson) {
  // Responses API returns { output: [ { type:"message", content:[{type:"output_text", text:"..."}] } ] }
  const out = [];
  const output = Array.isArray(respJson?.output) ? respJson.output : [];
  for (const item of output) {
    if (item?.type !== "message") continue;
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const c of content) {
      if (c?.type === "output_text" && typeof c.text === "string") out.push(c.text);
    }
  }
  return out.join("").trim();
}

async function _openaiResponsesCreate({ apiKey, model, instructions, input, maxOutputTokens, temperature, jsonMode, reasoningEffort }) {
  if (!globalThis.fetch) {
    throw new Error("Global fetch() is not available. Please use Node.js 18+ runtime for Cloud Functions.");
  }

  const payloadBase = {
    model,
    input,
    instructions: instructions || undefined,
    max_output_tokens: (typeof maxOutputTokens === "number") ? maxOutputTokens : undefined,
    store: false,
    text: { format: { type: jsonMode ? "json_object" : "text" } }
  };

  // gpt-5 / o-series 可用 reasoning.effort（可選）
  if (reasoningEffort && typeof reasoningEffort === "string") {
    payloadBase.reasoning = { effort: reasoningEffort };
  }

  // 有些模型（特別是推理/某些新模型）不支援 temperature；若遇到錯誤會自動重試（移除 temperature）。
  const tempProvided = (typeof temperature === "number");
  const payloadWithTemp = tempProvided ? { ...payloadBase, temperature } : payloadBase;

  const doRequest = async (payload) => {
    const r = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`
      },
      body: JSON.stringify(payload)
    });

    const bodyText = await r.text();
    let json;
    try { json = JSON.parse(bodyText); } catch { json = null; }

    if (!r.ok) {
      const msg = (json?.error?.message || bodyText || `OpenAI API error (${r.status})`).toString();
      const err = new Error(msg);
      err.status = r.status;
      err.body = bodyText;
      throw err;
    }

    const outText = _extractOpenAIOutputText(json);
    if (!outText) {
      // fallback：有些 SDK 會回 output_text，但 REST 以 output[] 為主；此處保底
      const maybe = (json?.output_text || json?.text || "").toString().trim();
      return maybe || "";
    }
    return outText;
  };

  try {
    return await doRequest(payloadWithTemp);
  } catch (e) {
    const msg = (e && e.message) ? String(e.message) : "";
    if (tempProvided && /temperature/i.test(msg) && /(not supported|unsupported parameter)/i.test(msg)) {
      // 這個 model 不支援 temperature → 自動改成不帶 temperature 再試一次
      return await doRequest(payloadBase);
    }
    throw e;
  }
}

const QA_CHAT_DEFAULTS = {
  // 引用 QA 範圍
  topK: 8,                 // 最多引用幾筆 QA 作為知識庫
  useQA: true,             // 是否使用候選 QA 作為參考（false=純 AI 直接回答）
  fallbackToDb: false,      // 若前端沒傳 candidates，是否改用 Firestore qa_database 當 fallback
  fallbackLimit: 30,        // fallback 時最多抓幾筆 QA（仍會再套 topK）

  // 回覆格式
  format: "bullets",        // "plain" | "bullets" | "steps" | "markdown"

  // 是否要附上參考 QA 編號（優先使用 qa.no，否則使用 docId/引用序號）
  includeRefs: true,

  // 其他控制
  strictKB: false,          // true=只能用提供的 QA 作答；找不到就回固定拒答句
  maxAnswerChars: 1800,     // 避免回答過長
  maxHistoryTurns: 6,       // 多輪對話最多帶幾則歷史訊息（user+assistant 合計）
  model: "gpt-5-mini",
  reasoningEffort: "low",   // gpt-5 / o-series 可用：low|medium|high（不支援時會忽略）
  temperature: 0.2,
  maxOutputTokens: 700
};

const _clampInt = (v, min, max, fallback) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
};
const _toBool = (v, fallback) => (typeof v === "boolean" ? v : fallback);
const _toStr = (v, fallback) => (typeof v === "string" ? v.trim() : fallback);

async function _getQaChatSettings() {
  const now = Date.now();
  if (_qaChatSettingsCache && (now - _qaChatSettingsCacheAt) < QA_CHAT_SETTINGS_TTL_MS) {
    return _qaChatSettingsCache;
  }
  try {
    const doc = await db.doc(QA_CHAT_SETTINGS_DOC_PATH).get();
    _qaChatSettingsCache = doc.exists ? (doc.data() || {}) : {};
    _qaChatSettingsCacheAt = now;
    return _qaChatSettingsCache;
  } catch (e) {
    console.error("qaChat: failed to load settings/qaChat, fallback to defaults.", e);
    return {};
  }
}

function _sanitizeQaChatOptions(rawOptions = {}, savedOptions = {}) {
  const merged = { ...QA_CHAT_DEFAULTS, ...savedOptions, ...rawOptions };

  const format = _toStr(merged.format, QA_CHAT_DEFAULTS.format);
  const allowedFormats = new Set(["plain", "bullets", "steps", "markdown"]);
  const safeFormat = allowedFormats.has(format) ? format : QA_CHAT_DEFAULTS.format;

  const reasoningEffortRaw = _toStr(merged.reasoningEffort, QA_CHAT_DEFAULTS.reasoningEffort);
  const allowedEfforts = new Set(["low", "medium", "high"]);
  const safeEffort = allowedEfforts.has(reasoningEffortRaw) ? reasoningEffortRaw : QA_CHAT_DEFAULTS.reasoningEffort;

  return {
    topK: _clampInt(merged.topK, 1, 20, QA_CHAT_DEFAULTS.topK),
    useQA: _toBool(merged.useQA, QA_CHAT_DEFAULTS.useQA),
    fallbackToDb: _toBool(merged.fallbackToDb, QA_CHAT_DEFAULTS.fallbackToDb),
    fallbackLimit: _clampInt(merged.fallbackLimit, 5, 80, QA_CHAT_DEFAULTS.fallbackLimit),

    format: safeFormat,
    includeRefs: _toBool(merged.includeRefs, QA_CHAT_DEFAULTS.includeRefs),

    strictKB: _toBool(merged.strictKB, QA_CHAT_DEFAULTS.strictKB),
    maxAnswerChars: _clampInt(merged.maxAnswerChars, 300, 5000, QA_CHAT_DEFAULTS.maxAnswerChars),
    maxHistoryTurns: _clampInt(merged.maxHistoryTurns, 0, 20, QA_CHAT_DEFAULTS.maxHistoryTurns),

    model: _toStr(merged.model, QA_CHAT_DEFAULTS.model),
    reasoningEffort: safeEffort,
    temperature: Math.max(0, Math.min(1, Number(merged.temperature ?? QA_CHAT_DEFAULTS.temperature))),
    maxOutputTokens: _clampInt(merged.maxOutputTokens, 200, 2048, QA_CHAT_DEFAULTS.maxOutputTokens)
  };
}

function _normalizeQaItem(item, idx) {
  const no = item?.no ?? item?.qaNo ?? item?.number ?? (idx + 1);
  const id = (item?.id ?? item?.docId ?? item?.qaId ?? "").toString().trim();
  const question = (item?.question ?? item?.q ?? "").toString().trim();
  const answer = (item?.answer ?? item?.a ?? "").toString().trim();
  const category = (item?.category ?? item?.tag ?? "").toString().trim();
  if (!question || !answer) return null;
  return { no, id, question, answer, category };
}

function _formatInstruction(format) {
  switch (format) {
    case "plain": return "用短段落直接回答，避免多餘標題。";
    case "bullets": return "用條列（• 或 -）回答，必要時分小段落。";
    case "steps": return "用步驟式（1. 2. 3.）回答。";
    case "markdown": return "用乾淨的 Markdown（可用小標題/條列/表格，但不要太長）。";
    default: return "用條列回答。";
  }
}

function _buildQaKbText(qas) {
  // 注意：這裡的「引用序號」是 1..N（依提供順序）
  return qas.map((q, i) => {
    const refNo = i + 1;
    const meta = [
      `引用序號:${refNo}`,
      (q.no != null ? `QA編號:${q.no}` : null),
      (q.category ? `分類:${q.category}` : null),
      (q.id ? `id:${q.id}` : null)
    ].filter(Boolean).join("｜");
    return `【${meta}】\nQ: ${q.question}\nA: ${q.answer}`;
  }).join("\n\n");
}

function _safeExtractJson(text) {
  const s = (text || "").toString();
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  const raw = s.slice(start, end + 1);
  try { return JSON.parse(raw); } catch { return null; }
}
// --- END QA Chat Helpers ---


// --- Callable Functions (Best Practice) ---

exports.getCompanyData = functions.region("asia-east1").https.onCall(async (data, context) => {
  // Check for authentication
  if (!context.auth) {
    throw new functions.https.HttpsError(
      "unauthenticated",
      "The function must be called while authenticated."
    );
  }

  const companyKey = (data && data.companyKey ? data.companyKey : "").toString().trim();
  if (!companyKey) {
    throw new functions.https.HttpsError(
      "invalid-argument",
      'The function must be called with a "companyKey".'
    );
  }

  try {
    // ✅ 移除 orderBy，避免 Firestore 複合索引需求
    const wishListPromise = db.collection("pif_intent_submissions")
      .where("companyKey", "==", companyKey)
      .get();

    const evaListPromise = db.collection("eva_submissions")
      .where("companyKey", "==", companyKey)
      .get();

    const [wishListSnapshot, evaListSnapshot] = await Promise.all([
      wishListPromise,
      evaListPromise
    ]);

    const wishListData = wishListSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    const evaListData = evaListSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

    return { success: true, wishList: wishListData, evaList: evaListData };

  } catch (error) {
    console.error(`Error fetching data for company ${companyKey}:`, error);
    throw new functions.https.HttpsError(
      "internal",
      "Failed to fetch company data."
    );
  }
});

// --- AI: PIF06 製造摘要（Callable） ---
exports.generateManufacturingSummary = functions.region("asia-east1").https.onCall(async (data, context) => {
  // Check for authentication
  if (!context.auth) {
    throw new functions.https.HttpsError(
      "unauthenticated",
      "The function must be called while authenticated."
    );
  }

  const ingredients = (data && data.ingredients) ? data.ingredients : [];
  const productName = (data && data.productName ? data.productName : "").toString().trim();

  if (!Array.isArray(ingredients) || ingredients.length === 0) {
    throw new functions.https.HttpsError(
      "invalid-argument",
      'The function must be called with a non-empty "ingredients" array.'
    );
  }

  // 清理 / 正規化輸入
  const cleaned = ingredients.map((i, idx) => ({
    order: (i.order != null && i.order !== "") ? Number(i.order) : idx + 1,
    phase: (i.phase || "").toString().trim(),
    inci: (i.inci || "").toString().trim(),
    pct: (i.pct != null && i.pct !== "") ? Number(i.pct) : null
  })).filter(i => i.inci && i.phase);

  if (cleaned.length === 0) {
    throw new functions.https.HttpsError(
      "invalid-argument",
      'The function must be called with valid ingredient objects that include "inci" and "phase".'
    );
  }

  cleaned.sort((a, b) => (a.order || 0) - (b.order || 0));

  const openaiKey = _getOpenAIKey();
  if (!openaiKey) {
    throw new functions.https.HttpsError(
      "unavailable",
      "OpenAI API key is not set. Please set functions config openai.key (firebase functions:config:set openai.key=...) or env OPENAI_API_KEY."
    );
  }

  try {
    const systemPrompt = `
你是一位資深化妝品製程與配方工程顧問。
請根據使用者提供的產品名稱（若有）與配方（含相別、INCI、用量%與順序），
用專業、清楚、可直接放入 PIF 06 的語氣，產出「製造方法摘要」。

要求：
1) 以條列或短段落描述一般化妝品製程（不需過度猜測精密設備）。
2) 依相別（如：水相、油相、後添加）描述典型處理與加入順序。
3) 可合理補充常見條件樣板（如加熱至 70–80°C、均質、冷卻至 <40°C 後加入後添加），
   但要用「建議/通常」語氣，避免宣稱為唯一正確。
4) 字數約 120–220 字。
5) 使用繁體中文。
`.trim();

    const formulaLines = cleaned.map(i => {
      const pctStr = (i.pct != null && !Number.isNaN(i.pct)) ? `${i.pct}%` : "";
      const orderStr = (i.order != null && !Number.isNaN(i.order)) ? `#${i.order}` : "";
      return `${orderStr} ${i.phase} - ${i.inci} ${pctStr}`.trim();
    }).join("\n");

    const userPrompt = `
產品名稱：${productName || "（未提供）"}
配方：
${formulaLines}
`.trim();

    const summary = await _openaiResponsesCreate({
      apiKey: openaiKey,
      model: "gpt-5-mini",
      instructions: systemPrompt,
      input: userPrompt,
      maxOutputTokens: 700,
      temperature: 0.2,
      jsonMode: false,
      reasoningEffort: "low"
    });

    return { success: true, summary: (summary || "").trim() };

  } catch (error) {
    console.error("Error generating manufacturing summary:", error);
    throw new functions.https.HttpsError(
      "internal",
      error.message || "Failed to generate manufacturing summary."
    );
  }
});

// --- Flowchart: PIF06 製程流程圖（Callable / nomnoml） ---
exports.generateFlowchart = functions.region("asia-east1").https.onCall(async (data, context) => {
  // Check for authentication
  if (!context.auth) {
    throw new functions.https.HttpsError(
      "unauthenticated",
      "The function must be called while authenticated."
    );
  }

  const steps = (data && Array.isArray(data.steps)) ? data.steps : [];
  const nomnomlText = (data && (data.nomnomlText || data.nomnoml || data.source))
    ? (data.nomnomlText || data.nomnoml || data.source).toString()
    : "";

  // 允許兩種輸入模式：
  // A) 直接提供 nomnoml 語法字串
  // B) 提供 steps 陣列（由後端轉成簡易線性流程）
  if ((!nomnomlText || !nomnomlText.trim()) && (!steps || steps.length === 0)) {
    throw new functions.https.HttpsError(
      "invalid-argument",
      'The function must be called with either a non-empty "nomnomlText" string or a non-empty "steps" array.'
    );
  }

  try {
    if (!nomnoml) {
      throw new Error("nomnoml module is not available. Please install it in functions package.");
    }

    let source = nomnomlText && nomnomlText.trim();

    if (!source) {
      // 將 steps 轉為最小可用的 nomnoml 連線語法
      // steps 元素允許 { name, title, stepName, condition, note } 等欄位
      const cleaned = steps.map((s) => {
        if (typeof s === "string") return s.trim();
        if (!s) return "";
        return (s.name || s.title || s.stepName || s.step || "").toString().trim();
      })
      .filter(Boolean)
      // 避免前端已包含「開始/結束」時，後端再加一次造成自迴圈箭頭
      .filter(t => !["開始", "結束", "Start", "End"].includes(t));

      if (cleaned.length === 0) {
        throw new functions.https.HttpsError(
          "invalid-argument",
          'The "steps" array does not contain any valid step name.'
        );
      }

      // nomnoml 簡易流程： [開始]->[步驟1]->[步驟2]->...->[結束]
      const nodes = ["開始", ...cleaned, "結束"]
        .filter((v, i, arr) => arr.indexOf(v) === i) // 去重保險
        .map(t => `[${t}]`);
      const links = [];
      for (let i = 0; i < nodes.length - 1; i++) {
        links.push(`${nodes[i]} -> ${nodes[i+1]}`);
      }
      source = links.join("\n");
    }

    const svg = nomnoml.renderSvg(source);

    return { success: true, svg, source };

  } catch (error) {
    console.error("Error generating flowchart:", error);
    throw new functions.https.HttpsError(
      "internal",
      error.message || "Failed to generate flowchart."
    );
  }
});



// --- QA Chat: Callable (RAG with controllable parameters) ---
// 使用 OpenAI (ChatGPT) Responses API；引用 QA 範圍/回覆格式/是否附上參考編號 皆可由 options 調整
exports.qaChat = functions.region("asia-east1").https.onCall(async (data, context) => {
  const message = (data?.message ?? "").toString().trim();
  const rawCandidates = Array.isArray(data?.candidates) ? data.candidates : [];
  const rawHistory = Array.isArray(data?.history) ? data.history : [];
  const rawOptions = (data?.options && typeof data.options === "object") ? data.options : {};

  if (!message) {
    throw new functions.https.HttpsError("invalid-argument", 'The function must be called with a non-empty "message".');
  }

  const openaiKey = _getOpenAIKey();
  if (!openaiKey) {
    throw new functions.https.HttpsError(
      "unavailable",
      "OpenAI API key is not set. Please set functions config openai.key (firebase functions:config:set openai.key=...) or env OPENAI_API_KEY."
    );
  }

  // 讀取 Firestore 可熱調整預設值 settings/qaChat（有 TTL cache）
  const saved = await _getQaChatSettings();
  const opts = _sanitizeQaChatOptions(rawOptions, saved);

  // 正規化 candidates（useQA=false 時，完全忽略候選 QA，改用純 AI 直接回答）
  let qas = (opts.useQA ? rawCandidates : [])
    .map((c, idx) => _normalizeQaItem(c, idx))
    .filter(Boolean);

  // 若沒有 candidates 且允許 fallback：從 qa_database 取（注意：可能較耗時；仍會套 topK）
  if (opts.useQA && qas.length === 0 && opts.fallbackToDb) {
    const snap = await db.collection("qa_database").limit(opts.fallbackLimit).get();
    qas = snap.docs
      .map((d, idx) => _normalizeQaItem({ id: d.id, ...d.data() }, idx))
      .filter(Boolean);
  }

  // 限制引用範圍
  if (qas.length > opts.topK) qas = qas.slice(0, opts.topK);
  // 若完全沒 QA 可用：strictKB=true 才直接回覆；strictKB=false 則仍允許 AI 用一般知識回答
  if (qas.length === 0 && opts.strictKB) {
    const fallback = "查無資料，請聯絡客服團隊。";
    return { answer: fallback, refs: [], refItems: [], model: opts.model, used: 0 };
  }

  const kbText = (qas.length > 0) ? _buildQaKbText(qas) : "（無）";
  const formatInstruction = _formatInstruction(opts.format);

  const kbRule = opts.strictKB
    ? "你只能根據【知識庫 QA】內容回答，不可杜撰；若知識庫找不到答案，請回覆：查無資料，請聯絡客服團隊。"
    : "你可以直接用一般知識回答；若【知識庫 QA】中有相關內容，請優先參考並與其一致。若問題需要特定內部資料（例如實際報價/金額/專案狀態）但未提供，請說明需要哪些資訊或引導到對應頁面/客服，不要猜測。";

  const refsRule = opts.includeRefs
    ? "若你引用了某一筆【知識庫 QA】，請在 refs 中填入該筆的引用序號（1..N，對應知識庫清單順序）；若未引用或知識庫為空，請填 []。"
    : "refs 一律輸出 []。";

  const systemPrompt = `
你是 CosPIF 的 AI 小幫手（客服/教學/操作指引）。
${kbRule}

回覆要求：
- 回覆語氣：專業、清楚、可操作。
- 回覆格式：${formatInstruction}
- ${refsRule}
- 你必須只輸出 json（不要額外文字、不要 markdown code block）。
- 輸出 JSON 固定格式：{"answer":"...","refs":[1,3]}

【知識庫 QA】（可能為空）
${kbText}
  `.trim();

  const trimmedHistory = rawHistory
    .map(h => ({
      role: (h?.role === "assistant" ? "assistant" : "user"),
      content: (h?.content ?? "").toString().trim()
    }))
    .filter(h => h.content)
    .slice(-10);

  const historyText = trimmedHistory.length
    ? trimmedHistory.map(t => `${t.role === "assistant" ? "助理" : "使用者"}：${t.content}`).join("\n")
    : "";

  const userPrompt = `
【輸出要求】
請以 json 格式回覆，且只輸出 json（不要額外文字、不要使用 markdown code block）。

${historyText ? `【對話歷史】
${historyText}

` : ""}
【使用者問題】
${message}
  `.trim();

  try {
    const rawText = await _openaiResponsesCreate({
      apiKey: openaiKey,
      model: opts.model,
      instructions: systemPrompt,
      input: userPrompt,
      maxOutputTokens: opts.maxOutputTokens,
      temperature: opts.temperature,
      jsonMode: true,
      reasoningEffort: opts.reasoningEffort
    });

    const parsed = _safeExtractJson(rawText);

    let answer = (parsed?.answer ?? "").toString().trim();
    let refs = Array.isArray(parsed?.refs) ? parsed.refs : [];

    // 基本清理：refs 是「引用序號」（1..qas.length）
    refs = refs
      .map(n => Number(n))
      .filter(n => Number.isFinite(n) && n >= 1 && n <= qas.length)
      .map(n => Math.trunc(n));

    // 若知識庫為空或設定不顯示參考，refs 強制清空
    if (!opts.includeRefs || qas.length === 0) refs = [];


    if (!answer) {
      if (opts.strictKB) {
        answer = "查無資料，請聯絡客服團隊。";
      } else {
        // 允許模型無法產出 JSON 時，退回原文
        answer = rawText || "查無資料，請聯絡客服團隊。";
      }
    }

    // 組 refItems（給前端顯示「參考QA」按鈕用）
    const refItems = refs.map(r => {
      const qa = qas[r - 1];
      return {
        ref: r,
        no: qa.no ?? null,
        id: qa.id ?? null,
        question: qa.question
      };
    });

    // includeRefIds=false 時仍回傳 refs/refItems 方便前端「參考QA」彈窗，但可在前端選擇是否顯示
    return {
      answer,
      refs,
      refItems,
      model: opts.model,
      used: qas.length
    };

  } catch (error) {
    console.error("qaChat error:", error);
    throw new functions.https.HttpsError("internal", error.message || "qaChat failed.");
  }
});


const corsOptions = {
  origin: [
    'https://cos-pif.web.app',
    'https://www.cos-pif.web.app',
    /^https:\/\/[a-zA-Z0-9-]+\.cloudworkstations\.dev$/,
    /^http:\/\/localhost(:\d+)?$/,
    /^http:\/\/127\.0\.0\.1(:\d+)?$/
  ],
  methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
  credentials: true,
};

app.use(cors(corsOptions));
app.use(express.json());
pifApp.use(cors(corsOptions));
pifApp.use(express.json());
createPifApp.use(cors(corsOptions));
createPifApp.use(express.json());


app.post("/v1/qa-search", async (req, res) => {
  const openaiKey = _getOpenAIKey();
  if (!openaiKey) {
    return res.status(503).json({ reply: "智慧搜尋服務暫時無法使用（缺少 OpenAI API Key），請稍後再試。" });
  }

  const { message } = req.body;
  if (!message) {
    return res.status(400).json({ error: "缺少查詢問題 ('message' field)" });
  }

  try {
    const qaSnapshot = await db.collection("qa_database").get();
    if (qaSnapshot.empty) {
      return res.status(500).json({ reply: "抱歉，知識庫目前是空的，無法提供回答。" });
    }

    // ⚠️ 若 QA 很多，這段會非常長。建議前端先做候選 TopK，再改用 qaChat。
    const qaContext = qaSnapshot.docs
      .map(doc => `Q: ${doc.data().question}\nA: ${doc.data().answer}`)
      .join("\n\n");

    const system_prompt = `
你是一個專業的「CosPIF 常見問題」智慧搜尋引擎。你的任務是根據以下提供的「知識庫」，為使用者的問題找到最精確的答案。
請嚴格遵守以下規則：
1.  **知識庫優先:** 你的回答必須 100% 基於「知識庫」的內容。禁止使用任何你自己的外部知識。
2.  **找不到答案時:** 如果使用者的問題在知識庫中沒有明確答案，你必須回覆固定句：「查無資料，請聯絡客服團隊。」
3.  **禁止杜撰:** 絕對不要編造任何不存在於知識庫中的資訊。
4.  **回覆格式:** 回覆要專業、清楚、精簡，直接回答問題。
5.  **簡潔回答:** 不要加上「根據資料庫...」或「我找到了...」等多餘的開頭。

【知識庫】
${qaContext}
    `.trim();

    const reply = await _openaiResponsesCreate({
      apiKey: openaiKey,
      model: "gpt-5-mini",
      instructions: system_prompt,
      input: message,
      maxOutputTokens: 800,
      temperature: 0.2,
      jsonMode: false,
      reasoningEffort: "low"
    });

    res.json({ reply });

  } catch (error) {
    console.error("--- QA SEARCH EXECUTION ERROR ---", error);
    res.status(500).json({ reply: "抱歉，智慧搜尋引擎發生了未預期的錯誤，我們正在緊急修復中。" });
  }
});
exports.api = functions.region("us-central1").https.onRequest(app);

pifApp.post('/', async (req, res) => {
    const { prefix } = req.body;
    if (!prefix || !/^[A-Z]{2}$/.test(prefix)) {
        return res.status(400).json({ success: false, error: "Invalid or missing 'prefix'. Must be 2 uppercase letters." });
    }
    try {
        const now = new Date();
        const year = now.getFullYear().toString().slice(-2);
        const month = (now.getMonth() + 1).toString().padStart(2, '0');
        const counterPrefix = `${prefix}${year}${month}`;
        const counterRef = db.collection('counters').doc(counterPrefix);
        let newPifId;
        await db.runTransaction(async (transaction) => {
            const counterDoc = await transaction.get(counterRef);
            let nextVal = counterDoc.exists ? counterDoc.data().current_val + 1 : 1;
            transaction.set(counterRef, { current_val: nextVal });
            newPifId = `${counterPrefix}${nextVal.toString().padStart(3, '0')}`;
        });
        if (!newPifId) {
            throw new Error('Failed to generate PIF ID within transaction.');
        }
        return res.status(200).json({ success: true, pifId: newPifId });
    } catch (error) {
        console.error("Error generating PIF ID:", error);
        return res.status(500).json({ success: false, error: "Internal server error while generating PIF ID." });
    }
});
exports.generatePifId = functions.region("asia-east1").https.onRequest(pifApp);

createPifApp.post('/', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, error: 'Unauthorized: No ID token provided.' });
  }
  const idToken = authHeader.split('Bearer ')[1];
  let decodedToken;
  try {
    decodedToken = await admin.auth().verifyIdToken(idToken);
  } catch (error) {
    return res.status(401).json({ success: false, error: 'Unauthorized: Invalid ID token.' });
  }
  const { pifId, productName, productNameEn, companyName, ownerId, pif01 } = req.body;
  if (!pifId || !productName || !companyName) {
    return res.status(400).json({ success: false, error: 'Missing required project data: pifId, productName, companyName.' });
  }
  if (ownerId !== decodedToken.uid) {
    return res.status(403).json({ success: false, error: 'Forbidden: ownerId does not match authenticated user.' });
  }
  try {
    const pifRef = db.collection('pifs').doc(pifId);
    await pifRef.set({
      pifId, productName, productNameEn, companyName,
      createdAt: new Date().toISOString(),
      ownerId, pif01,
      pif02: { status: 'pending' }, pif03: { status: 'pending' },
      pif04: { status: 'pending' }, pif05: { status: 'pending' },
      pif06: { status: 'pending' }, pif07: { status: 'pending' },
      pif08: { status: 'pending' }, pif09: { status: 'pending' },
      pif10: { status: 'pending' }, pif11: { status: 'pending' },
      pif12: { status: 'pending' }, pif13: { status: 'pending' },
      pif14: { status: 'pending' }, pif15: { status: 'pending' },
      pif16: { status: 'pending' }, pif16sa: { status: 'pending' },
    });
    return res.status(200).json({ success: true, pifId });
  } catch (error) {
    console.error("Error creating PIF project document:", error);
    return res.status(500).json({ success: false, error: 'An internal error occurred while creating the project document.' });
  }
});
exports.createPifProject = functions.region("asia-east1").https.onRequest(createPifApp);

const adminFunctionsRegion = "asia-east1";

const ensureAdmin = (context) => {
  if (!context.auth || !context.auth.token.admin) {
    throw new functions.https.HttpsError('permission-denied', 'This function must be called by an administrator.');
  }
};

// --- Roles: Sync custom claims -> Firestore users/{uid} (for console visibility / reporting) ---
const _rolePayload = (role) => {
  if (role === "admin") return { role: "admin", roles: { admin: true, client: false, user: false } };
  if (role === "client") return { role: "client", roles: { admin: false, client: true, user: false } };
  return { role: "user", roles: { admin: false, client: false, user: true } };
};

const _syncRoleToFirestore = async (uid, role) => {
  const payload = _rolePayload(role);
  await db.collection("users").doc(uid).set(
    {
      ...payload,
      roleUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
};
// --- END Roles Sync ---

// --- Role change notification (email to affected user) ---
function _effectiveRoleFromClaims(claims = {}) {
  const c = claims || {};
  const roles = (c.roles && typeof c.roles === "object") ? c.roles : {};
  // 僅判斷這三種「主角色」：admin / client / user
  if (c.admin || roles.admin) return "admin";
  if (c.client || roles.client) return "client";
  if (c.user || roles.user) return "user";
  return "";
}

function _roleLabel(role) {
  if (role === "admin") return "管理者 (admin)";
  if (role === "client") return "委託/客戶 (client)";
  if (role === "user") return "一般使用者 (user)";
  return role ? String(role) : "（未指定）";
}

async function _queueRoleChangedEmail({ targetEmail, targetName, prevRole, nextRole, changedByUid }) {
  const to = (targetEmail || "").toString().trim();
  if (!to) return false;

  // 若沒有真正變更，就不寄
  if ((prevRole || "") === (nextRole || "")) return false;

  let changedByText = "";
  try {
    if (changedByUid) {
      const changer = await admin.auth().getUser(changedByUid);
      const changerEmail = (changer.email || "").toString().trim();
      const changerName = (changer.displayName || "").toString().trim();
      if (changerEmail || changerName) {
        changedByText = `${changerName ? changerName + " " : ""}${changerEmail ? "<" + changerEmail + ">" : ""}`.trim();
      }
    }
  } catch (e) {
    // ignore
  }

  const loginUrl = `${APP_BASE_URL}/login.html`;
  const name = (targetName || "").toString().trim();

  const html = `
    <p>${name ? `${_escapeHtml(name)} 您好，` : "您好，"}</p>
    <p>您的 CosPIF 帳號權限（角色）已更新。</p>
    <ul>
      ${prevRole ? `<li><strong>原角色：</strong> ${_escapeHtml(_roleLabel(prevRole))}</li>` : ""}
      <li><strong>新角色：</strong> ${_escapeHtml(_roleLabel(nextRole))}</li>
      ${changedByText ? `<li><strong>變更者：</strong> ${_escapeHtml(changedByText)}</li>` : ""}
    </ul>
    <p style="margin-top:12px;">若您登入後仍未看到新的功能/權限，請先<strong>登出再登入</strong>（刷新權限 token）。</p>
    <p style="margin-top:16px;">
      <a href="${loginUrl}" style="display:inline-block;padding:10px 14px;border-radius:10px;background:#0ea5e9;color:#fff;text-decoration:none;">
        前往登入頁
      </a>
    </p>
    <p style="color:#666;font-size:13px;">（若按鈕無法點擊，請複製此連結至瀏覽器：${_escapeHtml(loginUrl)}）</p>
    <p>CosPIF 智慧科技整合系統</p>
  `;

  await enqueueMail(to, "【CosPIF】帳號角色/權限已更新通知", html, {
    type: "user_role_changed",
    prevRole: prevRole || null,
    nextRole: nextRole || null,
    changedByUid: changedByUid || null
  });

  return true;
}

// --- END Role change notification ---



exports.listUsersWithClaims = functions.region(adminFunctionsRegion).https.onCall(async (data, context) => {
    ensureAdmin(context);
    try {
        const listUsersResult = await admin.auth().listUsers(1000);
        const firestoreUsersSnap = await db.collection('users').get();
        const firestoreUsers = {};
        firestoreUsersSnap.forEach(doc => {
            firestoreUsers[doc.id] = doc.data();
        });
        const combinedUsers = listUsersResult.users.map(userRecord => ({
            id: userRecord.uid,
            email: userRecord.email,
            claims: userRecord.customClaims || {},
            ...(firestoreUsers[userRecord.uid] || {})
        }));
        return { success: true, users: combinedUsers };
    } catch (error) {
        console.error("Error listing users with claims:", error);
        throw new functions.https.HttpsError('internal', 'Failed to list users.');
    }
});

exports.updateAdminSettings = functions.region(adminFunctionsRegion).https.onCall(async (data, context) => {
  ensureAdmin(context);
  const { emails } = data;
  if (!Array.isArray(emails)) {
    throw new functions.https.HttpsError('invalid-argument', 'The function must be called with an "emails" array.');
  }
  try {
    const settingsRef = db.collection("settings").doc("admin");
    await settingsRef.set({ notificationEmails: emails }, { merge: true });
    return { success: true, message: "Settings updated successfully." };
  } catch (error) {
    console.error("Error updating admin settings:", error);
    throw new functions.https.HttpsError('internal', 'Failed to update settings.');
  }
});


// --- Admin: QA Chat Settings (settings/qaChat) ---
exports.getQaChatSettings = functions.region(adminFunctionsRegion).https.onCall(async (data, context) => {
  ensureAdmin(context);
  try {
    const doc = await db.doc(QA_CHAT_SETTINGS_DOC_PATH).get();
    return { success: true, settings: doc.exists ? (doc.data() || {}) : {} };
  } catch (e) {
    console.error("getQaChatSettings error:", e);
    throw new functions.https.HttpsError("internal", "Failed to read settings/qaChat.");
  }
});

exports.updateQaChatSettings = functions.region(adminFunctionsRegion).https.onCall(async (data, context) => {
  ensureAdmin(context);

  const incoming = (data && typeof data === "object") ? data : {};
  // 用 sanitize 來把資料收斂到安全範圍
  const safe = _sanitizeQaChatOptions(incoming, {});

  try {
    await db.doc(QA_CHAT_SETTINGS_DOC_PATH).set(safe, { merge: true });
    // 更新記憶體快取（避免要等 TTL）
    _qaChatSettingsCache = safe;
    _qaChatSettingsCacheAt = Date.now();
    return { success: true, settings: safe };
  } catch (e) {
    console.error("updateQaChatSettings error:", e);
    throw new functions.https.HttpsError("internal", "Failed to update settings/qaChat.");
  }
});


exports.grantAdminRole = functions.region(adminFunctionsRegion).https.onCall(async (data, context) => {
  ensureAdmin(context);
  const { uid } = data;
  if (!uid) {
    throw new functions.https.HttpsError('invalid-argument', 'The function must be called with a "uid".');
  }
  try {
    const user = await admin.auth().getUser(uid);
    const prevRole = _effectiveRoleFromClaims(user.customClaims || {});
    const prev = user.customClaims || {};
    const next = { ...prev, admin: true, client: false, user: false };
    await admin.auth().setCustomUserClaims(uid, next);

    // 同步寫入 Firestore（方便在集合中看到角色）
    await _syncRoleToFirestore(uid, "admin");

    // 通知被變更者（角色真正改變時才寄）
    await _queueRoleChangedEmail({
      targetEmail: user.email,
      targetName: user.displayName,
      prevRole,
      nextRole: "admin",
      changedByUid: context.auth ? context.auth.uid : null,
    });

    return { success: true, message: `Admin role granted to user ${uid}.` };
  } catch (error) {
    console.error(`Error granting admin role to user ${uid}:`, error);
    throw new functions.https.HttpsError('internal', `Failed to grant admin role. Reason: ${error.message}`);
  }
});

exports.setClientRole = functions.region(adminFunctionsRegion).https.onCall(async (data, context) => {
  ensureAdmin(context);
  const { uid } = data;
  if (!uid) {
    throw new functions.https.HttpsError('invalid-argument', 'The function must be called with a "uid".');
  }
  try {
    const user = await admin.auth().getUser(uid);
    const prevRole = _effectiveRoleFromClaims(user.customClaims || {});
    const prev = user.customClaims || {};
    const next = { ...prev, client: true, admin: false, user: false };
    await admin.auth().setCustomUserClaims(uid, next);

    // 同步寫入 Firestore（方便在集合中看到角色）
    await _syncRoleToFirestore(uid, "client");

    // 通知被變更者（角色真正改變時才寄）
    await _queueRoleChangedEmail({
      targetEmail: user.email,
      targetName: user.displayName,
      prevRole,
      nextRole: "client",
      changedByUid: context.auth ? context.auth.uid : null,
    });

    return { success: true, message: `Client role granted to user ${uid}.` };
  } catch (error) {
    console.error(`Error granting client role to user ${uid}:`, error);
    throw new functions.https.HttpsError('internal', `Failed to grant client role. Reason: ${error.message}`);
  }
});

exports.setUserRole = functions.region(adminFunctionsRegion).https.onCall(async (data, context) => {
  ensureAdmin(context);
  const { uid } = data;
  if (!uid) {
    throw new functions.https.HttpsError('invalid-argument', 'The function must be called with a "uid".');
  }
  try {
    const user = await admin.auth().getUser(uid);
    const prevRole = _effectiveRoleFromClaims(user.customClaims || {});
    const prev = user.customClaims || {};
    // Set as general user and clear elevated roles to avoid forced redirects
    const next = { ...prev, user: true, client: false, admin: false, systemAdmin: false, secretary: false };
    await admin.auth().setCustomUserClaims(uid, next);

    // 同步寫入 Firestore（方便在集合中看到角色）
    await _syncRoleToFirestore(uid, "user");

    // 通知被變更者（角色真正改變時才寄）
    await _queueRoleChangedEmail({
      targetEmail: user.email,
      targetName: user.displayName,
      prevRole,
      nextRole: "user",
      changedByUid: context.auth ? context.auth.uid : null,
    });

    return { success: true, message: `User role granted to user ${uid}.` };
  } catch (error) {
    console.error(`Error granting user role to user ${uid}:`, error);
    throw new functions.https.HttpsError('internal', `Failed to grant user role. Reason: ${error.message}`);
  }
});


exports.setUserStatus = functions.region(adminFunctionsRegion).https.onCall(async (data, context) => {
  ensureAdmin(context);
  const { uid, newStatus } = data;
  if (!uid || !newStatus) {
    throw new functions.https.HttpsError('invalid-argument', 'The function must be called with "uid" and "newStatus".');
  }
  try {
    const user = await admin.auth().getUser(uid);
    await admin.auth().setCustomUserClaims(uid, { ...user.customClaims, status: newStatus });
    const userRef = db.collection("users").doc(uid);
    const userDoc = await userRef.get();
    if (!userDoc.exists) {
        throw new functions.https.HttpsError('not-found', 'User document not found in Firestore.');
    }
    const updateData = { status: newStatus };
    if (newStatus === 'active' && !userDoc.data().expires) {
        const expires = new Date();
        expires.setDate(expires.getDate() + 180);
        updateData.expires = admin.firestore.Timestamp.fromDate(expires);
    }
    await userRef.update(updateData);
    return { success: true, message: `User ${uid} status updated to ${newStatus}.` };
  } catch (error) {
    console.error(`Error updating status for user ${uid}:`, error);
    throw new functions.https.HttpsError('internal', `Failed to update user status. Reason: ${error.message}`);
  }
});

exports.extendMembership = functions.region(adminFunctionsRegion).https.onCall(async (data, context) => {
  ensureAdmin(context);
  const { uid } = data;
  if (!uid) {
    throw new functions.https.HttpsError('invalid-argument', 'The function must be called with a "uid".');
  }
  try {
    const userRef = db.collection("users").doc(uid);
    const userDoc = await userRef.get();
    if (!userDoc.exists) {
      throw new functions.https.HttpsError('not-found', 'User not found.');
    }
    const currentExpiry = userDoc.data().expires ? userDoc.data().expires.toDate() : new Date();
    const now = new Date();
    const baseDate = currentExpiry > now ? currentExpiry : now;
    const newExpiryDate = new Date(baseDate);
    newExpiryDate.setDate(newExpiryDate.getDate() + 180);
    await userRef.update({
      expires: admin.firestore.Timestamp.fromDate(newExpiryDate),
      status: 'active'
    });
    return { success: true, message: `Membership for user ${uid} extended.` };
  } catch (error) {
    console.error(`Error extending membership for user ${uid}:`, error);
    throw new functions.https.HttpsError('internal', 'Failed to extend membership.');
  }
});

// --- Mail Helper: enqueue email to Firestore mail queue (sent by processMailQueue) ---
async function enqueueMail(to, subject, html, extra = {}) {
  const recipients = Array.isArray(to) ? to : [to];
  const clean = recipients.map(x => (x || "").toString().trim()).filter(Boolean);
  if (clean.length === 0) return false;

  await db.collection("mail").add({
    to: clean.length === 1 ? clean[0] : clean,
    message: { subject, html },
    ...extra,
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  });
  return true;
}

const APP_BASE_URL = (function () {
  try {
    const cfg = (typeof functions.config === "function") ? functions.config() : {};
    const u = (cfg?.app?.base_url || "").toString().trim();
    return u || "https://cos-pif.web.app";
  } catch (e) {
    return "https://cos-pif.web.app";
  }
})();

exports.sendNewUserNotification = functions.region("asia-east1").firestore
    .document('users/{userId}')
    .onCreate(async (snap, context) => {
        const newUser = snap.data() || {};
        const userEmail = (newUser.email || "").toString().trim();
        const userName = (newUser.name || "您好").toString().trim();
        const companyName = (newUser.company || "").toString().trim();

        // 1) 通知管理員（若有設定）
        try {
            const settingsDoc = await db.collection("settings").doc("admin").get();
            const adminEmails = settingsDoc.exists ? (settingsDoc.data().notificationEmails || []) : [];
            if (Array.isArray(adminEmails) && adminEmails.length > 0) {
                const html = `
                  <p>您好，</p>
                  <p>系統有新的用戶註冊，正在等待審核。以下是詳細資訊：</p>
                  <ul>
                    <li><strong>姓名:</strong> ${userName || "（未提供）"}</li>
                    <li><strong>公司:</strong> ${companyName || "（未提供）"}</li>
                    <li><strong>Email:</strong> ${userEmail || "（未提供）"}</li>
                  </ul>
                  <p>請盡快登入管理後台進行審核。</p>
                  <p>CosPIF 智慧科技整合系統</p>
                `;
                await enqueueMail(adminEmails, '【CosPIF】新用戶註冊通知', html, { type: "admin_new_user", userId: context.params.userId });
                console.log(`New user admin notification queued: ${adminEmails.join(", ")}`);
            } else {
                console.log("No admin notification emails configured; skip admin notification.");
            }
        } catch (e) {
            console.error("Error queueing admin new user notification:", e);
        }

        // 2) 通知新註冊用戶：「感謝註冊，帳號審核中」
        try {
            if (!userEmail) {
                console.log("New user email is empty; skip user confirmation email.");
                return;
            }

            const loginUrl = `${APP_BASE_URL}/login.html`;
            const html = `
              <p>${userName} 您好，</p>
              <p>感謝您註冊 CosPIF 系統！我們已收到您的申請，帳號目前處於 <strong>審核中</strong> 狀態。</p>
              <p>審核完成後，系統將再寄出「審核通過通知信」給您，屆時您即可登入開始使用。</p>
              <p>若您需補充資料或有任何問題，歡迎直接回覆此信或聯繫客服團隊。</p>
              <p style="margin-top:16px;">
                <a href="${loginUrl}" style="display:inline-block;padding:10px 16px;border-radius:10px;background:#f02c8c;color:#fff;text-decoration:none;">
                  前往登入頁（審核通過後）
                </a>
              </p>
              <p style="color:#666;font-size:13px;">（若按鈕無法點擊，請複製此連結至瀏覽器：${loginUrl}）</p>
              <p>CosPIF 智慧科技整合系統</p>
            `;

            await enqueueMail(userEmail, '【CosPIF】感謝註冊，帳號審核中', html, { type: "user_registration_received", userId: context.params.userId });
            console.log(`New user confirmation queued to: ${userEmail}`);
        } catch (e) {
            console.error("Error queueing new user confirmation email:", e);
        }
    });


// 當使用者狀態由非 active 轉為 active 時，寄送「審核通過」通知給註冊本人（避免重複寄送）
exports.sendUserApprovalEmail = functions.region("asia-east1").firestore
  .document('users/{userId}')
  .onUpdate(async (change, context) => {
    const before = change.before.data() || {};
    const after = change.after.data() || {};

    const beforeStatus = (before.status || "").toString();
    const afterStatus = (after.status || "").toString();

    // 僅在「狀態變為 active」時發信
    if (beforeStatus === afterStatus || afterStatus !== "active" || beforeStatus === "active") return;

    // 防止重複寄送（例如後續欄位更新）
    if (after.approvalEmailSentAt) return;

    const userEmail = (after.email || "").toString().trim();
    const userName = (after.name || "您好").toString().trim();
    if (!userEmail) return;

    const loginUrl = `${APP_BASE_URL}/login.html`;

    const html = `
      <p>${userName} 您好，</p>
      <p>您的 CosPIF 帳號已 <strong>審核通過</strong>，現在可以登入使用系統了。</p>
      <p style="margin-top:16px;">
        <a href="${loginUrl}" style="display:inline-block;padding:10px 16px;border-radius:10px;background:#2563eb;color:#fff;text-decoration:none;">
          立即登入 CosPIF
        </a>
      </p>
      <p style="color:#666;font-size:13px;">（若按鈕無法點擊，請複製此連結至瀏覽器：${loginUrl}）</p>
      <p>如有任何問題，歡迎聯繫客服團隊。</p>
      <p>CosPIF 智慧科技整合系統</p>
    `;

    try {
      await enqueueMail(userEmail, '【CosPIF】帳號審核通過通知', html, { type: "user_approved", userId: context.params.userId });
      await change.after.ref.update({ approvalEmailSentAt: admin.firestore.FieldValue.serverTimestamp() });
      console.log(`Approval email queued to: ${userEmail}`);
    } catch (e) {
      console.error("Error queueing approval email:", e);
    }
  });




exports.processMailQueue = functions.runWith({ secrets: [MAIL_FROM_GMAIL, MAIL_APP_PASSWORD] }).region('asia-east1').firestore
    .document('mail/{mailId}')
    .onCreate(async (snap, context) => {
        const mailData = snap.data() || {};
        const toRaw = mailData.to;
        const subject = (mailData && mailData.message && mailData.message.subject) ? String(mailData.message.subject) : "";
        const html = (mailData && mailData.message && mailData.message.html) ? String(mailData.message.html) : "";

        const toList = Array.isArray(toRaw) ? toRaw : (toRaw ? [toRaw] : []);
        const to = toList.map(x => (x || "").toString().trim()).filter(Boolean);
        if (to.length === 0) {
            console.error("Mail queue item has empty recipient(s).");
            return snap.ref.update({ status: 'error', errorMessage: 'Recipient is empty.' });
        }

        try {
            const transporter = await _getGmailTransporter();
            const cfg = _getGmailConfig();

            const fromEmail = (cfg.fromEmail || cfg.user || "").toString().trim();
            if (!fromEmail) {
                console.error("CRITICAL: Gmail sender is not configured (gmail.from_email or gmail.user). Email not sent.");
                return snap.ref.update({ status: 'error', errorMessage: 'Gmail sender not configured.' });
            }

            const fromName = (cfg.fromName || "").toString().trim();
            const from = fromName ? `"${fromName.replace(/"/g, '')}" <${fromEmail}>` : fromEmail;

            await transporter.sendMail({
                from,
                to: to.join(", "),
                subject,
                html,
            });

            console.log(`Email sent successfully via Gmail to ${to.join(", ")} with subject "${subject}"`);
            return snap.ref.delete();

        } catch (error) {
            console.error('Error sending email via Gmail:', error);
            return snap.ref.update({ status: 'error', errorMessage: (error && error.message) ? error.message : String(error) });
        }
    });


// ================================
// KB Magazine: Notify Subscribers
// ================================

const ensureKbAdmin = (context) => {
  const token = (context && context.auth && context.auth.token) ? context.auth.token : {};
  const roles = (token.roles && typeof token.roles === "object") ? token.roles : {};
  const ok = !!(token.admin || roles.admin || token.systemAdmin || roles.systemAdmin || token.secretary || roles.secretary || token.editor || roles.editor);
  if (!context.auth || !ok) {
    throw new functions.https.HttpsError("permission-denied", "需要管理員/編輯權限才能發送刊物通知。");
  }
};

const _escapeHtml = (s) => String(s || "").replace(/[&<>"']/g, (c) => ({
  "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"
}[c]));

const _nl2br = (s) => _escapeHtml(s).replace(/\r?\n/g, "<br>");


// ================================
// KB Review: notify admins when a reviewer submits a review
// ================================

exports.notifyKbReviewSubmitted = functions.region("asia-east1").https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError("unauthenticated", "請先登入");
  }

  const uid = context.auth.uid;
  const token = (context.auth && context.auth.token) ? context.auth.token : {};
  const roles = (token.roles && typeof token.roles === "object") ? token.roles : {};
  const isAdmin = !!(token.admin || roles.admin || token.systemAdmin || roles.systemAdmin || token.secretary || roles.secretary || token.editor || roles.editor);

  const submissionId = (data?.submissionId || data?.id || "").toString().trim();
  if (!submissionId) {
    throw new functions.https.HttpsError("invalid-argument", '缺少 submissionId');
  }

  const subRef = db.collection("kb_submissions").doc(submissionId);
  const subSnap = await subRef.get();
  if (!subSnap.exists) {
    throw new functions.https.HttpsError("not-found", "找不到投稿資料");
  }
  const sub = subSnap.data() || {};

  const assigned = sub.assignedReviewerUids || sub.assignedReviewers || sub.assignedReviewerIds || [];
  const isAssigned = Array.isArray(assigned) && assigned.includes(uid);
  if (!isAdmin && !isAssigned) {
    throw new functions.https.HttpsError("permission-denied", "你不是此稿件的審稿人，無法送出通知");
  }

  // 取得管理員通知信箱（沿用 settings/admin.notificationEmails）
  let adminEmails = [];
  try {
    const settingsDoc = await db.collection("settings").doc("admin").get();
    const d = settingsDoc.exists ? (settingsDoc.data() || {}) : {};
    const arr = d.notificationEmails || d.adminEmails || d.emails || [];
    if (Array.isArray(arr)) adminEmails = arr;
  } catch (e) {
    console.error("notifyKbReviewSubmitted: failed to load settings/admin", e);
  }

  // 後備：functions config kb.admin_emails="a@x.com,b@y.com"
  if (!adminEmails.length) {
    try {
      const cfg = (typeof functions.config === "function") ? functions.config() : {};
      const raw = (cfg?.kb?.admin_emails || cfg?.kb?.admins || "").toString();
      adminEmails = raw.split(/[,\s]+/).map(s => s.trim()).filter(Boolean);
    } catch (e) {}
  }

  adminEmails = [...new Set((adminEmails || []).map(x => (x || "").toString().trim()).filter(Boolean))];
  if (!adminEmails.length) {
    console.warn("notifyKbReviewSubmitted: no admin emails configured (settings/admin.notificationEmails or functions config kb.admin_emails).");
    return { ok: false, reason: "no_admin_emails" };
  }

  const title = (sub.title || sub.topic || sub.subject || "").toString().trim() || submissionId;
  const author = (sub.author || sub.authorName || sub.name || sub.submitterName || "").toString().trim();
  const authorEmail = (sub.authorEmail || sub.email || sub.submitterEmail || "").toString().trim();

  const score = (data && data.score != null) ? data.score : null;
  const rec = (data && data.rec != null) ? String(data.rec) : "";
  const comments = (data && data.comments != null) ? String(data.comments) : "";

  const reviewerId = (token.email || uid).toString();
  const reviewUrl = `${APP_BASE_URL}/kb-review.html?sid=${encodeURIComponent(submissionId)}`;

  const subject = `【CosPIF KB】審稿已送出：${title}`;

  const html = `
    <p>管理員您好，</p>
    <p>有一筆投稿已送出審稿意見：</p>
    <ul>
      <li><strong>投稿ID：</strong> <span style="font-family:ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono','Courier New', monospace;">${_escapeHtml(submissionId)}</span></li>
      <li><strong>題目：</strong> ${_escapeHtml(title)}</li>
      ${author ? `<li><strong>作者：</strong> ${_escapeHtml(author)}</li>` : ``}
      ${authorEmail ? `<li><strong>作者Email：</strong> ${_escapeHtml(authorEmail)}</li>` : ``}
      <li><strong>審稿人：</strong> ${_escapeHtml(reviewerId)}</li>
      ${rec ? `<li><strong>建議：</strong> ${_escapeHtml(rec)}</li>` : ``}
      ${(score !== null && score !== undefined && score !== "") ? `<li><strong>分數：</strong> ${_escapeHtml(score)}</li>` : ``}
    </ul>

    <p><strong>評語：</strong></p>
    <div style="white-space:pre-wrap;border:1px solid #e5e7eb;padding:12px;border-radius:10px;background:#f9fafb;">${_nl2br(comments || "(未填)")}</div>

    <p style="margin-top:16px;">
      <a href="${reviewUrl}" style="display:inline-block;padding:10px 16px;border-radius:10px;background:#2563eb;color:#fff;text-decoration:none;">
        開啟審稿頁
      </a>
    </p>
    <p style="color:#666;font-size:13px;">（若按鈕無法點擊，請複製此連結：${_escapeHtml(reviewUrl)}）</p>
    <p>CosPIF KB 系統</p>
  `;

  await enqueueMail(adminEmails, subject, html, {
    type: "kb_review_submitted",
    submissionId,
    reviewerUid: uid
  });

  return { ok: true, to: adminEmails.length };
});

exports.enqueueKbIssueNotification = functions.region("asia-east1").https.onCall(async (data, context) => {
  ensureKbAdmin(context);

  const issueId = (data && data.issueId ? String(data.issueId) : "").trim();
  if (!issueId) throw new functions.https.HttpsError("invalid-argument", "issueId is required.");

  const mode = (data && data.mode ? String(data.mode) : "all").trim(); // all | test
  const force = !!(data && data.force);

  const token = (context && context.auth && context.auth.token) ? context.auth.token : {};
  const callerEmail = String(token.email || "").trim();

  const projectId = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || "";
  const publicBaseUrl = (data && data.publicBaseUrl ? String(data.publicBaseUrl) : "").trim()
    || (projectId ? `https://${projectId}.web.app` : "");

  if (!publicBaseUrl) {
    throw new functions.https.HttpsError("failed-precondition", "Cannot determine publicBaseUrl. Please provide it from client.");
  }

  const issueRef = db.collection("kb_issues").doc(issueId);
  const issueSnap = await issueRef.get();
  if (!issueSnap.exists) throw new functions.https.HttpsError("not-found", "Issue not found.");

  const issue = issueSnap.data() || {};
  const status = String(issue.status || "").trim();

  if (mode === "all" && status !== "published") {
    throw new functions.https.HttpsError("failed-precondition", "此刊物尚未 published，不能群發通知。");
  }

  if (mode === "all" && issue.notifiedAt && !force) {
    throw new functions.https.HttpsError("failed-precondition", "此刊物已通知過訂閱者；如需重寄請勾選『強制重寄』。");
  }

  const issueTitle = String(issue.title || issueId);
  const freq = String(issue.frequency || "monthly");
  const issueUrl = `${publicBaseUrl}/kb-issue.html?issue=${encodeURIComponent(issueId)}`;

  const subject = (data && data.subject ? String(data.subject) : "").trim()
    || `【CosPIF 化妝品知識${freq === "weekly" ? "週刊" : "月刊"}】${issueTitle}`;

  const coverImg = String(issue.coverImageUrl || "").trim();
  const coverSummary = String(issue.coverSummary || "").trim();
  const publishDate = String(issue.publishDate || "").trim();

  const items = Array.isArray(issue.items) ? issue.items : [];
  const itemsHtml = items.slice(0, 30).map((it) => {
    const slug = String(it.slug || "").trim();
    const t = _escapeHtml(it.title || slug || "");
    const topic = _escapeHtml(it.topic || "");
    const url = slug ? `${issueUrl}&slug=${encodeURIComponent(slug)}` : issueUrl;
    return `<li style="margin:6px 0;">
      <a href="${url}" target="_blank" rel="noopener" style="color:#1a73e8; text-decoration:none;">${t}</a>
      ${topic ? `<span style="color:#666;">（${topic}）</span>` : ``}
    </li>`;
  }).join("");

  const html = `
  <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Noto Sans TC','PingFang TC','Microsoft JhengHei',Arial,sans-serif; color:#222; line-height:1.6;">
    <div style="max-width:720px; margin:0 auto; padding:18px;">
      <div style="font-weight:800; font-size:18px; margin-bottom:8px;">${_escapeHtml(issueTitle)}</div>
      <div style="color:#666; font-size:13px; margin-bottom:12px;">${publishDate ? _escapeHtml(publishDate) + " ・ " : ""}${freq === "weekly" ? "週刊" : "月刊"}</div>

      ${coverImg ? `<div style="margin:10px 0 14px;"><img src="${_escapeHtml(coverImg)}" alt="cover" style="width:100%; max-width:720px; border-radius:12px; display:block;"></div>` : ""}

      ${coverSummary ? `<div style="background:#f6f7fb; border:1px solid #e7e7ef; padding:12px 14px; border-radius:12px; margin:0 0 14px;">${_nl2br(coverSummary)}</div>` : ""}

      <div style="margin:8px 0 10px;">
        <a href="${issueUrl}" target="_blank" rel="noopener"
           style="display:inline-block; background:#ff2d8d; color:white; padding:10px 14px; border-radius:999px; text-decoration:none; font-weight:700;">
          立即閱讀本期刊物 →
        </a>
      </div>

      ${itemsHtml ? `
        <div style="margin-top:14px; font-weight:800;">本期精選</div>
        <ul style="padding-left:18px; margin:8px 0 0;">${itemsHtml}</ul>
      ` : ""}

      <div style="margin-top:18px; color:#999; font-size:12px;">
        你收到這封信是因為你訂閱了 CosPIF 化妝品知識刊物。若不想再收到通知，請點此 <a href="__UNSUB_LINK__" target="_blank" rel="noopener" style="color:#1a73e8;">取消訂閱</a>。
      </div>
    </div>
  </div>`;

  // enqueue a mail document for Firestore trigger: mail/{mailId}
  const mailCol = db.collection("mail");

  if (mode === "test") {
    const testEmail = (data && data.testEmail ? String(data.testEmail) : "").trim() || callerEmail;
    if (!testEmail) throw new functions.https.HttpsError("invalid-argument", "testEmail is required for test mode.");

    // 產生一個可點擊的取消訂閱連結（token 30 天有效）
    const unsubToken = crypto.randomBytes(18).toString("hex");
    const unsubExpAt = admin.firestore.Timestamp.fromDate(new Date(Date.now() + 30 * 24 * 60 * 60 * 1000));
    await db.collection("kb_unsub_tokens").doc(unsubToken).set({
      email: String(testEmail).trim().toLowerCase(),
      issueId,
      purpose: "kb_issue_unsub",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      expAt: unsubExpAt,
      usedAt: null,
    });

    const unsubLink = `${publicBaseUrl}/unsubscribe.html?token=${encodeURIComponent(unsubToken)}`;
    const htmlPersonal = String(html).replace(/__UNSUB_LINK__/g, unsubLink);

    await mailCol.add({
      to: testEmail,
      message: { subject: `[測試] ${subject}`, html: htmlPersonal },
      kind: "kb_issue_notify_test",
      issueId,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return { ok: true, mode: "test", queued: 1, testEmail };
  }

  // all subscribers
  const freqKey = (freq === "weekly" ? "weekly" : "monthly");
  const subsSnap = await db.collection("kb_subscribers")
    .where("status", "==", "active")
    .where("frequency", "==", freqKey)
    .get();

  const emails = [];
  subsSnap.forEach((doc) => {
    const d = doc.data() || {};
    const em = String(d.email || "").trim().toLowerCase();
    if (em) emails.push(em);
  });

  const unique = Array.from(new Set(emails));
  if (unique.length === 0) {
    return { ok: true, mode: "all", queued: 0, message: "no active subscribers" };
  }

  // Firestore batch limit: 500 writes. Keep margin.
  let queued = 0;
  const chunkSize = 200; // 200 emails + 200 unsubscribe tokens = 400 writes (safe under 500)
  for (let i = 0; i < unique.length; i += chunkSize) {
    const part = unique.slice(i, i + chunkSize);
    const batch = db.batch();
    part.forEach((email, j) => {
      const h = crypto.createHash("sha1").update(email).digest("hex").slice(0, 10);
      const docId = `kbIssue_${issueId}_${Date.now()}_${i}_${j}_${h}`;

      // 產生取消訂閱 token（30 天有效），避免使用者必須手打 email
      const unsubToken = crypto.randomBytes(18).toString("hex");
      const unsubExpAt = admin.firestore.Timestamp.fromDate(new Date(Date.now() + 30 * 24 * 60 * 60 * 1000));
      batch.set(db.collection("kb_unsub_tokens").doc(unsubToken), {
        email,
        issueId,
        purpose: "kb_issue_unsub",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        expAt: unsubExpAt,
        usedAt: null,
      });

      const unsubLink = `${publicBaseUrl}/unsubscribe.html?token=${encodeURIComponent(unsubToken)}`;
      const htmlPersonal = String(html).replace(/__UNSUB_LINK__/g, unsubLink);

      batch.set(mailCol.doc(docId), {
        to: email,
        message: { subject, html: htmlPersonal },
        kind: "kb_issue_notify",
        issueId,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });
    await batch.commit();
    queued += part.length;
  }

  await issueRef.set({
    notifiedAt: admin.firestore.FieldValue.serverTimestamp(),
    notifiedCount: queued,
    notifiedBy: callerEmail || null
  }, { merge: true });

  return { ok: true, mode: "all", queued };
});

// -----------------------------------------------------------------------------
// KB 訂閱取消（公開頁面使用）：unsubscribe.html 會呼叫這兩個 Callable
// - requestKbUnsubscribe(email, publicBaseUrl?): 寄出「取消訂閱確認信」
// - confirmKbUnsubscribe(token): 使用 token 取消訂閱（不需登入）
// -----------------------------------------------------------------------------
function _isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || "").trim());
}

exports.requestKbUnsubscribe = functions.region("asia-east1").https.onCall(async (data, context) => {
  const email = (data && data.email ? String(data.email) : "").trim().toLowerCase();
  if (!_isValidEmail(email)) throw new functions.https.HttpsError("invalid-argument", "email is invalid.");

  const projectId = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || "";
  const publicBaseUrl = (data && data.publicBaseUrl ? String(data.publicBaseUrl) : "").trim()
    || (projectId ? `https://${projectId}.web.app` : "");

  const token = crypto.randomBytes(18).toString("hex");
  const expAt = admin.firestore.Timestamp.fromDate(new Date(Date.now() + 48 * 60 * 60 * 1000)); // 48h

  await db.collection("kb_unsub_tokens").doc(token).set({
    email,
    purpose: "kb_manual_unsub",
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    expAt,
    usedAt: null,
  });

  const link = `${publicBaseUrl}/unsubscribe.html?token=${encodeURIComponent(token)}`;
  const subject = "【CosPIF】取消訂閱確認";
  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Noto Sans TC','Microsoft JhengHei',Arial,sans-serif; line-height:1.7; color:#222;">
      <div style="max-width:640px; margin:0 auto; padding:18px;">
        <div style="font-weight:800; font-size:18px; margin-bottom:8px;">取消訂閱確認</div>
        <div style="color:#555; font-size:14px; margin-bottom:14px;">
          你收到這封信是因為系統收到「取消訂閱」請求（${_escapeHtml(email)}）。
          若確定要取消訂閱，請在 48 小時內點擊下方按鈕：
        </div>
        <div style="margin:10px 0 18px;">
          <a href="${link}" target="_blank" rel="noopener"
             style="display:inline-block; background:#111827; color:#fff; padding:10px 14px; border-radius:999px; text-decoration:none; font-weight:700;">
            確認取消訂閱 →
          </a>
        </div>
        <div style="color:#999; font-size:12px;">
          若你沒有提出此要求，請忽略本信件。
        </div>
      </div>
    </div>
  `;

  await db.collection("mail").add({
    to: email,
    message: { subject, html },
    kind: "kb_unsub_confirm",
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  return { ok: true };
});

exports.confirmKbUnsubscribe = functions.region("asia-east1").https.onCall(async (data, context) => {
  const token = (data && data.token ? String(data.token) : "").trim();
  if (!token) throw new functions.https.HttpsError("invalid-argument", "token is required.");

  const tokenRef = db.collection("kb_unsub_tokens").doc(token);

  let email = "";
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(tokenRef);
    if (!snap.exists) throw new functions.https.HttpsError("not-found", "token not found.");

    const d = snap.data() || {};
    if (d.usedAt) throw new functions.https.HttpsError("failed-precondition", "token already used.");

    const expAt = d.expAt;
    if (expAt && expAt.toMillis && expAt.toMillis() < Date.now()) {
      throw new functions.https.HttpsError("failed-precondition", "token expired.");
    }

    email = String(d.email || "").trim().toLowerCase();
    if (!_isValidEmail(email)) throw new functions.https.HttpsError("failed-precondition", "invalid email in token.");

    // 將訂閱狀態改為 unsubscribed（若同一 email 有多筆，全部更新）
    const q = db.collection("kb_subscribers").where("email", "==", email).limit(50);
    const qSnap = await tx.get(q);
    qSnap.forEach((doc) => {
      tx.set(doc.ref, {
        status: "unsubscribed",
        unsubscribedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
    });

    tx.set(tokenRef, {
      usedAt: admin.firestore.FieldValue.serverTimestamp(),
      usedEmail: email,
    }, { merge: true });
  });

  return { ok: true, email };
});

