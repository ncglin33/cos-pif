import { auth, db } from './firebase-config.js';
import { signInWithEmailAndPassword } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { doc, getDoc, updateDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const form = document.getElementById('login-form');
const statusEl = document.getElementById('status');
const submitBtn = document.getElementById('submit-btn');

function showStatus(message, type = 'info') {
    statusEl.textContent = message;
    statusEl.className = `form-message ${type}`;
}

form.addEventListener('submit', async (e) => {
    e.preventDefault();
    submitBtn.disabled = true;
    submitBtn.textContent = '登入中...';
    showStatus('正在驗證您的身份...', 'info');

    const email = document.getElementById('email').value;
    const password = document.getElementById('password').value;

    try {
        const userCredential = await signInWithEmailAndPassword(auth, email, password);
        const user = userCredential.user;
        const userDocRef = doc(db, 'users', user.uid);
        const userDoc = await getDoc(userDocRef);

        if (!userDoc.exists()) {
            throw new Error('找不到您的使用者設定檔。請聯繫管理員。');
        }

        const userData = userDoc.data();

        const userInfo = {
            uid: user.uid,
            email: user.email,
            name: userData.name,
            role: userData.role,
            status: userData.status
        };

        if (userData.role === 'admin') {
            if (userData.status !== 'active') {
                await updateDoc(userDocRef, { status: 'active' });
                userInfo.status = 'active';
            }
            sessionStorage.setItem('user', JSON.stringify(userInfo));
            window.location.href = 'admin.html';
        } else if (userData.status === 'active') {
            sessionStorage.setItem('user', JSON.stringify(userInfo));
            window.location.href = 'pif-i.html'; // <<<<<<< 修改後的跳轉頁面
        } else if (userData.status === 'pending') {
            showStatus('您的帳戶正在等待管理員審核。', 'info');
        } else {
            showStatus('您的帳戶已被停用，請聯繫管理員。', 'error');
        }

    } catch (error) {
        console.error("Login Error:", error);
        let errorMessage = '登入失敗，請檢查您的帳號或密碼。';
        if (error.code === 'auth/user-not-found' || error.code === 'auth/wrong-password' || error.code === 'auth/invalid-credential') {
           errorMessage = '電子郵件或密碼不正確。';
        }
        showStatus(errorMessage, 'error');
    } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = '登入';
    }
});
