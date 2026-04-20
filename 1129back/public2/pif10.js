// Import Firebase modules
import { initializeApp } from "https://www.gstatic.com/firebasejs/9.22.1/firebase-app.js";
// Note: getFunctions and httpsCallable are no longer needed for this specific function call

// --- Firebase Configuration & Initialization ---
const firebaseConfig = {
    apiKey: "AIzaSyCwlaU1as4KQQABJYCfudKCwUt38TbaNek",
    authDomain: "my-pif-64857823-900de.firebaseapp.com",
    projectId: "my-pif-64857823-900de",
    storageBucket: "my-pif-64857823-900de.appspot.com",
    messagingSenderId: "143235873399",
    appId: "1:143235873399:web:536efc772d9c29706c6472"
};

const app = initializeApp(firebaseConfig);

// --- MODIFIED: Switched to use fetch for the onRequest function ---
const getCosmeticToxicsUrl = `https://us-central1-my-pif-64857823-900de.cloudfunctions.net/getCosmeticToxics`;

document.addEventListener('DOMContentLoaded', () => {
    const searchButton = document.getElementById('search-button');
    const searchInput = document.getElementById('search-input');
    const collectionSelect = document.getElementById('collection-select');
    const resultsMessage = document.getElementById('results-message');
    const resultsTableWrapper = document.getElementById('results-table-wrapper');

    if (!searchButton) {
        console.error("Search button not found.");
        return;
    }

    const performSearch = () => {
        const query = searchInput.value.trim();
        const collection = collectionSelect.value;

        if (!query) {
            resultsMessage.textContent = '請輸入查詢關鍵字。';
            resultsTableWrapper.innerHTML = '';
            return;
        }

        resultsMessage.textContent = '正在查詢中，請稍候...';
        resultsTableWrapper.innerHTML = '';
        searchButton.disabled = true;

        // Using fetch to call the HTTP onRequest function
        fetch(getCosmeticToxicsUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ 
                data: { q: query, collection: collection, limit: 50 } 
            })
        })
        .then(response => {
            if (!response.ok) {
                // If server responds with a non-2xx status, throw an error
                throw new Error(`伺服器錯誤: ${response.statusText}`);
            }
            return response.json();
        })
        .then(result => {
            // The actual data is nested under a 'data' property in the response
            const { success, items, total, error } = result.data;
            if (success) {
                resultsMessage.textContent = `查詢完成，找到 ${total || items.length} 筆結果。`;
                renderResults(items);
            } else {
                throw new Error(error || '後端回傳失敗，但未提供錯誤訊息。');
            }
        })
        .catch(error => {
            console.error('Error calling getCosmeticToxics function:', error);
            resultsMessage.textContent = `查詢失敗: ${error.message}`;
        })
        .finally(() => {
            searchButton.disabled = false;
        });
    };

    searchButton.addEventListener('click', performSearch);
    searchInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            performSearch();
        }
    });

    function renderResults(items) {
        if (!items || items.length === 0) {
            resultsTableWrapper.innerHTML = '<p>沒有找到符合條件的資料。</p>';
            return;
        }

        const table = document.createElement('table');
        table.className = 'results-table';

        const thead = document.createElement('thead');
        thead.innerHTML = `
            <tr>
                <th>INCI Name</th>
                <th>中文名稱</th>
                <th>CAS No.</th>
                <th>主要功能</th>
                <th>GHS-H</th>
                <th>NOAEL</th>
            </tr>
        `;
        table.appendChild(thead);

        const tbody = document.createElement('tbody');
        items.forEach(item => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td>${item.inci || ''}</td>
                <td>${item.chinese_name || ''}</td>
                <td>${item.cas || ''}</td>
                <td>${item.function || ''}</td>
                <td>${item.ghs_h || ''}</td>
                <td>${item.noael !== null ? item.noael : ''}</td>
            `;
            tbody.appendChild(tr);
        });
        table.appendChild(tbody);

        resultsTableWrapper.innerHTML = '';
        resultsTableWrapper.appendChild(table);
    }
});
