// backend/http-functions.js  (LIVE — CLEAN, DIFF-SKIP + FORCE UPDATE)
import { ok, created, badRequest, serverError } from 'wix-http-functions';
import wixData from 'wix-data';

/* ------------------------ CORS / Helpers ------------------------ */
function cors(extra) {
  return Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '600',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'Vary': 'Origin'
  }, extra || {});
}
const NO = (h) => ({ status: 204, headers: h, body: undefined });
const nowISO = () => new Date().toISOString();
const num = (v, d = null) =>
  (v === null || v === undefined || v === '' || isNaN(Number(v))) ? d : Number(v);

// 以 text() 讀並 JSON.parse，兼容未送 Content-Type 的 POST（可減少預檢）
async function readJSON(req) {
  try {
    const t = await req.body.text();
    return t ? JSON.parse(t) : {};
  } catch {
    try { return await req.body.json(); } catch { return {}; }
  }
}
function normalizeItem(item) {
  if (!item || typeof item !== 'object') return {};
  const out = { ...item };
  if ('noael' in out) out.noael = num(out.noael, null);
  if ('absorption_rate_pct' in out) out.absorption_rate_pct = num(out.absorption_rate_pct, null);
  if ('useAmount_mgPerDay' in out) out.useAmount_mgPerDay = num(out.useAmount_mgPerDay, null);
  if ('bodyWeight_kg' in out) out.bodyWeight_kg = num(out.bodyWeight_kg, null);
  if ('frequency_perDay' in out) out.frequency_perDay = num(out.frequency_perDay, null);
  // 不自動塞 createdAt，避免 schema 未建欄位報錯
  return out;
}
const DEFAULT_COLLECTION = 'Import1';

/* ------------------------ OPTIONS (CORS) ------------------------ */
export function options_ping()                 { return NO(cors()); }
export function options_diag()                 { return NO(cors()); }
export function options_cosmetic_toxics()      { return NO(cors()); }
export function options_cosmetic_toxics_bulk() { return NO(cors()); }
export function options_ai_suggest()           { return NO(cors()); }

/* ------------------------ Health / Diag ------------------------ */
// GET /_functions/ping
export function get_ping(_request) {
  return ok({ headers: cors(), body: { up: true, env: 'live', now: nowISO() } });
}

// GET /_functions/diag?collection=Import1
export async function get_diag(request) {
  const col = String(request?.query?.collection || DEFAULT_COLLECTION);
  try {
    await wixData.query(col).limit(1).find();
    return ok({ headers: cors(), body: { ok: true, env: 'live', collection: col, state: 'found' } });
  } catch (e) {
    const code = String(e?.errorCode || '');
    return ok({
      headers: cors(),
      body: {
        ok: false, env: 'live', collection: col,
        state: code === 'WDE0025' ? 'missing' : 'error',
        error: String(e?.message || e)
      }
    });
  }
}

/* ------------------------ Query (GET) ------------------------ */
// GET /_functions/cosmetic_toxics?q=&collection=Import1&limit=20&skip=0
export async function get_cosmetic_toxics(request) {
  const q     = String(request?.query?.q ?? '').trim();
  const col   = String(request?.query?.collection || DEFAULT_COLLECTION);
  const limit = Math.max(1, Math.min(100, num(request?.query?.limit, 20)));
  const skip  = Math.max(0, num(request?.query?.skip, 0));

  try {
    let qry = wixData.query(col);
    if (q) {
      // 嘗試多欄 OR；若 schema 缺欄導致報錯，退回只查 inci
      const F = ['inci','cas','function','ghs_h','notes','refs','chinese_name'];
      try {
        let orQ = wixData.query(col).contains(F[0], q);
        for (let i = 1; i < F.length; i++) {
          orQ = orQ.or(wixData.query(col).contains(F[i], q));
        }
        qry = orQ;
      } catch (_e) {
        qry = wixData.query(col).contains('inci', q);
      }
    }
    const rs = await qry.limit(limit).skip(skip).ascending('inci').find();
    return ok({
      headers: cors(),
      body: { success: true, collection: col, total: rs.totalCount, items: rs.items }
    });
  } catch (e) {
    return serverError({
      headers: cors(),
      body: { success: false, collection: col, error: String(e?.message || e) }
    });
  }
}

/* ------------------------ Single Save (POST) ------------------------ */
// POST /_functions/cosmetic_toxics
// { collection?: 'Import1', item: { ... } }
export async function post_cosmetic_toxics(request) {
  const body = await readJSON(request);
  const col  = String(body?.collection || request?.query?.collection || DEFAULT_COLLECTION);
  const item = normalizeItem(body?.item);

  if (!item || Object.keys(item).length === 0) {
    return badRequest({ headers: cors(), body: { ok: false, error: 'Missing "item"' } });
  }

  try {
    const ret = await wixData.save(col, item); // 有 _id 則更新，無則插入
    return created({ headers: cors(), body: { ok: true, collection: col, item: ret } });
  } catch (e) {
    return serverError({ headers: cors(), body: { ok: false, collection: col, error: String(e?.message || e) } });
  }
}

/* ------------------------ Bulk Save (POST, 去重＋diff-skip＋upsert＋fallback) ------------------------ */
// POST /_functions/cosmetic_toxics_bulk?collection=Import1&forceUpdate=1
// { items: [ {...}, ... ], collection?: 'Import1' }
export async function post_cosmetic_toxics_bulk(request) {
  const body  = await readJSON(request);
  const col   = String(body?.collection || request?.query?.collection || DEFAULT_COLLECTION);
  const force = String(request?.query?.forceUpdate || '').trim() === '1';
  let items   = Array.isArray(body?.items) ? body.items : [];

  if (!items.length) {
    return badRequest({ headers: cors(), body: { ok: false, error: 'Missing "items" (array)' } });
  }
  items = items.map(normalizeItem);

  try {
    // (1) 同批 payload 內以 INCI 去重（保留最後一筆）
    const byInci = new Map();
    for (const it of items) {
      const k = String(it.inci || '').trim().toLowerCase();
      if (k) byInci.set(k, it);
    }
    const deduped = Array.from(byInci.values());

    // (2) 查詢既有資料，為 upsert 準備 _id
    const keys = deduped.map(x => String(x.inci || '').trim()).filter(Boolean);
    const existed = keys.length ? await wixData.query(col).hasSome('inci', keys).find() : { items: [] };
    const existMap = new Map((existed.items || []).map(d => [String(d.inci || '').toLowerCase(), d]));

    // (3) diff：未變更就跳過；force 時一律視為需更新（同時觸碰 updatedAt）
    const FIELDS = ['cas','function','ghs_h','noael','notes','refs']; // 比較的業務欄位
    const newItems = [];
    const changedItems = [];
    const unchangedDetails = []; // 用於 summary.skippedDetails

    for (const it of deduped) {
      const key = String(it.inci || '').toLowerCase();
      const hit = existMap.get(key);

      if (!hit) {
        if (force) it.updatedAt = new Date(); // 可一併寫入插入筆
        newItems.push(it);
        continue;
      }

      // 既有 → 判斷差異
      let different = false;
      if (force) {
        different = true;
        it.updatedAt = new Date(); // 勾了 forceUpdate，觸碰時間戳（請於集合建立 Date 欄位）
      } else {
        for (const f of FIELDS) {
          const a = (it[f] == null ? null : it[f]);
          const b = (hit[f] == null ? null : hit[f]);
          if (a !== b) { different = true; break; }
        }
      }

      if (different) {
        it._id = hit._id;
        changedItems.push(it);
      } else {
        unchangedDetails.push({ item: it.inci, reason: 'unchanged' });
      }
    }

    // (4) bulkSave 實際寫入（僅「新增＋有差異」）
    const toSave = newItems.concat(changedItems);
    let rs = { inserted: [], updated: [], skipped: [], errors: [] };

    if (toSave.length) {
      rs = await wixData.bulkSave(col, toSave, { suppressAuth: true, suppressHooks: false });

      // 若某些環境下 bulkSave 回傳統計全 0，但未丟錯，改逐筆 fallback
      const countBulk = (rs.inserted?.length || 0) + (rs.updated?.length || 0) + (rs.skipped?.length || 0);
      if (countBulk === 0) {
        const ins=[], upd=[], skp=[], errs=[];
        for (let i = 0; i < toSave.length; i++) {
          try {
            const saved = await wixData.save(col, toSave[i], { suppressAuth: true, suppressHooks: false });
            const existedBefore = !!existMap.get(String(saved.inci || '').toLowerCase());
            if (existedBefore) upd.push(saved); else ins.push(saved);
          } catch (err) {
            errs.push({ index: i, item: toSave[i]?.inci || null, error: String(err?.message || err) });
          }
        }
        rs = { inserted: ins, updated: upd, skipped: skp, errors: errs };
      }
    }

    // (5) 合併 skipped：將「完全相同」這批列入 skipped 統計
    const skippedCombined = (rs.skipped || []).slice();
    for (const s of unchangedDetails) skippedCombined.push(s);

    // (6) 回傳 summary
    const summary = {
      ok: true,
      collection: col,
      forceUpdate: force,
      received: items.length,
      deduped : deduped.length,
      inserted: (rs.inserted || []).length || 0,
      updated : (rs.updated  || []).length || 0,
      skipped : skippedCombined.length,
      skippedDetails: skippedCombined, // 需要的話，前台可顯示於 Output
      errors  : (rs.errors || []).map(e => ({
        index: e.index,
        item : e.item && e.item.inci ? e.item.inci : null,
        error: String(e.error?.message || e.error)
      }))
    };

    return ok({ headers: cors(), body: summary });
  } catch (e) {
    return serverError({ headers: cors(), body: { ok: false, collection: col, error: String(e?.message || e) } });
  }
}

/* ------------------------ AI Suggest (POST, stub) ------------------------ */
// POST /_functions/ai_suggest
// { items: [{ inci, cas?, function?, ghs_h?, noael?, notes?, refs? }], region?: 'EU'|'TW' ... }
export async function post_ai_suggest(request) {
  const body = await readJSON(request);
  const list = Array.isArray(body?.items) ? body.items : [];
  if (!list.length) {
    return badRequest({ headers: cors(), body: { ok: false, error: 'No items' } });
  }

  // 簡易離線規則：自動填空草案（需人工覆核）
  const suggestOne = (x) => {
    const inci = String(x?.inci || '').trim();

    let functionGuess = x.function || (
      /betaine|兩性|兩性界面|zwitter/i.test(inci) ? '兩性界面活性劑' :
      /sulfate|sulfonate|glucoside|surfact/i.test(inci) ? '界面活性劑' :
      /glycerin|butylene glycol|propylene glycol|hyaluron/i.test(inci) ? '保濕劑' :
      /water|aqua/i.test(inci) ? '溶劑' : '待確認'
    );

    let noael = (x.noael != null) ? num(x.noael, null) : null;
    if (noael == null) {
      if (/保濕|humect/i.test(functionGuess)) noael = 500;
      else if (/界面活性|surfact/i.test(functionGuess)) noael = 200;
      else if (/溶劑|water|aqua/i.test(functionGuess)) noael = null;
      else noael = 100;
    }

    const ghs_h = x.ghs_h || ( /sulfate|laureth|caprylyl/i.test(inci) ? 'H319（示例）' : '' );

    return {
      inci,
      cas: x.cas || '',
      function: functionGuess,
      ghs_h,
      noael,
      notes: (x.notes || '') + (x.notes ? ' ' : '') + '[AI-stub 建議，請人工覆核]',
      refs: x.refs || '—'
    };
  };

  const out = list.map(suggestOne);
  return ok({ headers: cors(), body: { ok: true, suggested: out, ts: nowISO() } });
}
