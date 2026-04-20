const pifNavTemplate = document.createElement('template');
pifNavTemplate.innerHTML = `
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.2/css/all.min.css">
  <style>
    .pif-nav {
      background-color: #FFFBFB; /* Very light pink background */
      padding: 12px 24px;
      border-bottom: 1px solid #e5e7eb;
      display: flex;
      flex-wrap: wrap;
      gap: 1.5rem;
      align-items: center;
      justify-content: space-between;
    }
    .nav-left, .nav-right {
      display: flex;
      align-items: center;
      gap: 1rem; /* Adjusted gap for more items */
    }
    .logo-container {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      text-decoration: none;
    }
    .logo-container i {
      font-size: 2rem;
      color: #6d28d9; /* Purple Icon */
    }
    .logo-text-wrapper {
      display: flex;
      flex-direction: column;
    }
    .logo-text {
      font-size: 1.25rem;
      font-weight: 700;
      line-height: 1.2;
      color: #6d28d9; /* Purple Text */
    }
    .nav-title {
      font-size: 0.9rem;
      color: #6c757d;
      font-weight: 400;
    }
    .pif-nav-master, .pif-nav-secondary {
      text-decoration: none;
      font-size: 14px;
      font-weight: 500;
      padding: 8px 14px;
      border-radius: 6px;
      transition: all 0.2s ease;
      white-space: nowrap;
      border: 1px solid transparent;
    }
    .pif-nav-master {
      color: #ffffff;
      background-color: #6d28d9;
      border-color: #6d28d9;
    }
    .pif-nav-master:hover {
      background-color: #5b21b6;
      border-color: #5b21b6;
    }
    .pif-nav-secondary {
      color: #6d28d9;
      background-color: #fff;
      border-color: #6d28d9;
    }
    .pif-nav-secondary:hover {
      background-color: #f0e6ff;
      color: #5b21b6;
    }
    .pif-nav-select {
      font-size: 14px;
      padding: 7px 12px;
      border-radius: 6px;
      border: 1px solid #ced4da;
      background-color: #fff;
      cursor: pointer;
      max-width: 250px;
    }
    .pif-nav-select:focus {
      outline: none;
      border-color: #80bdff;
      box-shadow: 0 0 0 0.2rem rgba(0,123,255,.25);
    }

    @media print {
        .pif-nav {
            background: transparent !important;
            border: none !important;
            padding: 0 0 1rem 0 !important;
            box-shadow: none !important;
            justify-content: flex-start !important; /* Align logo to the left */
        }
        .nav-right {
            display: none !important;
        }
        .logo-container i, .logo-text {
            color: #000 !important; /* Black for printing */
        }
        .nav-title {
            color: #333 !important;
        }
    }
  </style>
  <nav class="pif-nav">
    <div class="nav-left">
      <a href="/index.html" class="logo-container">
        <i class="fa-solid fa-shield-halved"></i>
        <div class="logo-text-wrapper">
          <span class="logo-text">CosPIF</span>
          <span class="nav-title">智慧科技整合系統</span>
        </div>
      </a>
    </div>
    <div class="nav-right">
      <a href="./pif-i.html" class="pif-nav-secondary">PIF文件櫃</a>
      <a id="pif-master-link" class="pif-nav-master">本專案PIF總表</a>
      <select id="pif-dropdown" class="pif-nav-select"></select>
    </div>
  </nav>
`;

class PifNav extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.shadowRoot.appendChild(pifNavTemplate.content.cloneNode(true));
    this.nav = this.shadowRoot.querySelector('.pif-nav');
    this.dropdown = this.shadowRoot.querySelector('#pif-dropdown');
  }

  connectedCallback() {
    this.render();
  }

  render() {
    const params = new URLSearchParams(window.location.search);
    const queryString = params.toString();

    // Always display pif-nav unless explicitly told not to.
    // The logic to hide it on non-pif pages will be handled by observing the URL.
    if (!queryString && !window.location.pathname.endsWith('pifs.html')) {
        // Instead of hiding the whole component, we just ensure it doesn't render dropdowns etc.
        // The print styles will still apply if a user tries to print from a non-pif page.
    } else {
        this.style.display = 'block'; // Ensure it is visible on PIF pages
    }

    
    const masterLink = this.shadowRoot.querySelector('#pif-master-link');
    if (masterLink) {
        masterLink.href = `./pifs.html?${queryString}`;
        if (window.location.pathname.endsWith('pifs.html')) {
            masterLink.style.display = 'none';
        }
    }

    const pifLinks = [
        { text: 'PIF 01 - 產品基本資料', href: 'pif01.html' },
        { text: 'PIF 02 - 產品登錄證明', href: 'pif02.html' },
        { text: 'PIF 03 - 全成分名稱及其各別含量', href: 'pif03.html' },
        { text: 'PIF 04 - 產品標籤、仿單、外包裝或容器', href: 'pif04.html' },
        { text: 'PIF 05 - GMP 證明文件', href: 'pif05.html' },
        { text: 'PIF 06 - 製造方法與流程', href: 'pif06.html' },
        { text: 'PIF 07 - 使用方法、部位、用量、頻率及族群', href: 'pif07.html' },
        { text: 'PIF 08 - 產品使用不良反應資料', href: 'pif08.html' },
        { text: 'PIF 09-1 - 產品之物理及化學特性', href: 'pif09-1.html' },
        { text: 'PIF 09-2 - 各成分之物理及化學特性', href: 'pif09-2.html' },
        { text: 'PIF 10 - 各成分之毒理學資料', href: 'pif10.html' },
        { text: 'PIF 11 - 產品安定性試驗報告', href: 'pif11.html' },
        { text: 'PIF 12 - 微生物檢測報告', href: 'pif12.html' },
        { text: 'PIF 13 - 防腐效能試驗報告', href: 'pif13.html' },
        { text: 'PIF 14 - 功能評估佐證資料', href: 'pif14.html' },
        { text: 'PIF 15 - 包裝材質資料', href: 'pif15.html' },
        { text: 'PIF 16 - 產品安全資料', href: 'pif16.html' }
    ];
    
    if (this.dropdown) {
        this.dropdown.innerHTML = `<option value="">— 前往其他 PIF 文件 —</option>`;
        pifLinks.forEach(link => {
            const option = document.createElement('option');
            option.value = `./${link.href}?${queryString}`;
            option.textContent = link.text;
            this.dropdown.appendChild(option);
        });

        const currentPage = window.location.pathname.split('/').pop();
        const currentOption = Array.from(this.dropdown.options).find(opt => opt.value.includes(currentPage));

        if (currentOption) {
            currentOption.selected = true;
        }

        this.dropdown.addEventListener('change', (e) => {
          if (e.target.value) {
            window.location.href = e.target.value;
          }
        });
    }
  }
}


const topBarTemplate = document.createElement('template');
topBarTemplate.innerHTML = `
  <style>
    .top-bar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 8px 20px;
      background-color: #f8f9fa;
      border-bottom: 1px solid #dee2e6;
      font-size: 14px;
    }
    .pif-info span {
      margin-right: 12px;
      color: #6c757d;
    }
    .pif-info #pif-product {
      font-weight: 600;
      color: #212529;
    }
    .user-info {
        display: flex;
        align-items: center;
    }
    #user-email {
      color: #343a40;
      margin-right: 12px;
    }
    #logout-btn {
      border: none;
      background: #dc3545;
      color: white;
      padding: 6px 12px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
    }
     #logout-btn:hover {
        background: #c82333;
     }
  </style>
  <div class="top-bar">
    <div class="pif-info">
      <span id="pif-company"></span>
      <strong id="pif-product"></strong>
      <span id="pif-id"></span>
      <span id="pif-page"></span>
    </div>
    <div class="user-info">
      <span id="user-email"></span>
      <button id="logout-btn">登出</button>
    </div>
  </div>
`;

class TopBar extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.shadowRoot.appendChild(topBarTemplate.content.cloneNode(true));

    this.logoutBtn = this.shadowRoot.querySelector('#logout-btn');
    
    this.logoutBtn.addEventListener('click', () => {
      this.dispatchEvent(new CustomEvent('logout-request', { bubbles: true, composed: true }));
    });
  }

  setInfo(pifId, companyName, productName, pageName) {
    this.shadowRoot.querySelector('#pif-id').textContent = pifId || '';
    this.shadowRoot.querySelector('#pif-company').textContent = companyName || '';
    this.shadowRoot.querySelector('#pif-product').textContent = productName || '';
    this.shadowRoot.querySelector('#pif-page').textContent = pageName || '';
  }

  setUser(user) {
    const userEmailEl = this.shadowRoot.querySelector('#user-email');
    if (user) {
        userEmailEl.textContent = user.email;
        this.logoutBtn.style.display = 'block';
    } else {
        userEmailEl.textContent = '尚未登入';
        this.logoutBtn.style.display = 'none';
    }
  }
}

const statusBarTemplate = document.createElement('template');
statusBarTemplate.innerHTML = `
  <style>
    .status-bar {
      position: fixed;
      bottom: -100px; /* Start hidden */
      left: 50%;
      transform: translateX(-50%);
      padding: 12px 24px;
      border-radius: 8px;
      color: white;
      font-weight: 500;
      z-index: 1000;
      transition: bottom 0.5s ease-in-out;
      box-shadow: 0 4px 6px rgba(0,0,0,0.1);
    }
    .status-bar.visible {
      bottom: 20px; /* Animate to here */
    }
    .status-bar.info { background-color: #007bff; }
    .status-bar.success { background-color: #28a745; }
    .status-bar.error { background-color: #dc3545; }
    .status-bar.loading { background-color: #6c757d; }
  </style>
  <div class="status-bar"></div>
`;

class StatusBar extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.shadowRoot.appendChild(statusBarTemplate.content.cloneNode(true));
    this.statusBar = this.shadowRoot.querySelector('.status-bar');
  }

  show(message, type = 'info', duration = 3000) {
    this.statusBar.textContent = message;
    this.statusBar.className = `status-bar ${type}`;
    this.statusBar.classList.add('visible');

    if (this.timeout) clearTimeout(this.timeout);
    
    if (duration > 0) {
      this.timeout = setTimeout(() => {
        this.hide();
      }, duration);
    }
  }

  hide() {
    this.statusBar.classList.remove('visible');
  }
}

// Define all custom elements
customElements.define('pif-nav', PifNav);
customElements.define('top-bar', TopBar);
customElements.define('status-bar', StatusBar);
