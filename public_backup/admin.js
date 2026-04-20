import { onAuthStateChanged, signOut, getIdTokenResult } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { collection, getDocs, doc, getDoc, setDoc, Timestamp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { httpsCallable } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js";
import { auth, db, functions } from './firebase-config.js';

const $ = sel => document.querySelector(sel);

onAuthStateChanged(auth, async (user) => {
    if (user) {
        const idTokenResult = await getIdTokenResult(user);
        if (idTokenResult.claims.admin) {
            document.body.style.opacity = 1;
            setupUI(user);
            loadAdminSettings();
            loadUsers();
        } else {
            document.body.innerHTML = `<div style="text-align: center; padding: 2rem;"><h2><i class="fa-solid fa-lock"></i> 存取被拒</h2><p>抱歉，只有管理員才能存取此頁面。</p><button id="btnSignOut" class="btn btn-danger">登出</button></div>`;
            $('#btnSignOut').addEventListener('click', () => signOut(auth));
            document.body.style.opacity = 1;
        }
    } else {
        window.location.href = 'login.html?redirect=admin.html';
    }
});

function setupUI(user) {
    $('#user-info').textContent = `管理員: ${user.email}`;
    $('#btnSignOut').addEventListener('click', () => signOut(auth));
    $('#btnSaveSettings').addEventListener('click', saveAdminSettings);
}

async function loadAdminSettings() {
    const settingsRef = doc(db, "settings", "admin");
    try {
        const docSnap = await getDoc(settingsRef);
        if (docSnap.exists()) {
            const settings = docSnap.data();
            $('#adminEmail1').value = settings.notificationEmails?.[0] || '';
            $('#adminEmail2').value = settings.notificationEmails?.[1] || '';
        }
    } catch(e) {
        console.error("Could not load admin settings", e);
    }
}

async function saveAdminSettings() {
    const email1 = $('#adminEmail1').value.trim();
    const email2 = $('#adminEmail2').value.trim();
    const statusEl = $('#settingsStatus');
    const btn = $('#btnSaveSettings');
    btn.disabled = true;
    statusEl.textContent = '儲存中...';
    try {
        const updateAdminSettings = httpsCallable(functions, 'updateAdminSettings');
        const result = await updateAdminSettings({ emails: [email1, email2].filter(e => e) });
        if (result.data.success) {
            statusEl.textContent = '設定已儲存！';
            setTimeout(() => statusEl.textContent = '', 3000);
        } else {
            throw new Error(result.data.error || '後端處理失敗');
        }
    } catch(error) {
        statusEl.textContent = `儲存失敗: ${error.message}`;
    } finally {
        btn.disabled = false;
    }
}

async function loadUsers() {
    const statusEl = $('#tableStatus');
    const tbody = $('#usersTbody');
    statusEl.textContent = '正在載入用戶列表...';
    tbody.innerHTML = '';
    try {
        const querySnapshot = await getDocs(collection(db, "users"));
        const users = querySnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        users.sort((a, b) => (b.registrationDate?.toMillis() || 0) - (a.registrationDate?.toMillis() || 0));
        renderTable(users);
        statusEl.textContent = `共 ${users.length} 位用戶`;
    } catch (error) {
        console.error("Error loading users:", error);
        statusEl.textContent = `載入失敗: ${error.message}`;
    }
}

function renderTable(users) {
    const tbody = $('#usersTbody');
    tbody.innerHTML = '';
    if (users.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" style="text-align: center; padding: 2rem;">目前尚無任何註冊用戶。</td></tr>';
        return;
    }
    users.forEach(user => {
        const tr = tbody.insertRow();
        const status = getStatus(user);
        tr.innerHTML = `<td>${user.email}</td><td>${formatDate(user.registrationDate)}</td><td>${formatDate(user.expires)}</td><td><span class="status-badge ${status}">${translateStatus(status)}</span></td><td id="actions-${user.id}"></td>`;
        renderActionButtons(user.id, status, user.email);
    });
}

function renderActionButtons(userId, status, email) {
    const container = $(`#actions-${userId}`);
    container.innerHTML = '';
    // Action Buttons
    if (status === 'pending') {
        const approveBtn = document.createElement('button');
        approveBtn.innerHTML = '<i class="fa-solid fa-check"></i> 批准';
        approveBtn.className = 'btn btn-success';
        approveBtn.onclick = () => updateUserStatus(userId, 'active');
        container.appendChild(approveBtn);
        const rejectBtn = document.createElement('button');
        rejectBtn.innerHTML = '<i class="fa-solid fa-ban"></i> 拒絕';
        rejectBtn.className = 'btn btn-danger';
        rejectBtn.style.marginLeft = '8px';
        rejectBtn.onclick = () => updateUserStatus(userId, 'rejected');
        container.appendChild(rejectBtn);
    } else if (['active', 'expired'].includes(status)) {
        const extendBtn = document.createElement('button');
        extendBtn.innerHTML = '<i class="fa-solid fa-calendar-plus"></i> 延長效期';
        extendBtn.className = 'btn';
        extendBtn.onclick = () => extendUserMembership(userId);
        container.appendChild(extendBtn);
    } else {
        container.innerHTML = '<span>-</span>';
    }
}

async function updateUserStatus(uid, newStatus) {
    if (!confirm(`確定要將這位用戶的狀態更新為「${translateStatus(newStatus)}」嗎？`)) return;
    const container = $(`#actions-${uid}`);
    container.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 處理中...';
    try {
        const setUserStatus = httpsCallable(functions, 'setUserStatus');
        const result = await setUserStatus({ uid, newStatus });
        if (result.data.success) {
            alert("用戶狀態已成功更新！");
            loadUsers();
        } else {
            throw new Error(result.data.error || '後端處理失敗。');
        }
    } catch (error) {
        console.error("Error updating user status:", error);
        alert(`操作失敗: ${error.message}`);
        loadUsers();
    }
}

async function extendUserMembership(uid) {
    if (!confirm(`確定要為這位用戶延長 180 天的會員資格嗎？`)) return;
    const container = $(`#actions-${uid}`);
    container.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 正在延長...';
    try {
        const extendMembership = httpsCallable(functions, 'extendMembership');
        const result = await extendMembership({ uid });
        if (result.data.success) {
            alert("會員資格已成功延長！");
            loadUsers();
        } else {
            throw new Error(result.data.error || '後端處理失敗。');
        }
    } catch (error) {
        console.error("Error extending membership:", error);
        alert(`操作失敗: ${error.message}`);
        loadUsers();
    }
}

function getStatus(user) {
    if (user.status === 'active' && user.expires && user.expires.toMillis() < Date.now()) {
        return 'expired';
    }
    return user.status;
}

function translateStatus(status) {
    const map = { pending: '待審核', active: '有效', rejected: '已拒絕', expired: '已過期' };
    return map[status] || status;
}

function formatDate(timestamp) {
    if (!timestamp) return '-';
    return timestamp.toDate().toLocaleString('zh-TW', { year: 'numeric', month: '2-digit', day: '2-digit' });
}
