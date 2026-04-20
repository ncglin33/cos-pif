
// Firebase SDK Imports
import { initializeApp } from "https://www.gstatic.com/firebasejs/9.22.1/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/9.22.1/firebase-auth.js";
import { getFirestore, doc, getDoc } from "https://www.gstatic.com/firebasejs/9.22.1/firebase-firestore.js";
import { getStorage, ref, uploadBytesResumable, getDownloadURL } from "https://www.gstatic.com/firebasejs/9.22.1/firebase-storage.js";

// --- Firebase Configuration & Initialization ---
const firebaseConfig = {
    apiKey: "AIzaSyCwlaU1as4KQQABJYCfudKCwUt38TbaNek",
    authDomain: "my-pif-64857823-900de.firebaseapp.com",
    projectId: "my-pif-64857823-900de",
    storageBucket: "my-pif-64857823-900de.appspot.com",
    messagingSenderId: "143235873399",
    appId: "1:143235873399:web:536efc772d9c29706c6472"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const storage = getStorage(app);
let currentUser = null;

// --- DOM Manipulation & Event Handling ---
document.addEventListener('DOMContentLoaded', () => {
    const targetElement = document.querySelector('.toolbar') || document.querySelector('header');

    if (targetElement) {
        // --- Create Buttons ---
        const backButton = document.createElement('a');
        backButton.href = './pifs.html';
        backButton.textContent = '返回首頁';
        backButton.className = 'btn-back-to-home';

        const signOutButton = document.createElement('button');
        signOutButton.textContent = '登出';
        signOutButton.className = 'btn-sign-out';
        signOutButton.addEventListener('click', () => {
            signOut(auth).catch(err => console.error('Sign out error', err));
        });

        const uploadButton = document.createElement('button');
        uploadButton.textContent = '上傳報告 PDF';
        uploadButton.className = 'btn-upload-report';
        uploadButton.title = '將本機已存檔的最終報告 PDF 上傳至雲端';
        uploadButton.addEventListener('click', handleReportUpload);

        const uploadStatus = document.createElement('span');
        uploadStatus.className = 'upload-status meta';

        // --- Inject Styles ---
        const style = document.createElement('style');
        style.textContent = `
            .btn-back-to-home, .btn-sign-out, .btn-upload-report {
                display: inline-block; padding: 8px 12px; background: #f8fafc;
                color: #334155; border: 1px solid #cbd5e1; border-radius: 10px;
                text-decoration: none; font-weight: 500; font-size: 13px;
                transition: all 0.2s ease-out; cursor: pointer;
            }
            .btn-back-to-home:hover, .btn-sign-out:hover, .btn-upload-report:hover {
                border-color: #94a3b8; background: #f1f5f9; transform: translateY(-1px);
                box-shadow: 0 1px 3px rgba(0,0,0,0.05);
            }
            .btn-upload-report { background-color: #f0fdf4; border-color: #a7f3d0; }
            .btn-upload-report:hover { background-color: #dcfce7; border-color: #86efac; }
            .btn-back-to-home { order: -1; margin-right: auto; }
            .btn-sign-out { margin-left: 1rem; }
            .upload-status { margin-left: 8px; }
            .upload-status a { color: #16a34a; font-weight: 500; }
        `;
        document.head.appendChild(style);

        // --- Append Elements ---
        targetElement.prepend(backButton);
        targetElement.appendChild(uploadButton);
        targetElement.appendChild(uploadStatus);
        targetElement.appendChild(signOutButton);
    }
});

function handleReportUpload() {
    if (!currentUser) {
        alert('無法上傳：使用者未登入或身份尚未驗證完畢。');
        return;
    }

    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = '.pdf';
    fileInput.style.display = 'none';

    fileInput.onchange = e => {
        const file = e.target.files[0];
        if (!file) return;

        const pifMatch = document.title.match(/PIF (\d+)/) || ['','UnknownPIF'];
        const pifNumber = pifMatch[1].padStart(2, '0');
        const productName = document.querySelector('#prodName')?.value || '未命名產品';
        const reportDate = new Date().toISOString().slice(0, 10);
        const fileName = `PIF${pifNumber}_${productName}_${reportDate}.pdf`;
        const storagePath = `pif_final_reports/${currentUser.uid}/${fileName}`;
        
        const storageRef = ref(storage, storagePath);
        const uploadTask = uploadBytesResumable(storageRef, file, { contentType: 'application/pdf' });
        
        const uploadBtn = document.querySelector('.btn-upload-report');
        const statusSpan = document.querySelector('.upload-status');
        if (uploadBtn) uploadBtn.disabled = true;

        uploadTask.on('state_changed', 
            snapshot => {
                const progress = (snapshot.bytesTransferred / snapshot.totalBytes) * 100;
                if(statusSpan) statusSpan.textContent = `上傳中... ${Math.round(progress)}%`;
            },
            error => {
                console.error("Upload failed:", error);
                if(statusSpan) statusSpan.innerHTML = `<span style="color:red;">上傳失敗</span>`;
                if (uploadBtn) uploadBtn.disabled = false;
                setTimeout(() => { if(statusSpan) statusSpan.textContent = ''; }, 5000);
            },
            async () => {
                const downloadURL = await getDownloadURL(uploadTask.snapshot.ref);
                if(statusSpan) statusSpan.innerHTML = `上傳成功！ <a href="${downloadURL}" target="_blank">查看檔案</a>`;
                if (uploadBtn) uploadBtn.disabled = false;
            }
        );
    };

    document.body.appendChild(fileInput);
    fileInput.click();
    document.body.removeChild(fileInput);
}


// --- Auth State Management ---
onAuthStateChanged(auth, async (user) => {
    if (user) {
        try {
            const userDocRef = doc(db, "users", user.uid);
            const userDoc = await getDoc(userDocRef);

            if (userDoc.exists() && userDoc.data().status === 'approved') {
                currentUser = user; // Set user globally
                document.body.classList.add('logged-in');
                if (userDoc.data().role === 'admin') {
                    document.body.classList.add('admin');
                }
            } else {
                console.log('User not approved, redirecting.');
                window.location.href = 'login.html';
            }
        } catch (error) {
            console.error("Auth check error:", error);
            window.location.href = 'login.html';
        }
    } else {
        console.log('User not logged in, redirecting.');
        window.location.href = 'login.html';
    }
});
