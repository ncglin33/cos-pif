// This file is now fully independent and has no external imports.

const pifNavTemplate = document.createElement('template');
pifNavTemplate.innerHTML = `
  <style>
    .pif-nav {
      background-color: #ffffff;
      padding: 12px 20px;
      border-bottom: 1px solid #e5e7eb;
      display: flex;
      flex-wrap: wrap;
      gap: 8px 12px;
      align-items: center;
    }
    .pif-nav a {
      color: #6d28d9; /* Dark Purple for contrast */
      background-color: #ffcad4; /* Light Pink */
      text-decoration: none;
      font-size: 14px;
      font-weight: 500;
      padding: 6px 12px;
      border-radius: 16px;
      transition: all 0.3s ease;
    }
    .pif-nav a:hover {
      background-color: #f4acb7; /* Darker Pink */
      color: #4c1d95;
    }
    .pif-nav a.active {
      background-color: #f72585; /* Hot Pink (桃紅) */
      color: #ffffff; /* White text for contrast */
      font-weight: 600;
    }
  </style>
  <nav class="pif-nav"></nav>
`;

class PifNav extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.shadowRoot.appendChild(pifNavTemplate.content.cloneNode(true));
    this.nav = this.shadowRoot.querySelector('.pif-nav');
  }

  connectedCallback() {
    this.render();
  }

  render() {
    const params = new URLSearchParams(window.location.search);
    const queryString = params.toString();

    if (!queryString) {
        this.nav.style.display = 'none';
        return;
    }

    const pifLinks = [
      { text: 'PIF 01', href: 'pif01.html' },
      { text: 'PIF 02', href: 'pif02.html' },
      { text: 'PIF 03', href: 'pif03.html' },
      { text: 'PIF 04', href: 'pif04.html' },
      { text: 'PIF 05', href: 'pif05.html' },
      { text: 'PIF 06', href: 'pif06.html' },
      { text: 'PIF 07', href: 'pif07.html' },
      { text: 'PIF 08', href: 'pif08.html' },
      { text: 'PIF 09', href: 'pif09.html' },
      { text: 'PIF 09-2', href: 'pif09-2.html' },
      { text: 'PIF 10', href: 'pif10.html' },
      { text: 'PIF 11', href: 'pif11.html' },
      { text: 'PIF 12', href: 'pif12.html' },
      { text: 'PIF 13', href: 'pif13.html' },
      { text: 'PIF 14', href: 'pif14.html' },
      { text: 'PIF 15', href: 'pif15.html' },
      { text: 'PIF 16', href: 'pif16.html' },
    ];

    const links = [
        { href: `./pifs.html?${queryString}`, text: 'PIF 總表' },
        ...pifLinks.map(p => ({ text: p.text, href: `./${p.href}?${queryString}`}))
    ];

    this.nav.innerHTML = links.map(link => `<a href="${link.href}">${link.text}</a>`).join('');

    const currentPage = window.location.pathname.split('/').pop();
    this.shadowRoot.querySelectorAll('a').forEach(link => {
      const linkPage = new URL(link.href).pathname.split('/').pop();
      if (linkPage === currentPage) {
        link.classList.add('active');
      }
    });
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
