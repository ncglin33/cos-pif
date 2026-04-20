// Force redeploy with wildcard CORS.
const functions = require("firebase-functions");
const admin = require("firebase-admin");
const cors = require('cors')({origin: true}); // Allow all origins for debugging
const nomnoml = require('nomnoml');
const { GoogleGenerativeAI } = require("@google/generative-ai");

admin.initializeApp();
const db = admin.firestore();

// Helper to check for admin privileges
const isAdmin = async (context) => {
    if (!context.auth) {
        throw new functions.https.HttpsError('unauthenticated', 'The function must be called while authenticated.');
    }
    if (!context.auth.token.admin) {
        throw new functions.https.HttpsError('permission-denied', 'The function must be called by an admin user.');
    }
};

// --- MODIFIED: Changed to onRequest with CORS handling ---
exports.getCosmeticToxics = functions.region('us-central1').https.onRequest((req, res) => {
    // Wrap the entire function in the cors handler
    cors(req, res, async () => {

        // For onRequest functions, data comes from req.body
        const { q, collection, limit: dataLimit, skip: dataSkip } = req.body.data;
        
        const col = collection || 'ingredients';
        const limit = Math.max(1, Math.min(100, Number(dataLimit) || 20));
        const skip = Math.max(0, Number(dataSkip) || 0);

        try {
            let query = db.collection(col);

            if (q && typeof q === 'string' && q.trim()) {
                const searchTerm = q.trim();
                
                let querySnapshot = await query.where('inci', '>=', searchTerm).where('inci', '<=', searchTerm + '\uf8ff').limit(limit).offset(skip).get();
                
                if (querySnapshot.empty) {
                     querySnapshot = await query.where('chinese_name', '>=', searchTerm).where('chinese_name', '<=', searchTerm + '\uf8ff').limit(limit).offset(skip).get();
                }
                
                const items = querySnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
                const totalCount = items.length; 

                // For onRequest, send response back using res.json()
                res.json({ data: { success: true, collection: col, total: totalCount, items: items } });

            } else {
                const snapshot = await query.orderBy('inci').limit(limit).offset(skip).get();
                const items = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
                const totalResult = await query.get();
                
                res.json({ data: { success: true, collection: col, total: totalResult.size, items: items } });
            }

        } catch (error) {
            console.error("Error in getCosmeticToxics:", error);
            // Send a 500 internal server error response
            res.status(500).json({ data: { success: false, error: 'An error occurred while fetching data.' } });
        }
    });
});

exports.generateToxicologySummary = functions.region('us-central1').https.onCall(async (data, context) => {
    const { inci } = data;
    if (!inci) {
        throw new functions.https.HttpsError('invalid-argument', 'The function must be called with an "inci" argument.');
    }

    const lowerInci = inci.toLowerCase().trim();

    const specialCases = {
        'aqua': {
              acute_oral_toxicity: "Not applicable",
              acute_dermal_toxicity: "Not applicable",
              acute_inhalation_toxicity: "Not applicable",
              skin_irritation: "Non-irritating",
              eye_irritation: "Non-irritating",
              skin_sensitization: "Non-sensitizing",
              mutagenicity: "Not mutagenic",
              carcinogenicity: "Not carcinogenic",
              reproductive_toxicity: "Not toxic for reproduction",
              noael: "Not applicable"
        },
        'water': {
              acute_oral_toxicity: "Not applicable",
              acute_dermal_toxicity: "Not applicable",
              acute_inhalation_toxicity: "Not applicable",
              skin_irritation: "Non-irritating",
              eye_irritation: "Non-irritating",
              skin_sensitization: "Non-sensitizing",
              mutagenicity: "Not mutagenic",
              carcinogenicity: "Not carcinogenic",
              reproductive_toxicity: "Not toxic for reproduction",
              noael: "Not applicable"
        },
        'butylene glycol': {
            acute_oral_toxicity: "> 18000 mg/kg (Rat)",
            acute_dermal_toxicity: "No data found",
            acute_inhalation_toxicity: "No data found",
            skin_irritation: "Non-irritating (Rabbit)",
            eye_irritation: "Slightly irritating (Rabbit)",
            skin_sensitization: "Not sensitizing (Human)",
            mutagenicity: "Not mutagenic (Ames test)",
            carcinogenicity: "No data found",
            reproductive_toxicity: "No data found",
            noael: "No data found"
        }
    };

    if (specialCases[lowerInci]) {
        return { success: true, data: specialCases[lowerInci] };
    }

    try {
        const genAI = new GoogleGenerativeAI(functions.config().gemini.key);
        const model = genAI.getGenerativeModel({ model: "gemini-pro" });

        const prompt = `
            你是一位專業的化妝品安全評估毒理學家。
            請針對以下化妝品成分，提供其毒理學資料摘要。
            
            成分 INCI 名稱: ${inci}

            請嚴格依照以下 JSON 格式回傳資料，若某項資料不存在或找不到，請使用 "No data found" 作為其值。
            僅回傳 JSON 物件，不要包含任何額外的說明或 markdown 格式。

            {
              "acute_oral_toxicity": "請填寫急性經口毒性 (LD50)，包含物種，例如：'> 2000 mg/kg (Rat)'",
              "acute_dermal_toxicity": "請填寫急性經皮毒性 (LD50)，包含物種",
              "acute_inhalation_toxicity": "請填寫急性吸入毒性 (LC50)，包含物種",
              "skin_irritation": "請填寫皮膚刺激/腐蝕性資料，包含物種，例如：'Not irritating (Rabbit)'",
              "eye_irritation": "請填寫眼睛刺激/損傷性資料，包含物種，例如：'Serious eye irritant (Rabbit)'",
              "skin_sensitization": "請填寫皮膚過敏性資料，包含物種，例如：'Not sensitizing (Human)'",
              "mutagenicity": "請填寫基因突變性資料 (例如 Ames test 結果)",
              "carcinogenicity": "請填寫致癌性資料",
              "reproductive_toxicity": "請填寫生殖毒性資料",
              "noael": "請填寫未觀察到有害作用的劑量水平 (NOAEL)"
            }
        `;

        const result = await model.generateContent(prompt);
        const response = await result.response;
        const text = response.text();
        
        const jsonText = text.replace(/```json/g, '').replace(/```/g, '').trim();

        try {
            const jsonData = JSON.parse(jsonText);
            return { success: true, data: jsonData };
        } catch (parseError) {
            console.error("Error parsing AI JSON response:", parseError, "Raw text:", jsonText);
            throw new functions.https.HttpsError('internal', 'AI returned data in an invalid format.');
        }

    } catch (error) {
        console.error("Detailed AI Toxicology Generation Error:", JSON.stringify(error, null, 2));
        if (error.message && error.message.includes('API key not valid')) {
             throw new functions.https.HttpsError('unauthenticated', 'Gemini API 金鑰未設定或無效，請聯繫管理員。');
        }
        throw new functions.https.HttpsError('internal', '生成 AI 毒理摘要時發生錯誤，請檢查 Cloud Function 日誌以取得詳細資訊。');
    }
});


exports.setUserStatus = functions.region('asia-east1').https.onCall(async (data, context) => {
    await isAdmin(context);
    const { uid, newStatus } = data;
    if (!uid || !['active', 'rejected'].includes(newStatus)) {
        throw new functions.https.HttpsError('invalid-argument', 'Invalid arguments provided.');
    }

    try {
        const userRef = db.collection('users').doc(uid);
        const updateData = { status: newStatus };
        if (newStatus === 'active') {
            const expiryDate = new Date();
            expiryDate.setDate(expiryDate.getDate() + 180);
            updateData.expires = admin.firestore.Timestamp.fromDate(expiryDate);
        }
        await userRef.update(updateData);
        return { success: true };
    } catch (error) {
        console.error("Error in setUserStatus:", error);
        throw new functions.https.HttpsError('internal', 'Could not update user status.');
    }
});

exports.extendMembership = functions.region('asia-east1').https.onCall(async (data, context) => {
    await isAdmin(context);
    const { uid } = data;
    if (!uid) {
        throw new functions.https.HttpsError('invalid-argument', 'UID must be provided.');
    }

    try {
        const userRef = db.collection('users').doc(uid);
        const expiryDate = new Date();
        expiryDate.setDate(expiryDate.getDate() + 180);
        await userRef.update({
            expires: admin.firestore.Timestamp.fromDate(expiryDate),
            status: 'active' // Ensure user is active
        });
        return { success: true };
    } catch (error) {
        console.error("Error in extendMembership:", error);
        throw new functions.https.HttpsError('internal', 'Could not extend membership.');
    }
});

exports.updateAdminSettings = functions.region('asia-east1').https.onCall(async (data, context) => {
    await isAdmin(context);
    const { emails } = data;
    if (!Array.isArray(emails)) {
        throw new functions.https.HttpsError('invalid-argument', 'The "emails" field must be an array.');
    }
    try {
        await db.collection('settings').doc('admin').set({ notificationEmails: emails }, { merge: true });
        return { success: true };
    } catch (error) {
        console.error("Error updating admin settings:", error);
        throw new functions.https.HttpsError('internal', 'An internal error occurred while updating settings.');
    }
});


const generateNewPifId = async (prefix) => {
    const pifRef = db.collection('pif_counters').doc(prefix);
    let newPifId = '';

    await db.runTransaction(async (transaction) => {
        const pifDoc = await transaction.get(pifRef);
        const today = new Date();
        const year = today.getFullYear();
        const month = String(today.getMonth() + 1).padStart(2, '0');

        let count = 1;
        let lastReset = '';

        if (pifDoc.exists) {
            const data = pifDoc.data();
            const lastResetDate = data.lastReset ? new Date(data.lastReset) : new Date(0);
            
            if (lastResetDate.getFullYear() === today.getFullYear() && lastResetDate.getMonth() === today.getMonth()) {
                count = data.count + 1;
                lastReset = data.lastReset;
            } else {
                lastReset = `${year}-${month}`;
            }
        } else {
             lastReset = `${year}-${month}`;
        }
        
        transaction.set(pifRef, { count, lastReset }, { merge: true });
        
        const paddedCount = String(count).padStart(3, '0');
        newPifId = `${prefix}-${year}${month}-${paddedCount}`;
    });

    return newPifId;
};

exports.generatePifId = functions.region('asia-east1').https.onCall(async (data, context) => {
    await isAdmin(context);
    try {
        const { prefix } = data; 
        if (!prefix || !/^[A-Z]{2}$/.test(prefix)) {
            throw new functions.https.HttpsError('invalid-argument', 'The function must be called with a 2-letter uppercase "prefix".');
        }
        const newPifId = await generateNewPifId(prefix);
        return { success: true, pifId: newPifId };
    } catch (error) {
        console.error("Error in generatePifId:", error);
        throw new functions.https.HttpsError('internal', 'An error occurred while generating the PIF ID.');
    }
});

exports.createPifProject = functions.region('asia-east1').https.onCall(async (data, context) => {
    await isAdmin(context);
    const pifData = data; 
    
    if (!pifData.pifId || !pifData.companyName || !pifData.productName) {
        throw new functions.https.HttpsError('invalid-argument', 'The data must include pifId, companyName, and productName.');
    }

    try {
        const pifDocRef = db.collection('pifs').doc(pifData.pifId);
        const finalData = {
            ...pifData,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            createdBy: context.auth.uid,
            status: pifData.status || 'draft',
        };
        await pifDocRef.set(finalData);
        return { success: true, message: 'PIF project created successfully.', pifId: pifData.pifId };
    } catch (error) {
        console.error("Error in createPifProject:", error);
        throw new functions.https.HttpsError('internal', 'An error occurred while creating the project document.');
    }
});

exports.generateManufacturingSummary = functions.region('us-central1').https.onCall(async (data, context) => {
    await isAdmin(context);
    const { formula, productName } = data;
    if (!Array.isArray(formula) || formula.length === 0) {
        throw new functions.https.HttpsError('invalid-argument', 'The function requires a non-empty "formula" array.');
    }

    try {
        const genAI = new GoogleGenerativeAI(functions.config().gemini.key);
        const model = genAI.getGenerativeModel({ model: "gemini-pro" });
        const phases = {};
        formula.forEach(ing => {
            const phase = ing.phase || '未指定';
            if (!phases[phase]) {
                phases[phase] = [];
            }
            phases[phase].push(`${ing.inci} (${ing.pct}%)`);
        });

        let prompt = `你是一位經驗豐富的化妝品配方師，專長是撰寫製造流程說明書（SOP）。\n請根據我提供的產品名稱和配方，生成一份專業、詳細的製造摘要說明。\n\n產品名稱：${productName || '未提供'}\n\n配方（依投料順序排列）：\n`;
        Object.keys(phases).forEach(phaseName => {
            prompt += `\n[${phaseName}]\n`;
            prompt += phases[phaseName].join('\n');
        });
        prompt += `\n\n請依照以下格式撰寫製造流程，需包含溫度、轉速、時間、外觀檢查、pH值測定等關鍵控制點(CCP)：\n\n1. ${Object.keys(phases)[0] || '第一相'}：[此處填寫詳細步驟...]\n2. ${Object.keys(phases)[1] || '第二相'}：[此處填寫詳細步驟...]\n...依此類推...\n\n- 必須使用繁體中文。\n- 內容要聽起來專業、符合化妝品工廠的實際操作情況。\n- 對於常見製程（如乳化、增稠、溶解），請提供合理的參數建議（例如：乳化溫度 75-85°C，均質機轉速 3000-5000 rpm）。\n`;

        const result = await model.generateContent(prompt);
        const response = await result.response;
        const summaryText = response.text();
        return { success: true, summary: summaryText };
    } catch (error) {
        console.error("Detailed AI Summary Generation Error:", JSON.stringify(error, null, 2));
        if (error.message && error.message.includes('API key not valid')) {
             throw new functions.https.HttpsError('unauthenticated', 'Gemini API 金鑰未設定或無效，請聯繫管理員。');
        }
        if (error.message && error.message.includes('location is not supported')) {
            throw new functions.https.HttpsError('unavailable', 'AI服務目前不支援您所在的地區。');
        }
        throw new functions.https.HttpsError('internal', '生成 AI 製造摘要時發生錯誤，請檢查 Cloud Function 日誌以取得詳細資訊。');
    }
});

exports.generateFlowchart = functions.region('asia-east1').https.onCall((data, context) => {
    if (!context.auth) {
        throw new functions.https.HttpsError('unauthenticated', 'The function must be called while authenticated.');
    }
    const steps = data.steps;
    if (!Array.isArray(steps) || steps.length === 0) {
        throw new functions.https.HttpsError('invalid-argument', 'The function must be called with an array of steps.');
    }
    const nomnomlString = steps.map((step, index) => {
        const name = step.name.replace(/[\[\]]/g, ''); // Sanitize
        let node = `[${name}]`;
        if (index > 0) {
            const prevStepName = steps[index - 1].name.replace(/[\[\]]/g, '');
            return `[${prevStepName}] -> ${node}`;
        }
        return node;
    }).join('\n');
    try {
        const svg = nomnoml.renderSvg(nomnomlString);
        return { success: true, svg: svg };
    } catch (error) {
        console.error("Error generating SVG:", error);
        throw new functions.https.HttpsError('internal', 'An error occurred while generating the flowchart SVG.');
    }
});
