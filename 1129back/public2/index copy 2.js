const functions = require("firebase-functions");
const admin = require("firebase-admin");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const express = require("express");
const cors = require("cors");
const sgMail = require("@sendgrid/mail");

admin.initializeApp();
const db = admin.firestore();

// --- CONFIGURATION ---
try {
  const sendgridKey = functions.config().sendgrid.key;
  if (sendgridKey) {
    sgMail.setApiKey(sendgridKey);
  } else {
    console.error("CRITICAL: SendGrid API key is MISSING from Firebase functions config.");
  }
} catch (error) {
    console.error("CRITICAL: Could not retrieve SendGrid API Key. Ensure 'sendgrid.key' is set in Firebase config.");
}

let genAI;
try {
  const geminiKey = functions.config().gemini.key;
  if (!geminiKey) {
    console.error("CRITICAL: Gemini API key is MISSING from Firebase functions config.");
  }
  genAI = new GoogleGenerativeAI(geminiKey);
} catch (error) {
  console.error("CRITICAL: Error initializing GoogleGenerativeAI:", error);
}
// --- END CONFIGURATION ---

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

  try {
    if (!genAI) {
      throw new Error("Gemini client is not initialized. Please check functions config: gemini.key");
    }

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

    const model = genAI.getGenerativeModel({
      model: "gemini-1.5-flash-preview-0514",
      systemInstruction: systemPrompt
    });

    const result = await model.generateContent(userPrompt);
    const response = await result.response;
    const text = (response && response.text) ? response.text() : "";

    return { success: true, summary: (text || "").trim() };

  } catch (error) {
    console.error("Error generating manufacturing summary:", error);
    throw new functions.https.HttpsError(
      "internal",
      error.message || "Failed to generate manufacturing summary."
    );
  }
});

// --- LEGACY onRequest and Admin Functions ---

const app = express();
const pifApp = express();
const createPifApp = express();

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
  if (!genAI) {
    return res.status(503).json({ reply: "智慧搜尋服務暫時無法使用，請稍後再試。" });
  }
  const { message } = req.body;
  if (!message) {
    return res.status(400).json({ error: "缺少查詢問題 ('message' field)" });
  }
  try {
    const qaSnapshot = await db.collection('qa_database').get();
    if (qaSnapshot.empty) {
        return res.status(500).json({ reply: "抱歉，知識庫目前是空的，無法提供回答。" });
    }
    const qaContext = qaSnapshot.docs.map(doc => `Q: ${doc.data().question}\nA: ${doc.data().answer}`).join('\n\n');
    const system_prompt = `
      你是一個專業的「CosPIF 常見問題」智慧搜尋引擎。你的任務是根據以下提供的「知識庫」，為使用者的問題找到最精確的答案。
      **知識庫:**
      ${qaContext}
      **執行規則:**
      1.  **完全匹配優先:** 如果使用者的問題與知識庫中的某個問題幾乎完全相同，直接回傳對應的答案。
      2.  **語意相關:** 如果沒有完全匹配的問題，請理解使用者問題的意圖，並找出知識庫中最相關的問答。
      3.  **單一答案:** 只回傳最相關的一個答案。不要自己生成或總結多個答案。
      4.  **找不到答案:** 如果知識庫中沒有任何相關的問答可以回答使用者的問題，請固定回傳以下文字：「抱歉，我在資料庫中找不到與您問題相關的答案。建議您換個方式提問，或直接聯繫我們的客服團隊。」
      5.  **簡潔回答:** 直接提供答案內容，不要加上「根據資料庫...」或「我找到了...」等多餘的開頭。
    `;
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash-preview-0514", systemInstruction: system_prompt });
    const result = await model.generateContent(message);
    const response = await result.response;
    res.json({ reply: response.text() });
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
exports.createPifProject = functions.region("us-central1").https.onRequest(createPifApp);

const adminFunctionsRegion = "asia-east1";

const ensureAdmin = (context) => {
  if (!context.auth || !context.auth.token.admin) {
    throw new functions.https.HttpsError('permission-denied', 'This function must be called by an administrator.');
  }
};

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
            ...firestoreUsers[userRecord.uid] || {}
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

exports.grantAdminRole = functions.region(adminFunctionsRegion).https.onCall(async (data, context) => {
  ensureAdmin(context);
  const { uid } = data;
  if (!uid) {
    throw new functions.https.HttpsError('invalid-argument', 'The function must be called with a "uid".');
  }
  try {
    const user = await admin.auth().getUser(uid);
    await admin.auth().setCustomUserClaims(uid, { ...user.customClaims, admin: true, client: false });
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
    await admin.auth().setCustomUserClaims(uid, { ...user.customClaims, client: true, admin: false });
    return { success: true, message: `Client role granted to user ${uid}.` };
  } catch (error) {
    console.error(`Error granting client role to user ${uid}:`, error);
    throw new functions.https.HttpsError('internal', `Failed to grant client role. Reason: ${error.message}`);
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

exports.sendNewUserNotification = functions.region("asia-east1").firestore
    .document('users/{userId}')
    .onCreate(async (snap, context) => {
        const newUser = snap.data();
        try {
            const settingsRef = db.collection("settings").doc("admin");
            const settingsDoc = await settingsRef.get();
            if (!settingsDoc.exists) {
                console.log("Admin settings not found, skipping email notification.");
                return;
            }
            const adminEmails = settingsDoc.data().notificationEmails;
            if (!adminEmails || adminEmails.length === 0) {
                console.log("No admin notification emails configured, skipping email notification.");
                return;
            }
            const fromEmail = functions.config().sendgrid.from_email;
            if (!fromEmail) {
                console.error("CRITICAL: SendGrid FROM_EMAIL is not configured in Firebase functions config.");
                return;
            }
            const msg = {
                to: adminEmails,
                from: fromEmail,
                subject: '【CosPIF】新用戶註冊通知',
                html: `
                    <p>您好，</p>
                    <p>系統有新的用戶註冊，正在等待審核。以下是詳細資訊：</p>
                    <ul>
                        <li><strong>姓名:</strong> ${newUser.name}</li>
                        <li><strong>公司:</strong> ${newUser.company}</li>
                        <li><strong>Email:</strong> ${newUser.email}</li>
                    </ul>
                    <p>請盡快登入管理後台進行審核。</p>
                    <p>CosPIF 智慧科技整合系統</p>
                `,
            };
            await sgMail.send(msg);
            console.log(`New user notification sent to: ${adminEmails.join(', ')}`);
        } catch (error) {
            console.error('Error sending new user notification email:', error);
            if (error.response) {
                console.error(error.response.body)
            }
        }
    });

exports.processMailQueue = functions.region('asia-east1').firestore
    .document('mail/{mailId}')
    .onCreate(async (snap, context) => {
        const mailData = snap.data();
        const fromEmail = functions.config().sendgrid.from_email;
        if (!fromEmail) {
            console.error("CRITICAL: SendGrid FROM_EMAIL is not configured in Firebase functions config. Email not sent.");
            return snap.ref.update({ status: 'error', errorMessage: 'FROM_EMAIL not configured.' });
        }
        const msg = {
            to: mailData.to,
            from: fromEmail,
            subject: mailData.message.subject,
            html: mailData.message.html,
        };
        try {
            await sgMail.send(msg);
            console.log(`Email sent successfully to ${msg.to} with subject \"${msg.subject}\"`);
            return snap.ref.delete();
        } catch (error) {
            console.error('Error sending email via SendGrid:', error);
            if (error.response) {
                console.error(error.response.body);
            }
            return snap.ref.update({ status: 'error', errorMessage: error.message });
        }
    });
