import { auth, db } from './firebase-config.js';
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { collection, query, where, getDocs, doc, getDoc, deleteDoc, orderBy } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

document.addEventListener('DOMContentLoaded', () => {
    // --- DOM Element Selection ---
    const welcomeMessage = document.getElementById('welcome-message');
    const statsContainer = document.getElementById('stats-container');
    const searchInput = document.getElementById('search-input');
    const pifListContainer = document.getElementById('pif-list-container');
    const logoutBtn = document.getElementById('logout-btn');

    let allPifs = []; // Local cache for search functionality

    // --- Authentication State Observer ---
    onAuthStateChanged(auth, async (user) => {
        if (user) {
            // User is signed in, start loading the dashboard data
            pifListContainer.innerHTML = `<div class="loading-state"><h3><i class="fa-solid fa-spinner fa-spin"></i> 正在載入您的儀表板...</h3></div>`;
            await loadDashboard(user);
        } else {
            // User is not signed in, redirect to the login page
            window.location.href = 'login.html';
        }
    });

    // --- Main Dashboard Loading Function ---
    async function loadDashboard(user) {
        try {
            // Fetch user data and their PIF documents concurrently for better performance
            const [userDoc, pifDocs] = await Promise.all([
                getDoc(doc(db, "users", user.uid)),
                getDocs(query(collection(db, "pifs"), where("ownerId", "==", user.uid), orderBy("createdAt", "desc")))
            ]);

            allPifs = pifDocs.docs.map(doc => ({ id: doc.id, ...doc.data() }));
            const userData = userDoc.exists() ? userDoc.data() : { email: user.email };

            // Render all parts of the dashboard
            displayWelcomeMessage(userData);
            renderStats(allPifs);
            renderPifList(allPifs);
            setupEventListeners(); // Setup event listeners after initial render

        } catch (error) {
            console.error("儀表板載入失敗: ", error);
            pifListContainer.innerHTML = `<div class="empty-state"><h3><i class="fa-solid fa-exclamation-triangle"></i> 載入儀表板時發生錯誤</h3><p>請檢查您的網路連線或稍後再試。錯誤訊息: ${error.message}</p></div>`;
        }
    }

    // --- UI Rendering Functions ---
    function displayWelcomeMessage(userData) {
        const displayName = userData?.name || userData?.email || '使用者';
        welcomeMessage.textContent = `歡迎回來, ${displayName}！`;
    }

    function renderStats(pifs) {
        const totalProjects = pifs.length;
        statsContainer.innerHTML = `
            <div class="stat-card">
                <i class="fa-solid fa-folder-open"></i>
                <div class="stat-info">
                    <div class="value">${totalProjects}</div>
                    <div class="label">專案總數</div>
                </div>
            </div>`;
    }

    function renderPifList(pifs) {
        pifListContainer.innerHTML = ''; // Clear previous content
        if (pifs.length === 0) {
            pifListContainer.innerHTML = `
                <div class="empty-state">
                    <i class="fa-solid fa-box-open empty-icon"></i>
                    <h3>您還沒有任何 PIF 專案</h3>
                    <p>點擊右上角的「建立新的 PIF」來開始您的第一個專案吧！</p>
                </div>`;
            return;
        }

        pifs.forEach(pif => {
            const pifCard = createPifCard(pif);
            pifListContainer.appendChild(pifCard);
        });
    }

    function createPifCard(pif) {
        const card = document.createElement('div');
        card.className = 'pif-card';
        card.dataset.id = pif.id;

        const status = pif.status || '草稿';
        const statusClass = status === '已完成' ? 'status-completed' : 'status-draft';
        const creationDate = pif.createdAt?.seconds ? new Date(pif.createdAt.seconds * 1000).toLocaleDateString() : '未知';

        // Encode data for URL
        const companyNameEncoded = encodeURIComponent(pif.companyName || '');
        const productNameEncoded = encodeURIComponent(pif.productName || '');

        card.innerHTML = `
            <div class="pif-status ${statusClass}">${status}</div>
            <div class="pif-card-content">
                <div class="pif-card-header">
                    <h3>${pif.productName || '未命名產品'}</h3>
                    <p><strong>公司:</strong> ${pif.companyName || '未提供'}</p>
                </div>
                <div class="pif-card-body">
                    <p><i class="fa-solid fa-calendar-alt fa-fw"></i> <strong>建立日期:</strong> ${creationDate}</p>
                    <p><i class="fa-solid fa-user-tie fa-fw"></i> <strong>聯絡人:</strong> ${pif.contactPerson || '未提供'}</p>
                </div>
            </div>
            <div class="pif-card-footer">
                <a href="pifs.html?id=${pif.id}&companyName=${companyNameEncoded}&productName=${productNameEncoded}" class="btn btn-primary btn-sm start-pif-btn"><i class="fa-solid fa-file-signature"></i> 開始製作 PIF</a>
                <button class="btn btn-secondary btn-sm edit-btn"><i class="fa-solid fa-pen-to-square"></i> 編輯</button>
                <button class="btn btn-danger btn-sm delete-btn"><i class="fa-solid fa-trash"></i> 刪除</button>
            </div>
        `;
        return card;
    }

    // --- Event Listener Setup ---
    function setupEventListeners() {
        // Search functionality
        searchInput.addEventListener('input', (e) => {
            const searchTerm = e.target.value.toLowerCase();
            const filteredPifs = allPifs.filter(pif => 
                pif.productName?.toLowerCase().includes(searchTerm) ||
                pif.companyName?.toLowerCase().includes(searchTerm)
            );
            renderPifList(filteredPifs);
        });

        // Logout button
        logoutBtn.addEventListener('click', async () => {
            if(confirm('您確定要登出嗎？')){
                try {
                    await signOut(auth);
                    window.location.href = 'login.html';
                } catch (error) {
                    console.error('登出失敗', error);
                    alert('登出時發生錯誤，請稍後再試。');
                }
            }
        });

        // Event delegation for Edit and Delete buttons
        pifListContainer.addEventListener('click', async (e) => {
            // We are using a link for "Start PIF", so we only need to handle buttons
            const button = e.target.closest('button');
            if (!button) return;

            const card = button.closest('.pif-card');
            const pifId = card.dataset.id;

            if (button.classList.contains('delete-btn')) {
                if (confirm(`您確定要永久刪除「${card.querySelector('h3').textContent}」這個專案嗎？此操作無法復原。`)) {
                    try {
                        card.style.opacity = '0.5'; // Visual feedback
                        await deleteDoc(doc(db, "pifs", pifId));
                        // Remove from UI and update stats
                        allPifs = allPifs.filter(pif => pif.id !== pifId);
                        renderStats(allPifs);
                        renderPifList(allPifs); // Re-render the list
                    } catch (error) {
                        console.error("刪除 PIF 失敗: ", error);
                        alert("刪除失敗，請檢查您的權限或稍後再試。");
                        card.style.opacity = '1'; // Restore visual on failure
                    }
                }
            }

            if (button.classList.contains('edit-btn')) {
                window.location.href = `pif_edit.html?id=${pifId}`;
            }
        });
    }
});
