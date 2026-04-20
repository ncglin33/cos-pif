// Import Firestore methods
import {
    doc,
    getDoc,
    updateDoc,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

// Import auth and db from the central config file, and the auth state observer
import { auth, db } from './firebase-config.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';

// --- Get DOM Elements ---
const pifForm = document.getElementById('pif-form');
const errorMessage = document.getElementById('error-message');
const successMessage = document.getElementById('success-message');
const loadingIndicator = document.getElementById('loading-indicator');
const formContent = document.getElementById('form-content');
const pifId = new URLSearchParams(window.location.search).get('id');

// --- Authentication State Observer ---
// This is the core of the fix. It ensures that we only try to fetch data
// AFTER Firebase has confirmed the user is logged in.
onAuthStateChanged(auth, (user) => {
    if (user) {
        // User is signed in. Now it's safe to check for the ID and load data.
        if (!pifId) {
            loadingIndicator.style.display = 'none';
            errorMessage.textContent = '錯誤：找不到專案 ID。請從儀表板點擊「編輯」按鈕進入。';
            errorMessage.style.display = 'block';
            return;
        }
        loadPifData();
    } else {
        // User is not signed in. Redirect them to the login page.
        // It's helpful to pass the current URL as a parameter so they can be redirected back.
        console.log('User not authenticated, redirecting to login.');
        const redirectUrl = encodeURIComponent(window.location.href);
        window.location.href = `login.html?redirect=${redirectUrl}`;
    }
});

// --- Data Loading Function ---
async function loadPifData() {
    try {
        const docRef = doc(db, 'pifs', pifId);
        const docSnap = await getDoc(docRef);

        if (docSnap.exists()) {
            // Because onAuthStateChanged has completed, Firestore security rules
            // will now correctly identify the user (request.auth.uid).
            const data = docSnap.data();

            // Populate the form with data from Firestore
            pifForm.companyName.value = data.companyName || '';
            pifForm.productName.value = data.productName || '';
            pifForm.contactPerson.value = data.contactPerson || '';
            pifForm.contactEmail.value = data.contactEmail || '';
            pifForm.status.value = data.status || '草稿';

            // Show the form and hide the loading spinner
            formContent.style.display = 'block';
            loadingIndicator.style.display = 'none';
        } else {
            // This can happen if the ID is wrong or if security rules deny access
            errorMessage.textContent = '找不到該專案的資料，或您沒有存取權限。';
            errorMessage.style.display = 'block';
            loadingIndicator.style.display = 'none';
        }
    } catch (error) {
        console.error('Error loading PIF document:', error);
        errorMessage.textContent = `載入資料時發生嚴重錯誤： ${error.message}`;
        errorMessage.style.display = 'block';
        loadingIndicator.style.display = 'none';
    }
}

// --- Form Submission Handler ---
pifForm.addEventListener('submit', async (e) => {
    e.preventDefault(); // Prevent default form submission

    // Re-check for pifId just in case
    if (!pifId) {
        errorMessage.textContent = '錯誤：專案 ID 已遺失，無法儲存變更。';
        errorMessage.style.display = 'block';
        return;
    }

    const submitBtn = document.getElementById('submit-btn');
    submitBtn.disabled = true;
    submitBtn.textContent = '儲存中...';

    try {
        const docRef = doc(db, 'pifs', pifId);
        await updateDoc(docRef, {
            companyName: pifForm.companyName.value,
            productName: pifForm.productName.value,
            contactPerson: pifForm.contactPerson.value,
            contactEmail: pifForm.contactEmail.value,
            status: pifForm.status.value,
            updatedAt: new Date(), // Consider using serverTimestamp() for better accuracy
        });

        successMessage.textContent = '專案已成功更新！即將返回儀表板...';
        successMessage.style.display = 'block';
        errorMessage.style.display = 'none';

        // Redirect back to the dashboard after a short delay
        setTimeout(() => {
            window.location.href = 'pif-i.html';
        }, 2000);

    } catch (error) {
        console.error('Error updating document: ', error);
        errorMessage.textContent = `更新失敗：${error.message}`;
        errorMessage.style.display = 'block';
        successMessage.style.display = 'none';
        
        // Re-enable the button on failure
        submitBtn.disabled = false;
        submitBtn.textContent = '儲存變更';
    }
});
