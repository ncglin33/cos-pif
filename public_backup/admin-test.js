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
        window.location.href = 'login.html?redirect=admin-test.html';
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
        tbody.innerHTML = '<tr><td colspan="8" style="text-align: center; padding: 2rem;">目前尚無任何註冊用戶。</td></tr>';
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
                        <td id="membership-actions-${user.id}"></td>
                        <td id="permission-actions-${user.id}"></td>`;
        // Normalize action cell IDs into the last two columns (prevents column shift / rendering issues)
        const _tds = tr.querySelectorAll('td');
        if (_tds.length >= 2) {
            const _memberTd = _tds[_tds.length - 2];
            const _permTd = _tds[_tds.length - 1];
            const _mid = `membership-actions-${user.id}`;
            const _pid = `permission-actions-${user.id}`;
            _tds.forEach(td => {
                if (td.id === _mid && td !== _memberTd) td.removeAttribute('id');
                if (td.id === _pid && td !== _permTd) td.removeAttribute('id');
            });
            _memberTd.id = _mid;
            _permTd.id = _pid;
        }
        renderActionButtons(user, status);
    });
}

function renderActionButtons(user, status) {
    const userId = user.id;
    const email = user.email;
    const membershipContainer = document.getElementById(`membership-actions-${userId}`);
    const permissionContainer = document.getElementById(`permission-actions-${userId}`);
    if (!membershipContainer || !permissionContainer) {
        console.warn('Action containers not found for', userId);
        return;
    }

    membershipContainer.classList.add('action-cell');
    permissionContainer.classList.add('action-cell');
    membershipContainer.innerHTML = '';
    permissionContainer.innerHTML = '';

    // 會員操作：只保留延長（讓「核准/拒絕」固定顯示在最後一欄，避免左右捲動時找不到）
    if (['active', 'expired'].includes(status)) {
        const extendBtn = document.createElement('button');
        extendBtn.innerHTML = '<i class="fa-solid fa-calendar-plus"></i> extend 180d';
        extendBtn.className = 'btn btn-outline-primary role-mini';
        extendBtn.onclick = () => extendUserMembership(userId);
        membershipContainer.appendChild(extendBtn);
    } else {
        membershipContainer.innerHTML = '<span>-</span>';
    }

    // 權限管理（永遠顯示）
    const adminBtn = document.createElement('button');
    adminBtn.innerHTML = '<i class="fa-solid fa-user-shield"></i> admin';
    adminBtn.className = 'btn btn-warning role-mini';
    adminBtn.onclick = () => grantAdmin(userId, email);
    permissionContainer.appendChild(adminBtn);

    const clientBtn = document.createElement('button');
    clientBtn.innerHTML = '<i class="fa-solid fa-user-tag"></i> client';
    clientBtn.className = 'btn role-mini';
    clientBtn.style.backgroundColor = '#64748b';
    clientBtn.style.color = 'white';
    clientBtn.onclick = () => grantClient(userId, email);
    permissionContainer.appendChild(clientBtn);

    const userBtn = document.createElement('button');
    userBtn.innerHTML = '<i class="fa-solid fa-user"></i> user';
    userBtn.className = 'btn role-mini';
    userBtn.style.backgroundColor = '#0ea5e9';
    userBtn.style.color = 'white';
    userBtn.onclick = () => setUserRole(userId, email);
    permissionContainer.appendChild(userBtn);

    // ✅ 核准 / 拒絕：固定附加在「最後一欄」(權限管理欄) 的最後面，隨時可見
    const approveBtn = document.createElement('button');
    approveBtn.innerHTML = '<i class="fa-solid fa-check"></i> Approve';
    approveBtn.className = 'btn btn-success role-mini';
    approveBtn.disabled = (status === 'active');
    approveBtn.onclick = () => updateUserStatus(userId, 'active');
    permissionContainer.appendChild(approveBtn);

    const rejectBtn = document.createElement('button');
    rejectBtn.innerHTML = '<i class="fa-solid fa-ban"></i> Reject';
    rejectBtn.className = 'btn btn-danger role-mini';
    rejectBtn.disabled = (status === 'rejected');
    rejectBtn.onclick = () => updateUserStatus(userId, 'rejected');
    permissionContainer.appendChild(rejectBtn);
}

async function updateUserStatus(uid, newStatus) {
    if (!confirm(`確定要將這位用戶的狀態更新為「${translateStatus(newStatus)}」嗎？`)) return;
    const container = document.getElementById(`permission-actions-${uid}`) || document.getElementById(`membership-actions-${uid}`);
    if (container) container.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 處理中...';
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
    const container = document.getElementById(`membership-actions-${uid}`);
    if (!container) return;
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

async function grantAdmin(uid, email) {
    if (!confirm(`您確定要將用戶 ${email} 提升為管理員嗎？\n\n此操作將給予該用戶完整的後台存取權限。`)) return;

    const container = document.getElementById(`permission-actions-${uid}`);
    if (!container) return;
    container.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 正在授權...';

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

    const container = document.getElementById(`permission-actions-${uid}`);
    if (!container) return;
    container.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 正在設定...';

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

    const container = document.getElementById(`permission-actions-${uid}`);
    if (!container) return;
    container.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 正在設定...';

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
