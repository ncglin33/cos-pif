import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { collection, getDocs, doc, setDoc, deleteDoc, getDoc } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { auth, db } from './firebase-config.js';

const $ = id => document.getElementById(id);

// UI Elements
const tableBody = $('vendors-table-body');
const modal = $('vendor-modal');
const modalTitle = $('modal-title');
const saveVendorBtn = $('save-vendor-btn');
const vendorForm = $('vendor-form');
const taxIdInput = $('taxId');
const addVendorBtn = $('add-vendor-btn');

let userIsAdmin = false;

// --- App Initialization ---
function startApp() {
    onAuthStateChanged(auth, async (user) => {
        if (user) {
            await checkUserRole(user);
            configureUIForRole();
            loadVendors();
            setupEventListeners();
        } else {
            window.location.href = 'login.html';
        }
    });
}

async function checkUserRole(user) {
    const userDocRef = doc(db, 'users', user.uid);
    const userDocSnap = await getDoc(userDocRef);
    if (userDocSnap.exists() && userDocSnap.data().role === 'admin') {
        userIsAdmin = true;
    }
}

function configureUIForRole() {
    if (!userIsAdmin) {
        addVendorBtn.style.display = 'none';
    }
}

// --- Data Loading and Rendering ---
async function loadVendors() {
    tableBody.innerHTML = `<tr><td colspan="${userIsAdmin ? 5 : 4}" style="text-align:center; padding: 20px;">正在載入廠商資料...</td></tr>`;
    try {
        const vendorsRef = collection(db, 'vendors');
        const querySnapshot = await getDocs(vendorsRef);
        if (querySnapshot.empty) {
            tableBody.innerHTML = `<tr><td colspan="${userIsAdmin ? 5 : 4}" style="text-align:center; padding: 20px;">尚未建立任何廠商資料。</td></tr>`;
            return;
        }
        renderTable(querySnapshot.docs);
    } catch (error) {
        console.error('Error loading vendors:', error);
        tableBody.innerHTML = `<tr><td colspan="${userIsAdmin ? 5 : 4}" style="color:red; text-align:center; padding: 20px;">載入資料時發生錯誤。</td></tr>`;
    }
}

function renderTable(docs) {
    const actionsHeader = document.querySelector('th:last-child');
    if (actionsHeader) {
        actionsHeader.style.display = userIsAdmin ? '' : 'none';
    }

    tableBody.innerHTML = '';
    docs.forEach(doc => {
        const vendor = doc.data();
        const tr = document.createElement('tr');
        tr.dataset.id = doc.id;
        tr.innerHTML = `
            <td>${vendor.companyName}</td>
            <td>${doc.id}</td>
            <td>${vendor.address || ''}</td>
            <td>${vendor.phone || ''}</td>
            ${userIsAdmin ? 
                `<td class="action-buttons">
                    <button class="btn edit-btn"><i class="fa-solid fa-pencil"></i> 編輯</button>
                    <button class="btn btn-danger delete-btn"><i class="fa-solid fa-trash"></i> 刪除</button>
                </td>` : ''}
        `;
        tableBody.appendChild(tr);
    });
}

// --- Event Listeners ---
function setupEventListeners() {
    if(userIsAdmin) {
      addVendorBtn.addEventListener('click', openAddModal);
    }
    $('close-modal-btn').addEventListener('click', closeModal);
    window.addEventListener('click', e => { if (e.target === modal) closeModal(); });
    saveVendorBtn.addEventListener('click', handleFormSubmit);
    tableBody.addEventListener('click', handleTableActions);
}

function handleTableActions(e) {
    if (!userIsAdmin) return;
    const target = e.target.closest('button');
    if (!target) return;

    const tr = target.closest('tr');
    const vendorId = tr.dataset.id;

    if (target.classList.contains('edit-btn')) {
        const vendor = {
            companyName: tr.cells[0].textContent,
            address: tr.cells[2].textContent,
            phone: tr.cells[3].textContent
        };
        openEditModal(vendorId, vendor);
    } else if (target.classList.contains('delete-btn')) {
        handleDeleteVendor(vendorId, tr.cells[0].textContent);
    }
}

// --- Modal Control (Admin only) ---
function openAddModal() {
    vendorForm.reset();
    modalTitle.textContent = '新增廠商';
    $('vendor-id').value = '';
    taxIdInput.readOnly = false;
    modal.style.display = 'block';
}

function openEditModal(id, vendor) {
    vendorForm.reset();
    modalTitle.textContent = '編輯廠商';
    $('vendor-id').value = id;
    $('companyName').value = vendor.companyName;
    taxIdInput.value = id;
    taxIdInput.readOnly = true;
    $('address').value = vendor.address;
    $('phone').value = vendor.phone;
    modal.style.display = 'block';
}

function closeModal() {
    modal.style.display = 'none';
}

// --- CRUD Operations (Admin only) ---
async function handleFormSubmit() {
    if (!vendorForm.checkValidity()) {
        vendorForm.reportValidity();
        return;
    }

    const originalVendorId = $('vendor-id').value;
    const taxId = taxIdInput.value.trim();

    if (!taxId) {
        alert('統一編號為必填欄位。');
        return;
    }

    const vendorData = {
        companyName: $('companyName').value.trim(),
        address: $('address').value.trim(),
        phone: $('phone').value.trim()
    };

    saveVendorBtn.disabled = true;
    saveVendorBtn.innerHTML = '儲存中...';

    try {
        if (!originalVendorId) {
            const existingVendorRef = doc(db, 'vendors', taxId);
            const docSnap = await getDoc(existingVendorRef);
            if (docSnap.exists()) {
                alert('錯誤：此統一編號已存在。');
                return;
            }
        }

        const docRef = doc(db, 'vendors', taxId);
        await setDoc(docRef, vendorData, { merge: true });
        
        closeModal();
        loadVendors();

    } catch (error) {
        console.error('Error saving vendor:', error);
        alert('儲存廠商資料時發生錯誤。');
    } finally {
        saveVendorBtn.disabled = false;
        saveVendorBtn.innerHTML = '儲存';
    }
}

async function handleDeleteVendor(vendorId, companyName) {
    if (!confirm(`確定要刪除廠商「${companyName}」(${vendorId}) 嗎？此操作無法復原。`)) {
        return;
    }

    try {
        const docRef = doc(db, 'vendors', vendorId);
        await deleteDoc(docRef);
        loadVendors();
    } catch (error) {
        console.error('Error deleting vendor:', error);
        alert('刪除廠商時發生錯誤。');
    }
}

startApp();
