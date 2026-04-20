// Import the functions you need from the SDKs you need
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getStorage } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js";
import { getFunctions, httpsCallable, connectFunctionsEmulator } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js";

// Your web app's Firebase configuration
const firebaseConfig = {
    apiKey: "AIzaSyAPI7reR6cmRiI_UJjnOzTWzGghJUNATS0",
    authDomain: "cos-pif.firebaseapp.com",
    projectId: "cos-pif",
    storageBucket: "cos-pif.firebasestorage.app",
    messagingSenderId: "993332237817",
    appId: "1:993332237817:web:3bb33b97c60fd033441928",
    measurementId: "G-JB7D5M3KK7"
};

function getFirebaseConfig() {
    return firebaseConfig;
}

// Initialize Firebase
const app = initializeApp(firebaseConfig);

// Get a reference to the auth, firestore, and storage services
export const auth = getAuth(app);
export const db = getFirestore(app);
export const storage = getStorage(app);
export const functions = getFunctions(app, 'asia-east1');

// For local development, connect to the Functions emulator
// ** IMPORTANT **
// Before running your app locally with the emulator, you need to:
// 1. Run 'firebase emulators:start' in your terminal
// 2. Uncomment the line below
// connectFunctionsEmulator(functions, "localhost", 5001);
