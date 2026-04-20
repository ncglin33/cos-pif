// firebase-config.js  (Firebase v10+ Modular CDN, single source of truth)
// 使用方式：其他頁面請用 `import { app, auth, db, storage, functions } from "./firebase-config.js";`

import { initializeApp, getApp, getApps } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";
import { getStorage } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-storage.js";
import { getFunctions } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-functions.js";

// ⚠️ 請維持與 Firebase Console 內的設定完全一致
// Firebase Console -> Project settings -> Your apps -> SDK setup and configuration
const firebaseConfig = {
    apiKey: "AIzaSyAPI7reR6cmRiI_UJjnOzTWzGghJUNATS0",
  authDomain: "cos-pif.firebaseapp.com",
  projectId: "cos-pif",
  storageBucket: "cos-pif.firebasestorage.app",
  messagingSenderId: "993332237817",
  appId: "1:993332237817:web:3bb33b97c60fd033441928",
};

export const app = getApps().length ? getApp() : initializeApp(firebaseConfig);

// ✅ 這些都會是「模組化(v9+)」物件，能直接丟進 collection(db, ...) / doc(db, ...)
export const auth = getAuth(app);
export const db = getFirestore(app);
export const storage = getStorage(app);

// ✅ 若你有用 Cloud Functions callable，這裡統一 region
export const FUNCTIONS_REGION = "asia-east1";
export const functions = getFunctions(app, FUNCTIONS_REGION);
