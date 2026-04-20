import { onAuthStateChanged, signOut, getIdTokenResult } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";
import { httpsCallable } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-functions.js";
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
            if (settings && settings.notificationEmails && Array.isArray(settings.notificationEmails)) {
                document.getElementById('adminEmail1').value = settings.notificationEmails[0] || '';
                document.getElementById('adminEmail2').value = settings.notificationEmails[1] || '';
                const adminEmail3El = document.getElementById('adminEmail3');
                if (adminEmail3El) adminEmail3El.value = settings.notificationEmails[2] || '';
            }
        } else {
            console.log("Admin settings document does not exist.");
        }
    } catch(e) {
        console.error("Could not load admin settings", e);
    }
}

async function saveAdminSettings() {
    const email1 = $('#adminEmail1').value.trim();
    const email2 = $('#adminEmail2').value.trim();
    const email3El = $('#adminEmail3');
    const email3 = email3El ? email3El.value.trim() : '';
    const statusEl = $('#settingsStatus');
    const btn = $('#btnSaveSettings');
    btn.disabled = true;
    statusEl.textContent = '儲存中...';
    try {
        const updateAdminSettings = httpsCallable(functions, 'updateAdminSettings');
        const result = await updateAdminSettings({ emails: [email1, email2, email3].filter(e => e) });
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
        const listUsersWithClaims = httpsCallable(functions, 'listUsersWithClaims');
        const result = await listUsersWithClaims();
        if (result.data.success) {
            const users = result.data.users;
            users.forEach(u => {
                // 盡量從多種可能欄位推斷註冊日期（避免後端欄位名稱不同而顯示 '-'）
                u.registrationDate = parseDateLike(
                    u.registrationDate ??
                    u.createdAt ??
                    u.created_at ??
                    u.creationTime ??
                    u.createdTime ??
                    u.authCreationTime ??
                    (u.metadata && (u.metadata.creationTime || u.metadata.creation_time)) ??
                    u.created ??
                    null
                );

                // 到期日（支援 Firestore Timestamp / number / string）
                u.expires = parseDateLike(u.expires);
            });
            users.sort((a, b) => (b.registrationDate?.getTime?.() || 0) - (a.registrationDate?.getTime?.() || 0));
 renderTable(users);
            statusEl.textContent = `共 ${users.length} 位用戶`;
        } else {
            throw new Error(result.data.error || '無法載入使用者列表');
        }
    } catch (error) {
        console.error("Error loading users:", error);
        statusEl.textContent = `載入失敗: ${error.message}`;
    }
}

function renderTable(users) {
    const tbody = $('#usersTbody');
    tbody.innerHTML = '';
    if (users.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; padding: 2rem;">目前尚無任何註冊用戶。</td></tr>';
        return;
    }
    users.forEach(user => {
        const tr = tbody.insertRow();
        const { status, role } = getStatusAndRole(user);
        tr.innerHTML = `<td>${user.company || ''}</td>
                        <td>${user.name || ''}</td>
                        <td>${user.email}</td>
                        <td>${formatDate(user.registrationDate)}</td>
                        <td>${formatDate(user.expires)}</td>
                        <td>
                            <span class="status-badge ${status}">${translateStatus(status)}</span>
                            ${role ? `<span class="role-badge ${role.toLowerCase()}">${role}</span>` : ''}
                        </td>
                        <td id="actions-${user.id}" class="action-cell combined-actions"></td>`;
        // Normalize action cell ID into the last column (prevents column shift / rendering issues)
        const _tds = tr.querySelectorAll('td');
        if (_tds.length >= 1) {
            const _actionTd = _tds[_tds.length - 1];
            const _aid = `actions-${user.id}`;
            _tds.forEach(td => {
                if (td.id === _aid && td !== _actionTd) td.removeAttribute('id');
            });
            _actionTd.id = _aid;
            _actionTd.classList.add('action-cell', 'combined-actions');
        }
        renderActionButtons(user, status);
    });
}

function renderActionButtons(user, status) {
    const userId = user.id;
    const email = user.email;
    const actionsContainer = document.getElementById(`actions-${userId}`);
    if (!actionsContainer) {
        console.warn('Action container not found for', userId);
        return;
    }

    actionsContainer.classList.add('action-cell', 'combined-actions');
    actionsContainer.innerHTML = '';

    // --- 會員操作（延長） ---
    const extendRow = document.createElement('div');
    extendRow.className = 'actions-row extend-row';

    if (['active', 'expired'].includes(status)) {
        const extendBtn = document.createElement('button');
        extendBtn.id = `extend-btn-${userId}`;
        extendBtn.innerHTML = '<i class="fa-solid fa-calendar-plus"></i> extend 180d';
        extendBtn.className = 'btn btn-outline-primary role-mini';
        extendBtn.onclick = () => extendUserMembership(userId);
        extendRow.appendChild(extendBtn);
    } else {
        extendRow.innerHTML = '<span class="text-muted">-</span>';
    }
    actionsContainer.appendChild(extendRow);

    // --- 權限管理（角色） ---
    const roleRow = document.createElement('div');
    roleRow.className = 'actions-row role-row';

    const adminBtn = document.createElement('button');
    adminBtn.id = `role-admin-btn-${userId}`;
    adminBtn.innerHTML = '<i class="fa-solid fa-user-shield"></i> admin';
    adminBtn.className = 'btn btn-warning role-mini';
    adminBtn.onclick = () => grantAdmin(userId, email);
    roleRow.appendChild(adminBtn);

    const clientBtn = document.createElement('button');
    clientBtn.id = `role-client-btn-${userId}`;
    clientBtn.innerHTML = '<i class="fa-solid fa-user-tag"></i> client';
    clientBtn.className = 'btn role-mini';
    clientBtn.style.backgroundColor = '#64748b';
    clientBtn.style.color = 'white';
    clientBtn.onclick = () => grantClient(userId, email);
    roleRow.appendChild(clientBtn);

    const userBtn = document.createElement('button');
    userBtn.id = `role-user-btn-${userId}`;
    userBtn.innerHTML = '<i class="fa-solid fa-user"></i> user';
    userBtn.className = 'btn btn-info role-mini';
    userBtn.onclick = () => setUserRole(userId, email);
    roleRow.appendChild(userBtn);

    actionsContainer.appendChild(roleRow);

    // divider（讓核准/拒絕固定視覺上在最後）
    const divider = document.createElement('div');
    divider.className = 'actions-divider';
    actionsContainer.appendChild(divider);

    // --- 註冊核准/拒絕（永遠在最後） ---
    const decisionRow = document.createElement('div');
    decisionRow.className = 'actions-row decision-row';
    decisionRow.id = `decision-row-${userId}`;

    const approveBtn = document.createElement('button');
    approveBtn.id = `approve-btn-${userId}`;
    approveBtn.innerHTML = '<i class="fa-solid fa-check"></i> Approve';
    approveBtn.className = 'btn btn-success role-mini';
    approveBtn.disabled = (status === 'active');
    approveBtn.onclick = () => updateUserStatus(userId, 'active');
    decisionRow.appendChild(approveBtn);

    const rejectBtn = document.createElement('button');
    rejectBtn.id = `reject-btn-${userId}`;
    rejectBtn.innerHTML = '<i class="fa-solid fa-ban"></i> Reject';
    rejectBtn.className = 'btn btn-danger role-mini';
    rejectBtn.disabled = (status === 'rejected');
    rejectBtn.onclick = () => updateUserStatus(userId, 'rejected');
    decisionRow.appendChild(rejectBtn);

    actionsContainer.appendChild(decisionRow);
}

async function updateUserStatus(uid, newStatus) {
    if (!confirm(`確定要將這位用戶的狀態更新為「${translateStatus(newStatus)}」嗎？`)) return;
    const approveBtn = document.getElementById(`approve-btn-${uid}`);
    const rejectBtn = document.getElementById(`reject-btn-${uid}`);
    const targetBtn = (newStatus === 'active') ? approveBtn : rejectBtn;
    const otherBtn = (newStatus === 'active') ? rejectBtn : approveBtn;
    if (targetBtn) {
        targetBtn.disabled = true;
        targetBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 處理中...';
    }
    if (otherBtn) otherBtn.disabled = true;
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
    const btn = document.getElementById(`extend-btn-${uid}`);
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 延長中...';
    }
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

async function grantAdmin(uid, email) {
    if (!confirm(`您確定要將用戶 ${email} 提升為管理員嗎？\n\n此操作將給予該用戶完整的後台存取權限。`)) return;

    // show busy state only on the role buttons (do not wipe the whole cell)
    const roleBtns = ['role-admin-btn', 'role-client-btn', 'role-user-btn'].map(p => document.getElementById(`${p}-${uid}`)).filter(Boolean);
    roleBtns.forEach(b => b.disabled = true);
    const target = document.getElementById(`role-admin-btn-${uid}`);
    if (target) target.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 授權中...';

    try {
        const grantAdminRole = httpsCallable(functions, 'grantAdminRole');
        const result = await grantAdminRole({ uid });

        if (result.data.success) {
            alert(`用戶 ${email} 已成功admin！`);
        } else {
            throw new Error(result.data.error || '後端處理失敗。');
        }
    } catch (error) {
        console.error("Error granting admin role:", error);
        alert(`操作失敗: ${error.message}`);
    } finally {
        loadUsers();
    }
}

async function grantClient(uid, email) {
    if (!confirm(`您確定要將用戶 ${email} 設為「Client」嗎？\n\n此身份將無法建立新的 PIF 文件。`)) return;

    // show busy state only on the role buttons (do not wipe the whole cell)
    const roleBtns = ['role-admin-btn', 'role-client-btn', 'role-user-btn'].map(p => document.getElementById(`${p}-${uid}`)).filter(Boolean);
    roleBtns.forEach(b => b.disabled = true);
    const target = document.getElementById(`role-client-btn-${uid}`);
    if (target) target.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 設定中...';

    try {
        const setClientRole = httpsCallable(functions, 'setClientRole');
        const result = await setClientRole({ uid });

        if (result.data.success) {
            alert(`用戶 ${email} 已成功client！`);
        } else {
            throw new Error(result.data.error || '後端處理失敗。');
        }
    } catch (error) {
        console.error("Error setting client role:", error);
        alert(`操作失敗: ${error.message}`);
    } finally {
        loadUsers(); 
    }
}

async function setUserRole(uid, email) {
    if (!confirm(`您確定要將用戶 ${email} 設為「一般使用者(User)」嗎？\n\n此身份不會被導引到 Client/後台，可用於票選等一般功能。`)) return;

    // show busy state only on the role buttons (do not wipe the whole cell)
    const roleBtns = ['role-admin-btn', 'role-client-btn', 'role-user-btn'].map(p => document.getElementById(`${p}-${uid}`)).filter(Boolean);
    roleBtns.forEach(b => b.disabled = true);
    const target = document.getElementById(`role-user-btn-${uid}`);
    if (target) target.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 設定中...';

    try {
        const fn = httpsCallable(functions, 'setUserRole');
        const result = await fn({ uid });

        if (result.data.success) {
            alert(`用戶 ${email} 已成功設為 User！`);
        } else {
            throw new Error(result.data.error || '後端處理失敗。');
        }
    } catch (error) {
        console.error("Error setting user role:", error);
        alert(`操作失敗: ${error.message}`);
    } finally {
        loadUsers();
    }
}

function getStatusAndRole(user) {
    let status = user.status;
    if (user.status === 'active' && user.expires && user.expires.getTime() < Date.now()) {
        status = 'expired';
    }

    let role = null;
    if (user.claims) {
        if (user.claims.admin) {
            role = 'Admin';
        } else if (user.claims.client) {
            role = 'Client';
        }
    }
    return { status, role };
}

function translateStatus(status) {
    const map = { pending: '待審核', active: '有效', rejected: '已拒絕', expired: '已過期' };
    return map[status] || status;
}

function parseDateLike(value) {
    if (!value) return null;

    // Already a Date
    if (value instanceof Date) {
        return isNaN(value.getTime()) ? null : value;
    }

    // Firestore Timestamp-like objects
    if (typeof value === 'object') {
        const sec = value._seconds ?? value.seconds;
        if (typeof sec === 'number') {
            const d = new Date(sec * 1000);
            return isNaN(d.getTime()) ? null : d;
        }
    }

    // Number: treat as ms if large, else seconds
    if (typeof value === 'number') {
        const ms = value > 1e12 ? value : value * 1000;
        const d = new Date(ms);
        return isNaN(d.getTime()) ? null : d;
    }

    // String (ISO / RFC / yyyy-mm-dd etc.)
    if (typeof value === 'string') {
        const d = new Date(value);
        return isNaN(d.getTime()) ? null : d;
    }

    return null;
}

function formatDate(date) {
    const d = parseDateLike(date);
    if (!d) return '-';
    return d.toLocaleDateString('zh-TW', { year: 'numeric', month: '2-digit', day: '2-digit' });
}
