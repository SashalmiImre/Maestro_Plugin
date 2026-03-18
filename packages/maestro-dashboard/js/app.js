/**
 * Maestro Dashboard — App Bootstrap
 *
 * Routing (login ↔ dashboard), adat lekérés, UI összekötés.
 */

import { checkSession, login, logout, getCurrentUser } from './auth.js';
import { initServices, fetchPublications, switchPublication, fetchAllTeamMembers, onDataChange, getPublications, getActivePublicationId } from './data.js';
import { subscribeRealtime, unsubscribeRealtime } from './realtime.js';
import { initPublicationList, renderPublicationList, getStoredPublicationId, storePublicationId } from './ui/publicationList.js';
import { renderArticleTable } from './ui/articleTable.js';
import { renderLayoutView } from './ui/layoutView.js';
import { initFilterBar, applyFilters, isFilterActive } from './ui/filterBar.js';
import { showToast, showLoading } from './ui/components.js';
import { URGENCY_REFRESH_INTERVAL_MS } from './config.js';

// ─── DOM elemek ─────────────────────────────────────────────────────────────

const loginView = document.getElementById('login-view');
const dashboardView = document.getElementById('dashboard-view');
const loginForm = document.getElementById('login-form');
const loginBtn = document.getElementById('login-btn');
const loginError = document.getElementById('login-error');
const logoutBtn = document.getElementById('logout-btn');
const userNameSpan = document.getElementById('user-name');
const contentTitle = document.getElementById('content-title');
const articleCount = document.getElementById('article-count');
const tableContainer = document.getElementById('table-container');
const layoutContainer = document.getElementById('layout-container');
const viewTableBtn = document.getElementById('view-table');
const viewLayoutBtn = document.getElementById('view-layout');

// ─── Sürgősség frissítés timer ──────────────────────────────────────────────

let urgencyInterval = null;

// ─── Aktív nézet ('table' vagy 'layout') ────────────────────────────────────

let activeView = 'table';

// ─── Nézet váltás ───────────────────────────────────────────────────────────

function showLoginView() {
    loginView.style.display = '';
    dashboardView.classList.remove('active');
    if (urgencyInterval) {
        clearInterval(urgencyInterval);
        urgencyInterval = null;
    }
}

function showDashboardView() {
    loginView.style.display = 'none';
    dashboardView.classList.add('active');
}

// ─── Login form ─────────────────────────────────────────────────────────────

loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    loginError.textContent = '';
    loginBtn.disabled = true;
    loginBtn.textContent = 'Bejelentkezés...';

    const email = document.getElementById('email').value.trim();
    const password = document.getElementById('password').value;

    try {
        await login(email, password);
        await enterDashboard();
    } catch (err) {
        const msg = err?.message || '';
        if (msg.includes('Invalid credentials') || msg.includes('Invalid email')) {
            loginError.textContent = 'Hibás email vagy jelszó.';
        } else if (msg.includes('not been verified')) {
            loginError.textContent = 'Az email cím nincs megerősítve. Ellenőrizd a postafiókodat.';
        } else {
            loginError.textContent = 'Bejelentkezési hiba. Próbáld újra később.';
        }
    } finally {
        loginBtn.disabled = false;
        loginBtn.textContent = 'Bejelentkezés';
    }
});

// ─── Logout ─────────────────────────────────────────────────────────────────

logoutBtn.addEventListener('click', async () => {
    unsubscribeRealtime();
    await logout();
    showLoginView();
});

// ─── Dashboard belépés ──────────────────────────────────────────────────────

async function enterDashboard() {
    const user = getCurrentUser();
    if (!user) return;

    // UI frissítés
    userNameSpan.textContent = user.name || user.email;
    showDashboardView();

    // Appwrite szolgáltatások inicializálása
    initServices();

    // Kiadvány lista inicializálása
    initPublicationList(handlePublicationSelect);

    // Szűrő sáv inicializálása
    initFilterBar(handleFilterChange);

    // Adat változás figyelés
    onDataChange(handleDataChange);

    // Adatok betöltése
    showLoading(tableContainer);
    try {
        const pubs = await fetchPublications();
        renderPublicationList();

        // Csapattagok lekérése (háttérben, lock nevek feloldásához)
        fetchAllTeamMembers().catch(() => {});

        // Utoljára kiválasztott kiadvány visszaállítása
        const storedId = getStoredPublicationId();
        if (storedId && pubs.some(p => p.$id === storedId)) {
            await handlePublicationSelect(storedId);
        } else if (pubs.length > 0) {
            await handlePublicationSelect(pubs[0].$id);
        } else {
            tableContainer.innerHTML = '<div class="empty-state">Nincsenek kiadványok</div>';
        }

        // Realtime feliratkozás
        subscribeRealtime();

        // Sürgősség frissítés 5 percenként
        urgencyInterval = setInterval(() => {
            const filtered = applyFilters();
            renderArticleTable(filtered);
        }, URGENCY_REFRESH_INTERVAL_MS);

    } catch (err) {
        showToast('Adatok betöltése sikertelen: ' + (err?.message || 'Ismeretlen hiba'), 'error');
    }
}

// ─── Kiadvány választás kezelés ─────────────────────────────────────────────

async function handlePublicationSelect(publicationId) {
    storePublicationId(publicationId);

    // Kiadvány név megjelenítése (a már lekért listából)
    const pub = getPublications().find(p => p.$id === publicationId);
    contentTitle.textContent = pub ? pub.name : 'Kiadvány';

    // Loading
    showLoading(tableContainer);
    renderPublicationList();

    try {
        await switchPublication(publicationId);
        refreshTable();
    } catch (err) {
        showToast('Cikkek betöltése sikertelen', 'error');
    }
}

// ─── Szűrő változás kezelés ────────────────────────────────────────────────

function handleFilterChange() {
    refreshTable();
}

// ─── Adat változás kezelés (Realtime) ───────────────────────────────────────

function handleDataChange({ type }) {
    if (type === 'publications') {
        renderPublicationList();
    }
    if (type === 'articles' || type === 'deadlines' || type === 'validations') {
        refreshTable();
    }
}

// ─── Nézet váltás ──────────────────────────────────────────────────────────

function switchView(view) {
    activeView = view;

    if (view === 'table') {
        tableContainer.style.display = '';
        layoutContainer.style.display = 'none';
        viewTableBtn.classList.add('active');
        viewLayoutBtn.classList.remove('active');
    } else {
        tableContainer.style.display = 'none';
        layoutContainer.style.display = '';
        viewTableBtn.classList.remove('active');
        viewLayoutBtn.classList.add('active');
    }

    refreshContent();
}

viewTableBtn.addEventListener('click', () => switchView('table'));
viewLayoutBtn.addEventListener('click', () => switchView('layout'));

// ─── Tartalom frissítés (mindkét nézet) ─────────────────────────────────────

function refreshContent() {
    const filtered = applyFilters();
    articleCount.textContent = `${filtered.length} cikk`;

    // Szűrő gomb vizuális jelzés
    const toggleBtn = document.getElementById('filter-toggle-btn');
    if (toggleBtn) {
        const active = isFilterActive();
        toggleBtn.style.color = active ? '#3b82f6' : '';
        toggleBtn.style.borderColor = active ? '#3b82f6' : '';
    }

    if (activeView === 'table') {
        renderArticleTable(filtered);
    } else {
        renderLayoutView(filtered, getPublications(), getActivePublicationId());
    }
}

/** Visszafelé kompatibilis alias — a régi refreshTable hívások működjenek. */
function refreshTable() {
    refreshContent();
}

// ─── App indítás ────────────────────────────────────────────────────────────

async function init() {
    // Session ellenőrzés — ha van aktív session, egyből a dashboardra
    const user = await checkSession();
    if (user) {
        await enterDashboard();
    } else {
        showLoginView();
    }
}

init();
