import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getFirestore, collection, doc, getDoc, setDoc, addDoc, updateDoc, deleteDoc, serverTimestamp, query, where, getDocs } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getAuth, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

function getFirebaseConfig() {
  return {
    apiKey: "AIzaSyCwlaU1as4KQQABJYCfudKCwUt38TbaNek",
    authDomain: "my-pif-64857823-900de.firebaseapp.com",
    projectId: "my-pif-64857823-900de",
    storageBucket: "my-pif-64857823-900de.appspot.com",
    messagingSenderId: "143235873399",
    appId: "1:143235873399:web:536efc772d9c29706c6472"
  };
}

// Initialize Firebase
const app = initializeApp(getFirebaseConfig());
const db = getFirestore(app);
const auth = getAuth(app);

// Export the necessary Firebase services and functions
export { 
    app, 
    db, 
    auth, 
    collection, 
    doc, 
    getDoc, 
    setDoc, 
    addDoc, 
    updateDoc, 
    deleteDoc, 
    serverTimestamp, 
    query, 
    where, 
    getDocs, 
    onAuthStateChanged, 
    signOut 
};
