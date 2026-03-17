/**
 * Maestro Dashboard — Cikk tábla
 *
 * 5 oszlop: Terj., Cikknév, Zárolta, Státusz, ⚠
 * Rendezés, sürgősség háttér, validáció ikonok.
 */

import { getArticles, getDeadlines, getValidations, getPublications, getActivePublicationId, getMemberName } from '../data.js';
import { getCurrentUser } from '../auth.js';
import { WORKFLOW_CONFIG, MARKERS, LOCK_TYPE, VALIDATION_TYPES } from '../config.js';
import { calculateUrgencyMap } from '../urgency.js';
import { escapeHtml, showEmpty } from './components.js';

// ─── Rendezés állapot ───────────────────────────────────────────────────────

let sortColumn = 'range';
let sortDirection = 'asc';
let urgencyMap = new Map();

const MAX_PAGE_SORT_FALLBACK = 99999;

// ─── Render ─────────────────────────────────────────────────────────────────

/**
 * Rendereli a cikk táblát a szűrt cikkekből.
 * @param {Array} filteredArticles — Szűrt cikk tömb.
 */
export async function renderArticleTable(filteredArticles) {
    const container = document.getElementById('table-container');
    if (!container) return;

    if (!filteredArticles || filteredArticles.length === 0) {
        showEmpty(container, 'Nincsenek cikkek');
        return;
    }

    // Sürgősség-számítás
    const deadlines = getDeadlines();
    urgencyMap = await calculateUrgencyMap(filteredArticles, deadlines);

    // Teljes tábla renderelés (fejléc + törzs + eseménykezelők)
    renderFullTable(container, filteredArticles);
}

/**
 * Teljes tábla renderelés: fejléc, törzs és fejléc kattintás kezelők.
 * A fejléc kattintás csak ezt hívja (sürgősség újraszámítás nélkül).
 */
function renderFullTable(container, filteredArticles) {
    // Validációk előindexelése
    const userValidationsByArticle = indexValidations();

    // Rendezés (validáció indexet átadjuk, hogy ne indexeljen újra soronként)
    const sorted = sortArticles(filteredArticles, userValidationsByArticle);

    // Kiadvány (coverageEnd a zero-padding-hez)
    const pub = getActivePublication();
    const maxPage = pub?.coverageEnd || 999;

    // Tábla HTML
    container.innerHTML = `
        <table class="article-table">
            <thead>
                <tr>
                    ${renderHeader('range', 'Terj.', 'col-range')}
                    ${renderHeader('name', 'Cikknév', 'col-name')}
                    ${renderHeader('lock', 'Zárolta', 'col-lock')}
                    ${renderHeader('state', 'Státusz', 'col-state')}
                    ${renderHeader('validator', '⚠', 'col-validate')}
                </tr>
            </thead>
            <tbody>
                ${sorted.map(article => renderRow(article, maxPage, userValidationsByArticle)).join('')}
            </tbody>
        </table>
    `;

    // Fejléc kattintás kezelők — csak újrarendez, sürgősséget nem számolja újra
    container.querySelectorAll('th[data-sort]').forEach(th => {
        th.addEventListener('click', () => {
            const col = th.dataset.sort;
            if (sortColumn === col) {
                sortDirection = sortDirection === 'asc' ? 'desc' : 'asc';
            } else {
                sortColumn = col;
                sortDirection = 'asc';
            }
            renderFullTable(container, filteredArticles);
        });
    });
}

// ─── Fejléc renderelés ──────────────────────────────────────────────────────

function renderHeader(id, label, cssClass) {
    const isSorted = sortColumn === id;
    const arrow = isSorted ? (sortDirection === 'asc' ? '▲' : '▼') : '';
    return `<th class="${cssClass} ${isSorted ? 'sorted' : ''}" data-sort="${id}">
        ${escapeHtml(label)}<span class="sort-arrow">${arrow}</span>
    </th>`;
}

// ─── Sor renderelés ─────────────────────────────────────────────────────────

function renderRow(article, maxPage, validationMap) {
    const urgency = urgencyMap.get(article.$id);
    const bgStyle = urgency?.background ? `background: ${urgency.background}` : '';

    return `<tr style="${bgStyle}">
        <td class="col-range">${renderPageRange(article, maxPage)}</td>
        <td class="col-name">${renderName(article)}</td>
        <td class="col-lock">${renderLock(article)}</td>
        <td class="col-state">${renderState(article)}</td>
        <td class="col-validate">${renderValidation(article, validationMap)}</td>
    </tr>`;
}

// ─── Cella renderelők ───────────────────────────────────────────────────────

function renderPageRange(article, maxPage) {
    if (!article.startPage) return '';
    const padding = String(maxPage).length;
    const pad = (n) => String(n).padStart(padding, '0');
    const start = pad(article.startPage);
    if (article.endPage && article.endPage !== article.startPage) {
        return `<span class="page-range">${start}\u2013${pad(article.endPage)}</span>`;
    }
    return `<span class="page-range">${start}</span>`;
}

function renderName(article) {
    if (!article.name) return '<span class="article-unnamed">Névtelen</span>';
    return escapeHtml(article.name);
}

function renderLock(article) {
    if (!article.lockOwnerId) return '';
    const currentUser = getCurrentUser();

    let label;
    if (article.lockType === LOCK_TYPE.SYSTEM) {
        label = 'MAESTRO';
    } else if (article.lockOwnerId === currentUser?.$id) {
        label = 'ÉN';
    } else {
        const name = getMemberName(article.lockOwnerId);
        label = name ? name.toUpperCase() : 'MÁS';
    }

    return `<span class="lock-label">${escapeHtml(label)}</span>`;
}

function renderState(article) {
    const state = article.state ?? 0;
    const config = WORKFLOW_CONFIG[state];
    const markers = typeof article.markers === 'number' ? article.markers : 0;
    const isIgnored = (markers & MARKERS.IGNORE) !== 0;
    const color = isIgnored ? '#9E9E9E' : (config?.color || '#999');
    const label = config?.label || 'Ismeretlen';
    const suffix = isIgnored ? ' (Kimarad)' : '';

    return `<span class="state-dot" style="background-color: ${color}" title="${escapeHtml(label + suffix)}"></span>`;
}

function renderValidation(article, validationMap) {
    const items = getAllActiveItems(article.$id, validationMap);
    if (items.length === 0) return '';

    const hasErrors = items.some(i => i.type === VALIDATION_TYPES.ERROR);
    const hasWarnings = items.some(i => i.type === VALIDATION_TYPES.WARNING);

    const tooltip = items.map(i => {
        const prefix = i.type === VALIDATION_TYPES.ERROR
            ? (i.source === 'user' ? '[Gond]' : '[Hiba]')
            : (i.source === 'user' ? '[Infó]' : '[Figy.]');
        return `${prefix} ${i.message}`;
    }).join('\n');

    let icons = '';
    if (hasErrors) {
        icons += `<svg width="14" height="14" viewBox="0 0 14 14">
            <circle cx="7" cy="7" r="6" fill="#dc2626"/>
            <path d="M4.5 4.5l5 5M9.5 4.5l-5 5" stroke="white" stroke-width="1.5" stroke-linecap="round"/>
        </svg>`;
    }
    if (hasWarnings) {
        icons += `<svg width="14" height="14" viewBox="0 0 14 14">
            <path d="M7 1L13 13H1L7 1Z" fill="#ea580c"/>
            <path d="M7 5.5v3" stroke="white" stroke-width="1.5" stroke-linecap="round"/>
            <circle cx="7" cy="10.5" r="0.8" fill="white"/>
        </svg>`;
    }

    return `<div class="validation-icons" title="${escapeHtml(tooltip)}">${icons}</div>`;
}

// ─── Validáció indexelés ────────────────────────────────────────────────────

function indexValidations() {
    const map = new Map();
    const validations = getValidations();
    for (const v of validations) {
        if (v.isResolved) continue;
        const item = {
            type: v.type || 'info',
            message: v.description || v.message || '',
            source: v.source || 'user'
        };
        const list = map.get(v.articleId);
        if (list) list.push(item);
        else map.set(v.articleId, [item]);
    }
    return map;
}

function getAllActiveItems(articleId, userMap) {
    // Csak felhasználói validációk — rendszer validációk (preflight stb.) nem futnak a dashboardon
    return userMap.get(articleId) || [];
}

// ─── Rendezés ───────────────────────────────────────────────────────────────

function sortArticles(articles, validationMap) {
    const sorted = [...articles];
    const currentUser = getCurrentUser();

    sorted.sort((a, b) => {
        let valA, valB;

        switch (sortColumn) {
            case 'range':
                valA = a.startPage || MAX_PAGE_SORT_FALLBACK;
                valB = b.startPage || MAX_PAGE_SORT_FALLBACK;
                break;
            case 'name':
                valA = a.name ? a.name.toLowerCase() : '';
                valB = b.name ? b.name.toLowerCase() : '';
                break;
            case 'lock': {
                valA = getLockSortValue(a, currentUser);
                valB = getLockSortValue(b, currentUser);
                break;
            }
            case 'state':
                valA = a.state ?? 0;
                valB = b.state ?? 0;
                break;
            case 'validator':
                valA = getValidationSeverity(a, validationMap);
                valB = getValidationSeverity(b, validationMap);
                break;
            default:
                valA = a[sortColumn];
                valB = b[sortColumn];
        }

        if (valA < valB) return sortDirection === 'asc' ? -1 : 1;
        if (valA > valB) return sortDirection === 'asc' ? 1 : -1;

        // Másodlagos rendezés: név
        if (sortColumn !== 'name') {
            const nameA = a.name ? a.name.toLowerCase() : '';
            const nameB = b.name ? b.name.toLowerCase() : '';
            if (nameA < nameB) return -1;
            if (nameA > nameB) return 1;
        }

        return 0;
    });

    return sorted;
}

function getLockSortValue(article, currentUser) {
    if (!article.lockOwnerId) return '';
    if (article.lockType === LOCK_TYPE.SYSTEM) return 'maestro';
    if (article.lockOwnerId === currentUser?.$id) return 'én';
    return getMemberName(article.lockOwnerId) || 'más';
}

function getValidationSeverity(article, validationMap) {
    const items = getAllActiveItems(article.$id, validationMap);
    if (items.some(i => i.type === VALIDATION_TYPES.ERROR)) return 2;
    if (items.some(i => i.type === VALIDATION_TYPES.WARNING)) return 1;
    return 0;
}

// ─── Segédfüggvények ────────────────────────────────────────────────────────

function getActivePublication() {
    const id = getActivePublicationId();
    return getPublications().find(p => p.$id === id) || null;
}
