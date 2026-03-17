/**
 * Maestro Dashboard — Közös UI elemek
 *
 * Toast értesítések, loading spinner.
 */

// ─── Toast ──────────────────────────────────────────────────────────────────

/**
 * Toast értesítés megjelenítése.
 *
 * @param {string} message — Üzenet szöveg.
 * @param {'info'|'error'|'success'|'warning'} type — Típus (szín).
 * @param {number} duration — Megjelenítés időtartama ms-ban.
 */
export function showToast(message, type = 'info', duration = 5000) {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    container.appendChild(toast);

    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(20px)';
        toast.style.transition = 'all 0.3s';
        setTimeout(() => toast.remove(), 300);
    }, duration);
}

// ─── Loading spinner ────────────────────────────────────────────────────────

/**
 * Loading állapot megjelenítése a tábla konténerben.
 */
export function showLoading(container) {
    container.innerHTML = `
        <div class="loading-overlay">
            <div class="spinner"></div>
            <span>Betöltés...</span>
        </div>
    `;
}

/**
 * Üres állapot megjelenítése.
 */
export function showEmpty(container, message = 'Nincsenek cikkek') {
    container.innerHTML = `<div class="empty-state">${escapeHtml(message)}</div>`;
}

// ─── HTML escape ────────────────────────────────────────────────────────────

/**
 * HTML entity escaping.
 */
export function escapeHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}
