
//
// 這是在 COS-PIF 專案中使用的「跨網域權限守衛」。
// 它的唯一工作，就是向 my-PIF 的「認證橋樑」確認用戶是否已登入。
//

// 您的中央認證中心 (my-PIF) 的網址
const AUTH_CENTER_URL = 'https://my-pif-64857823-900de.web.app';
const LOGIN_PAGE_URL = `${AUTH_CENTER_URL}/login.html`;

// 為了防止頁面內容在驗證完成前閃現，我們先將整個頁面設為不透明
document.documentElement.style.opacity = '0';
document.documentElement.style.transition = 'opacity 0.5s';

// 建立一個隱藏的 <iframe>，用它來和「認證橋樑」進行秘密通訊
const iframe = document.createElement('iframe');
iframe.style.display = 'none';
iframe.src = `${AUTH_CENTER_URL}/auth-bridge.html`;
document.body.appendChild(iframe);

// 設置一個超時，以防萬一認證橋樑沒有回應
const authTimeout = setTimeout(() => {
    console.error('認證超時！無法確認登入狀態，將重新導向至登入頁。');
    window.location.href = LOGIN_PAGE_URL;
}, 8000); // 8 秒後超時

// 監聽來自 <iframe> 的訊息
window.addEventListener('message', (event) => {
    // 安全性檢查：只接受來自中央認證中心網域的訊息
    if (event.origin !== AUTH_CENTER_URL) {
        return;
    }

    const { status } = event.data;

    if (status === 'loggedIn') {
        // 確認已登入！
        clearTimeout(authTimeout); // 取消超時
        console.log('COS-PIF 守衛：存取已授權。用戶已登入。');
        // 讓頁面平滑地顯示出來
        document.documentElement.style.opacity = '1';
    } else {
        // 確認未登入，重新導向至中央登入頁面
        console.log('COS-PIF 守衛：存取被拒絕。將重新導向至登入頁。');
        window.location.href = LOGIN_PAGE_URL;
    }
}, false);
