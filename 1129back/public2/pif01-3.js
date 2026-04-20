document.addEventListener('DOMContentLoaded', () => {
    // --- Firebase 初始化檢查 ---
    if (typeof firebase === 'undefined') {
        console.error("Firebase SDK not loaded. Make sure to include the Firebase scripts.");
        return;
    }
    const db = firebase.firestore();
    const storage = firebase.storage();

    // --- DOM 元素 ---
    const pifIdField = document.getElementById('pifId');
    const companyNameField = document.getElementById('companyName');
    const productNameField = document.getElementById('productName');
    const printPifInfo = document.getElementById('print-pif-info');
    const allUploadCards = document.querySelectorAll('.photo-upload-card');
    const mainGallery = document.querySelector('.gallery-grid');
    const saveButton = document.getElementById('saveButton');
    const syncStatusLight = document.querySelector('.status-light');
    const syncStatusText = document.getElementById('sync-status');
    
    let pifId = ''; // 在全域範圍內儲存 PIF ID
    let localFiles = {}; // 用於儲存本地選擇的檔案 { photoType: File }

    // --- 狀態管理 ---
    const setSyncStatus = (status, message) => {
        syncStatusLight.className = `status-light ${status}`;
        syncStatusText.textContent = message;
        if(status === 'syncing') saveButton.disabled = true;
        else saveButton.disabled = false;
    };

    // --- 核心功能 ---
    const loadDataFromUrlAndFirestore = async () => {
        document.body.style.opacity = 1; // 顯示頁面內容
        const urlParams = new URLSearchParams(window.location.search);
        pifId = urlParams.get('id') || '';
        const companyName = urlParams.get('companyName') || '';
        const productName = urlParams.get('productName') || '';

        if (!pifId) {
            console.error("PIF ID not found in URL.");
            setSyncStatus('error', '找不到 PIF ID');
            return;
        }

        // 填入頁面資訊
        pifIdField.value = pifId;
        companyNameField.value = companyName;
        productNameField.value = productName;
        printPifInfo.textContent = `PIF ID: ${pifId} / ${companyName} / ${productName}`;
        
        // 從 Firestore 載入已儲存的照片
        try {
            setSyncStatus('syncing', '讀取雲端資料...');
            const photoDocs = await db.collection('pifs').doc(pifId).collection('photos').get();
            if (!photoDocs.empty) {
                photoDocs.forEach(doc => {
                    const data = doc.data();
                    if(data.photoType && data.downloadURL) {
                        displayImage(data.photoType, data.downloadURL);
                    }
                });
            }
            setSyncStatus('synced', '已同步');
        } catch (error) {
            console.error("Error loading photos from Firestore: ", error);
            setSyncStatus('error', '讀取雲端資料失敗');
        }
    };

    const displayImage = (photoType, imageUrl, isLocal = false) => {
        // 更新上方預覽卡片
        const card = Array.from(allUploadCards).find(c => c.querySelector('.photo-type').textContent === photoType);
        if (card) {
            const previewArea = card.querySelector('.photo-preview');
            previewArea.innerHTML = '';
            const previewImg = document.createElement('img');
            previewImg.src = imageUrl;
            previewArea.appendChild(previewImg);
        }

        // 更新下方畫廊
        let galleryItem = mainGallery.querySelector(`[data-photo-type="${photoType}"]`);
        if (galleryItem) {
            galleryItem.querySelector('img').src = imageUrl;
        } else {
            galleryItem = createGalleryItem(photoType, imageUrl, isLocal);
            mainGallery.appendChild(galleryItem);
        }
    };

    const createGalleryItem = (photoType, imageUrl, isLocal) => {
        const item = document.createElement('div');
        item.className = 'gallery-item';
        item.dataset.photoType = photoType;
        item.dataset.isLocal = isLocal; // 標記是否為本地圖片

        const img = document.createElement('img');
        img.src = imageUrl;

        const label = document.createElement('div');
        label.className = 'gallery-item-label';
        label.textContent = photoType;

        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'gallery-item-delete no-print';
        deleteBtn.innerHTML = '<i class="fas fa-times"></i>';
        deleteBtn.onclick = async () => {
            // 如果是雲端圖片，需要從雲端刪除
            if (!isLocal) {
                setSyncStatus('syncing', '刪除中...');
                try {
                    // 從 Firestore 刪除記錄
                    await db.collection('pifs').doc(pifId).collection('photos').doc(photoType).delete();
                    // 從 Storage 刪除檔案 (可選)
                    const storageRef = storage.ref(`pifs/${pifId}/${photoType}.jpg`);
                    await storageRef.delete();
                    setSyncStatus('synced', '刪除成功');
                } catch (error) {
                    console.error("Error deleting photo from cloud:", error);
                    setSyncStatus('error', '刪除失敗');
                }
            }
            item.remove(); // 從 DOM 移除
            // 清空對應的本地檔案記錄和預覽
            delete localFiles[photoType];
            const card = Array.from(allUploadCards).find(c => c.querySelector('.photo-type').textContent === photoType);
            if (card) {
                card.querySelector('.photo-preview').innerHTML = '<i class="fas fa-image icon"></i>';
            }
        };
        
        item.append(img, label, deleteBtn);
        return item;
    };

    const handleSave = async () => {
        if (!pifId) return alert("PIF ID 不存在，無法儲存。");
        const filesToUpload = Object.entries(localFiles);
        if (filesToUpload.length === 0) return alert("沒有新的圖片需要儲存。");

        setSyncStatus('syncing', `正在上傳 ${filesToUpload.length} 張圖片...`);

        for (const [photoType, file] of filesToUpload) {
            try {
                const filePath = `pifs/${pifId}/${photoType}.jpg`;
                const storageRef = storage.ref(filePath);
                const uploadTask = await storageRef.put(file);
                const downloadURL = await uploadTask.ref.getDownloadURL();

                await db.collection('pifs').doc(pifId).collection('photos').doc(photoType).set({
                    photoType: photoType,
                    fileName: file.name,
                    downloadURL: downloadURL,
                    uploadedAt: firebase.firestore.FieldValue.serverTimestamp()
                });
                
                // 上傳成功後，從待上傳列表中移除
                delete localFiles[photoType];
                const galleryItem = mainGallery.querySelector(`[data-photo-type="${photoType}"]`);
                if (galleryItem) galleryItem.dataset.isLocal = false; // 更新為非本地狀態

            } catch (error) {
                console.error(`Error uploading ${photoType}:`, error);
                setSyncStatus('error', `上傳 ${photoType} 失敗`);
                return; // 中斷上傳流程
            }
        }

        setSyncStatus('synced', '所有變更已同步');
    };

    // --- 事件綁定 ---
    allUploadCards.forEach(card => {
        const button = card.querySelector('button');
        const photoTypeLabel = card.querySelector('.photo-type').textContent;
        const hiddenInput = document.createElement('input');
        hiddenInput.type = 'file';
        hiddenInput.accept = 'image/*';
        hiddenInput.style.display = 'none';
        card.appendChild(hiddenInput);

        button.addEventListener('click', () => hiddenInput.click());

        hiddenInput.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (!file) return;
            localFiles[photoTypeLabel] = file; // 存入待上傳列表
            const imageUrl = URL.createObjectURL(file);
            displayImage(photoTypeLabel, imageUrl, true); // 顯示本地圖片
            setSyncStatus('', '有未儲存的變更'); // 提示用戶儲存
        });
    });

    saveButton.addEventListener('click', handleSave);

    // --- 啟動 ---
    loadDataFromUrlAndFirestore();
});
