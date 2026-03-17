/**
 * Maestro Dashboard — Kiadvány lista
 *
 * Oldalsáv + mobil dropdown a kiadványok kiválasztásához.
 */

import { getPublications, getActivePublicationId } from '../data.js';
import { STORAGE_KEYS } from '../config.js';
import { escapeHtml } from './components.js';

let onSelectCallback = null;

/**
 * Inicializálja a kiadvány listát.
 * @param {Function} onSelect — Callback kiadvány választáskor: (publicationId) => void
 */
export function initPublicationList(onSelect) {
    onSelectCallback = onSelect;

    // Mobil dropdown eseménykezelő
    const mobileSelect = document.getElementById('mobile-pub-select');
    if (mobileSelect) {
        mobileSelect.addEventListener('change', (e) => {
            const id = e.target.value;
            if (id && onSelectCallback) onSelectCallback(id);
        });
    }
}

/**
 * Újrarendereli a kiadvány listát (oldalsáv + mobil dropdown).
 */
export function renderPublicationList() {
    const publications = getPublications();
    const activeId = getActivePublicationId();
    const container = document.getElementById('publication-list');
    const mobileSelect = document.getElementById('mobile-pub-select');

    if (!container) return;

    // Oldalsáv lista
    container.innerHTML = publications.map(pub => `
        <div class="publication-item ${pub.$id === activeId ? 'active' : ''}"
             data-id="${pub.$id}"
             title="${escapeHtml(pub.name)}">
            ${escapeHtml(pub.name)}
        </div>
    `).join('');

    // Kattintás kezelő az oldalsáv elemekhez
    container.querySelectorAll('.publication-item').forEach(item => {
        item.addEventListener('click', () => {
            const id = item.dataset.id;
            if (id && onSelectCallback) onSelectCallback(id);
        });
    });

    // Mobil dropdown
    if (mobileSelect) {
        const currentValue = mobileSelect.value;
        mobileSelect.innerHTML = `
            <option value="">Válassz kiadványt...</option>
            ${publications.map(pub => `
                <option value="${pub.$id}" ${pub.$id === activeId ? 'selected' : ''}>
                    ${escapeHtml(pub.name)}
                </option>
            `).join('')}
        `;
        // Megőrizzük a kiválasztott értéket, ha még érvényes
        if (activeId) mobileSelect.value = activeId;
        else if (currentValue) mobileSelect.value = currentValue;
    }
}

/**
 * Visszaadja az utoljára kiválasztott kiadvány ID-t (localStorage-ből).
 * @returns {string|null}
 */
export function getStoredPublicationId() {
    return localStorage.getItem(STORAGE_KEYS.SELECTED_PUBLICATION) || null;
}

/**
 * Elmenti a kiválasztott kiadvány ID-t.
 * @param {string} id
 */
export function storePublicationId(id) {
    localStorage.setItem(STORAGE_KEYS.SELECTED_PUBLICATION, id);
}
