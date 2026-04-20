const functions = require("firebase-functions");
const admin = require("firebase-admin");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const express = require("express");
const cors = require("cors");
const sgMail = require("@sendgrid/mail");
require('dotenv').config({ path: './mail_params.env' });

admin.initializeApp();
const db = admin.firestore();

sgMail.setApiKey(process.env.SENDGRID_API_KEY);

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

// General Express App for QA Search
const app = express();
const corsOptions = {
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    const allowedProductionOrigins = [
      'https://cos-pif.web.app',
      'https://www.cos-pif.web.app'
    ];
    if (origin.endsWith('.cloudworkstations.dev') || origin.startsWith('http://localhost') || origin.startsWith('http://127.0.0.1')) {
      return callback(null, true);
    }
    if (allowedProductionOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
  credentials: true,
};

app.use(cors(corsOptions));
app.use(express.json());

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
    const qaContext = qaSnapshot.docs.map(doc => {
        const data = doc.data();
        return `Q: ${data.question}\\nA: ${data.answer}`;
    }).join('\\n\\n');
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
    const model = genAI.getGenerativeModel({
      model: "gemini-1.5-flash-preview-0514",
      systemInstruction: system_prompt,
    });
    const result = await model.generateContent(message);
    const response = await result.response;
    const replyText = response.text();
    res.json({ reply: replyText });
  } catch (error) {
    console.error("--- QA SEARCH EXECUTION ERROR ---", error);
    res.status(500).json({ reply: "抱歉，智慧搜尋引擎發生了未預期的錯誤，我們正在緊急修復中。" });
  }
});
exports.api = functions.region("us-central1").https.onRequest(app);

// Express App for PIF ID Generation
const pifApp = express();
pifApp.use(cors(corsOptions));
pifApp.use(express.json());
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
            let nextVal = 1;
            if (counterDoc.exists) {
                nextVal = counterDoc.data().current_val + 1;
            }
            transaction.set(counterRef, { current_val: nextVal });
            const sequence = nextVal.toString().padStart(3, '0');
            newPifId = `${counterPrefix}${sequence}`;
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

// Express App for PIF Project Creation
const createPifApp = express();
createPifApp.use(cors(corsOptions));
createPifApp.use(express.json());
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
    console.error("Error verifying ID token:", error);
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
      pifId: pifId,
      productName: productName,
      productNameEn: productNameEn,
      companyName: companyName,
      createdAt: new Date().toISOString(),
      ownerId: ownerId,
      pif01: pif01,
      pif02: { status: 'pending' }, pif03: { status: 'pending' },
      pif04: { status: 'pending' }, pif05: { status: 'pending' },
      pif06: { status: 'pending' }, pif07: { status: 'pending' },
      pif08: { status: 'pending' }, pif09: { status: 'pending' },
      pif10: { status: 'pending' }, pif11: { status: 'pending' },
      pif12: { status: 'pending' }, pif13: { status: 'pending' },
      pif14: { status: 'pending' }, pif15: { status: 'pending' },
      pif16: { status: 'pending' }, pif16sa: { status: 'pending' },
    });
    return res.status(200).json({ success: true, pifId: pifId });
  } catch (error) {
    console.error("Error creating PIF project document:", error);
    return res.status(500).json({ success: false, error: 'An internal error occurred while creating the project document.' });
  }
});
exports.createPifProject = functions.region("us-central1").https.onRequest(createPifApp);

// ** NEW ** Express App for Company Data
const companyApp = express();
companyApp.use(cors(corsOptions));
companyApp.use(express.json());

companyApp.get('/data/:companyKey', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).send({ success: false, error: 'Unauthorized: No ID token provided.' });
    }
    const idToken = authHeader.split('Bearer ')[1];
    try {
        await admin.auth().verifyIdToken(idToken);
    } catch (error) {
        console.error("Error verifying ID token:", error);
        return res.status(401).send({ success: false, error: 'Unauthorized: Invalid ID token.' });
    }

    const { companyKey } = req.params;
    if (!companyKey) {
        return res.status(400).send({ success: false, error: 'The function must be called with a "companyKey".' });
    }

    try {
        const wishListPromise = db.collection('pif_intent_submissions')
                                   .where('companyKey', '==', companyKey)
                                   .orderBy('submittedAt', 'desc')
                                   .get();
        const evaListPromise = db.collection('eva_submissions')
                                 .where('companyKey', '==', companyKey)
                                 .orderBy('submittedAt', 'desc')
                                 .get();

        const [wishListSnapshot, evaListSnapshot] = await Promise.all([wishListPromise, evaListPromise]);

        const wishListData = wishListSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        const evaListData  = evaListSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

        const countByStatus = (list) => {
            const out = { total: 0, pending: 0, approved: 0, rejected: 0 };
            const arr = Array.isArray(list) ? list : [];
            out.total = arr.length;
            arr.forEach(item => {
                const s = (item && item.status) ? String(item.status) : "pending";
                if (s === "approved") out.approved++;
                else if (s === "rejected") out.rejected++;
                else out.pending++;
            });
            return out;
        };

        const latestSubmittedAt = (list) => {
            const arr = Array.isArray(list) ? list : [];
            let max = null;
            arr.forEach(item => {
                const ts = item && item.submittedAt;
                let ms = 0;
                try {
                    if (ts && typeof ts.toMillis === "function") ms = ts.toMillis();
                    else if (ts && typeof ts.seconds === "number") ms = ts.seconds * 1000;
                    else if (ts) {
                        const t = Date.parse(ts);
                        ms = Number.isFinite(t) ? t : 0;
                    }
                } catch (e) { ms = 0; }
                if (ms > 0 && (!max || ms > max._ms)) {
                    max = { _ms: ms, value: ts };
                }
            });
            return max ? max.value : null;
        };

        const wishCounts = countByStatus(wishListData);
        const evaCounts  = countByStatus(evaListData);

        const payload = {
            success: true,
            version: "company-home-v2",
            companyKey,
            summary: {
                wish: { ...wishCounts, latestSubmittedAt: latestSubmittedAt(wishListData) },
                eva:  { ...evaCounts,  latestSubmittedAt: latestSubmittedAt(evaListData) },
                totalApps: wishCounts.total + evaCounts.total
            },
            // ✅「公司歸戶升級版」專用結構
            wish: { items: wishListData },
            eva:  { items: evaListData },

            // ✅ 兼容舊前端欄位
            wishList: wishListData,
            evaList:  evaListData
        };

        return res.status(200).json(payload);
} catch (error) {
        console.error(`Error fetching data for company ${companyKey}:`, error);
        return res.status(500).send({ success: false, error: 'Failed to fetch company data.' });
    }
});
exports.company = functions.region("asia-east1").https.onRequest(companyApp);
// ** END NEW **

// Admin functions
const adminFunctionsRegion = "asia-east1";

const ensureAdmin = (context) => {
  if (!context.auth || !context.auth.token.admin) {
    throw new functions.https.HttpsError(
      'permission-denied',
      'This function must be called by an administrator.'
    );
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

        const combinedUsers = listUsersResult.users.map(userRecord => {
            const firestoreData = firestoreUsers[userRecord.uid] || {};
            return {
                id: userRecord.uid,
                email: userRecord.email,
                claims: userRecord.customClaims || {},
                ...firestoreData
            };
        });
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
    const currentClaims = user.customClaims || {};
    await admin.auth().setCustomUserClaims(uid, { ...currentClaims, admin: true, client: false });
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
    const currentClaims = user.customClaims || {};
    await admin.auth().setCustomUserClaims(uid, { ...currentClaims, client: true, admin: false });
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
    const currentClaims = user.customClaims || {};
    await admin.auth().setCustomUserClaims(uid, { ...currentClaims, status: newStatus });
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
            const msg = {
                to: adminEmails,
                from: process.env.FROM_EMAIL,
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
        const msg = {
            to: mailData.to,
            from: process.env.FROM_EMAIL,
            subject: mailData.message.subject,
            html: mailData.message.html,
        };
        try {
            await sgMail.send(msg);
            console.log(`Email sent successfully to ${msg.to} with subject \\"${msg.subject}\\"`);
            return snap.ref.delete();
        } catch (error) {
            console.error('Error sending email via SendGrid:', error);
            if (error.response) {
                console.error(error.response.body);
            }
            return snap.ref.update({ status: 'error', errorMessage: error.message });
        }
    });
