/**
 * Maestro Dashboard — Layout nézet (Flatplan)
 *
 * Oldalpár (spread) alapú áttekintés thumbnail képekkel.
 * A magazin konvenciót követi:
 * - 1. oldal: jobb oldal önállóan (címlap)
 * - 2-3, 4-5, ...: spreadek (páros = bal/verso, páratlan = jobb/recto)
 * - Utolsó oldal (ha páros): bal oldal önállóan (hátlap)
 *
 * Funkciók:
 * - Több spread egy sorban (flex-wrap), amennyit a hely enged
 * - Zoom slider a thumbnail méretezéshez (localStorage-ban megmarad)
 * - Cikk információk a kép alatt (nem rávetítve)
 */

import { getStorage } from '../data.js';
import { BUCKETS, STATUS_COLORS, STORAGE_KEYS } from '../config.js';

/**
 * HTML escape — XSS védelem innerHTML interpolációhoz.
 * @param {string} str
 * @returns {string}
 */
function escapeHtml(str) {
    if (!str) return '';
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// ─── Konténer ───────────────────────────────────────────────────────────────

const layoutContainer = document.getElementById('layout-container');

// ─── Zoom állapot ───────────────────────────────────────────────────────────

const ZOOM_DEFAULT = 180;
const ZOOM_MIN = 80;
const ZOOM_MAX = 800;
const ZOOM_STEP = 10;

let currentZoom = loadZoomLevel();

/** Zoom szint betöltése localStorage-ból. */
function loadZoomLevel() {
    const stored = localStorage.getItem(STORAGE_KEYS.LAYOUT_ZOOM);
    if (stored) {
        const val = parseInt(stored, 10);
        if (!isNaN(val) && val >= ZOOM_MIN && val <= ZOOM_MAX) return val;
    }
    return ZOOM_DEFAULT;
}

/** Zoom szint mentése localStorage-ba. */
function saveZoomLevel(value) {
    localStorage.setItem(STORAGE_KEYS.LAYOUT_ZOOM, String(value));
}

// ─── Fő renderelő ──────────────────────────────────────────────────────────

/**
 * Rendereli a layout (flatplan) nézetet az aktív kiadványhoz.
 *
 * @param {Array} articles - A szűrt cikk lista.
 * @param {Array} publications - Az összes kiadvány.
 * @param {string} activePublicationId - Az aktív kiadvány ID-ja.
 */
export function renderLayoutView(articles, publications, activePublicationId) {
    if (!layoutContainer) return;

    const publication = publications.find(p => p.$id === activePublicationId);
    if (!publication) {
        layoutContainer.innerHTML = '<div class="empty-state">Válassz egy kiadványt</div>';
        return;
    }

    const coverageStart = publication.coverageStart || 1;
    const coverageEnd = publication.coverageEnd || 1;

    if (coverageEnd < coverageStart) {
        layoutContainer.innerHTML = '<div class="empty-state">Érvénytelen oldaltartomány</div>';
        return;
    }

    // Oldaltérkép felépítése: oldalszám → { thumbnailUrl, articleName, state, layoutName }
    const pageMap = buildPageMap(articles, coverageStart, coverageEnd);

    // Spreadek felépítése
    const spreads = buildSpreads(pageMap, coverageStart, coverageEnd);

    // HTML renderelés toolbar-ral és CSS custom property-vel
    const toolbar = renderToolbar();
    const spreadHtml = spreads.map(spread => renderSpread(spread)).join('');
    layoutContainer.innerHTML =
        `${toolbar}<div class="layout-view" style="--page-width: ${currentZoom}px">${spreadHtml}</div>`;

    attachZoomListeners();
}

/**
 * Layout nézet tartalmának törlése.
 */
export function clearLayoutView() {
    if (layoutContainer) {
        layoutContainer.innerHTML = '';
    }
}

// ─── Zoom vezérlés ──────────────────────────────────────────────────────────

/** Zoom toolbar HTML generálása. */
function renderToolbar() {
    return `
        <div class="layout-toolbar">
            <div class="zoom-control">
                <button class="zoom-btn" id="zoom-out-btn" title="Kicsinyítés">−</button>
                <input type="range" id="zoom-slider"
                       min="${ZOOM_MIN}" max="${ZOOM_MAX}" step="${ZOOM_STEP}"
                       value="${currentZoom}" />
                <button class="zoom-btn" id="zoom-in-btn" title="Nagyítás">+</button>
            </div>
        </div>
    `;
}

/** Zoom slider és gombok eseménykezelőinek csatlakoztatása. */
function attachZoomListeners() {
    const slider = layoutContainer.querySelector('#zoom-slider');
    const outBtn = layoutContainer.querySelector('#zoom-out-btn');
    const inBtn = layoutContainer.querySelector('#zoom-in-btn');

    if (slider) {
        slider.addEventListener('input', () => {
            currentZoom = parseInt(slider.value, 10);
            applyZoom();
        });
    }

    if (outBtn) {
        outBtn.addEventListener('click', () => {
            currentZoom = Math.max(ZOOM_MIN, currentZoom - ZOOM_STEP);
            applyZoom();
        });
    }

    if (inBtn) {
        inBtn.addEventListener('click', () => {
            currentZoom = Math.min(ZOOM_MAX, currentZoom + ZOOM_STEP);
            applyZoom();
        });
    }
}

/** Zoom alkalmazása a DOM-on (re-render nélkül). */
function applyZoom() {
    saveZoomLevel(currentZoom);

    const layoutView = layoutContainer.querySelector('.layout-view');
    if (layoutView) {
        layoutView.style.setProperty('--page-width', currentZoom + 'px');
    }

    const slider = layoutContainer.querySelector('#zoom-slider');
    if (slider) slider.value = currentZoom;
}

// ─── Oldaltérkép ────────────────────────────────────────────────────────────

/**
 * Felépíti az oldalszám → cikk+thumbnail leképezést.
 */
function buildPageMap(articles, coverageStart, coverageEnd) {
    const pageMap = {};

    // Minden oldalhoz alapértelmezett üres hely
    for (let p = coverageStart; p <= coverageEnd; p++) {
        pageMap[p] = null;
    }

    for (const article of articles) {
        if (!article.thumbnails) continue;

        let thumbnails;
        try {
            thumbnails = JSON.parse(article.thumbnails);
        } catch {
            continue;
        }

        if (!Array.isArray(thumbnails)) continue;

        for (const thumb of thumbnails) {
            const pageNum = parseInt(thumb.page, 10);
            if (isNaN(pageNum) || pageNum < coverageStart || pageNum > coverageEnd) continue;

            const existing = pageMap[pageNum];

            if (existing && existing.articleName) {
                // Ütközés — megtartjuk az első cikk thumbnailjet, jelöljük a konfliktust
                if (!existing.conflict) {
                    existing.conflict = true;
                    existing.conflictArticles = [existing.articleName];
                }
                existing.conflictArticles.push(article.name);
            } else {
                pageMap[pageNum] = {
                    fileId: thumb.fileId,
                    thumbnailUrl: getThumbnailPreviewUrl(thumb.fileId),
                    articleName: article.name,
                    state: article.state,
                    ignored: article.ignored
                };
            }
        }
    }

    return pageMap;
}

/**
 * Thumbnail nézet URL generálása az Appwrite Storage-ból.
 * `getFileView`-t használ `getFilePreview` helyett, mert az image
 * transformation az Appwrite free/starter plan-en nem elérhető.
 * A méretezést CSS végzi (`.page-slot img { width: 100% }`).
 */
function getThumbnailPreviewUrl(fileId) {
    const storage = getStorage();
    if (!storage) return '';

    try {
        return storage.getFileView(BUCKETS.THUMBNAILS, fileId);
    } catch {
        return '';
    }
}

// ─── Spread építés ──────────────────────────────────────────────────────────

/**
 * Spreadekre bontja az oldalakat a magazin konvenció szerint.
 * Visszatérés: [ { left: pageData|null, right: pageData|null, leftNum, rightNum } ]
 */
function buildSpreads(pageMap, coverageStart, coverageEnd) {
    const spreads = [];

    // 1. oldal: címlap (jobb oldal önállóan)
    spreads.push({
        left: null,
        leftNum: null,
        right: { ...(pageMap[coverageStart] || {}), pageNum: coverageStart },
        rightNum: coverageStart
    });

    // Páros spreadek: 2-3, 4-5, 6-7, ...
    for (let p = coverageStart + 1; p <= coverageEnd; p += 2) {
        const leftNum = p;
        const rightNum = p + 1;

        const leftData = leftNum <= coverageEnd
            ? { ...(pageMap[leftNum] || {}), pageNum: leftNum }
            : null;
        const rightData = rightNum <= coverageEnd
            ? { ...(pageMap[rightNum] || {}), pageNum: rightNum }
            : null;

        // Ha mindkettő null (túlfutás), kihagyjuk
        if (!leftData && !rightData) continue;

        spreads.push({
            left: leftData,
            leftNum: leftData ? leftNum : null,
            right: rightData,
            rightNum: rightData ? rightNum : null
        });
    }

    return spreads;
}

// ─── HTML renderelés ────────────────────────────────────────────────────────

/**
 * Egyetlen spread HTML-jét generálja.
 */
function renderSpread(spread) {
    const leftSlot = renderPageSlot(spread.left, spread.leftNum);
    const rightSlot = renderPageSlot(spread.right, spread.rightNum);

    return `<div class="spread">${leftSlot}${rightSlot}</div>`;
}

/**
 * Egyetlen oldal-slot HTML-jét generálja.
 */
function renderPageSlot(pageData, pageNum) {
    // Üres hely (pl. címlap bal oldala)
    if (!pageData && pageNum === null) {
        return '<div class="page-slot empty-slot"></div>';
    }

    // Placeholder (nincs thumbnail)
    if (!pageData || !pageData.thumbnailUrl) {
        return `
            <div class="page-slot placeholder">
                <div class="page-thumb-area">
                    <span class="page-number">${pageNum || '?'}</span>
                </div>
                <div class="page-info">
                    <span class="page-number">${pageNum || '?'}</span>
                </div>
            </div>
        `;
    }

    // Állapot szín sáv
    const stateColor = pageData.state != null ? (STATUS_COLORS[pageData.state] || '#999') : '#999';
    const ignoredClass = pageData.ignored ? ' ignored' : '';

    const safeName = escapeHtml(pageData.articleName);
    const safeUrl = escapeHtml(pageData.thumbnailUrl);

    // Ütközés badge (ha több cikk is ugyanezen az oldalon van)
    const conflictBadge = pageData.conflict
        ? `<div class="page-conflict-badge" title="${escapeHtml('Oldalütközés: ' + pageData.conflictArticles.join(', '))}">
               <svg width="16" height="16" viewBox="0 0 14 14">
                   <path d="M7 1L13 13H1L7 1Z" fill="#ea580c"/>
                   <path d="M7 5.5v3" stroke="white" stroke-width="1.5" stroke-linecap="round"/>
                   <circle cx="7" cy="10.5" r="0.8" fill="white"/>
               </svg>
           </div>`
        : '';

    return `
        <div class="page-slot${ignoredClass}">
            <div class="page-image">
                <img src="${safeUrl}" alt="${pageData.pageNum}. oldal" loading="lazy" />
                <div class="page-state-bar" style="background-color: ${stateColor}"></div>
                ${conflictBadge}
            </div>
            <div class="page-info">
                <span class="page-number">${pageData.pageNum}</span>
                <span class="article-name" title="${safeName}">${safeName}</span>
            </div>
        </div>
    `;
}
