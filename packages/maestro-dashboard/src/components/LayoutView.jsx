/**
 * Maestro Dashboard — Layout nézet (Flatplan)
 *
 * Oldalpár (spread) alapú áttekintés thumbnail képekkel.
 * Magazin konvenció: 1. oldal jobb, 2-3, 4-5, ... spreadek.
 * Fix oszlopszám CSS Grid-del, kiadványonként localStorage-ban tárolva.
 * Ctrl+Wheel / trackpad pinch / mobil touch pinch → transform: scale() (vizuális nagyítás).
 */

import React, { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import { useData } from '../contexts/DataContext.jsx';
import { BUCKETS, STORAGE_KEYS } from '../config.js';
import PageSlot from './PageSlot.jsx';

// ─── Állandók ────────────────────────────────────────────────────────────────

const COLUMNS_DEFAULT = 5;
const COLUMNS_MIN = 1;
const COLUMNS_MAX = 12;

const ZOOM_DEFAULT = 1;
const ZOOM_MIN = 0.25;
const ZOOM_MAX = 10;

/** Kiadványonkénti oszlopszám betöltése localStorage-ból. */
function loadColumns(publicationId) {
    if (!publicationId) return COLUMNS_DEFAULT;
    try {
        const map = JSON.parse(localStorage.getItem(STORAGE_KEYS.LAYOUT_COLUMNS)) || {};
        const val = parseInt(map[publicationId], 10);
        if (!isNaN(val) && val >= COLUMNS_MIN && val <= COLUMNS_MAX) return val;
    } catch { /* sérült JSON → alapértelmezett */ }
    return COLUMNS_DEFAULT;
}

/** Oszlopszám mentése localStorage-ba (lazy takarítással). */
function saveColumns(publicationId, columns, publicationIds) {
    if (!publicationId) return;
    try {
        const map = JSON.parse(localStorage.getItem(STORAGE_KEYS.LAYOUT_COLUMNS)) || {};
        map[publicationId] = columns;

        // Lazy takarítás: nem létező kiadványok törlése
        if (publicationIds) {
            const idSet = new Set(publicationIds);
            for (const key of Object.keys(map)) {
                if (!idSet.has(key)) delete map[key];
            }
        }

        localStorage.setItem(STORAGE_KEYS.LAYOUT_COLUMNS, JSON.stringify(map));
    } catch { /* localStorage nem elérhető */ }
}

// ─── Komponens ──────────────────────────────────────────────────────────────

/** Layout kiválasztás betöltése localStorage-ból. */
function loadSelectedLayout(publicationId) {
    if (!publicationId) return null;
    try {
        const map = JSON.parse(localStorage.getItem(STORAGE_KEYS.LAYOUT_SELECTED)) || {};
        return map[publicationId] || null;
    } catch { return null; }
}

/** Layout kiválasztás mentése localStorage-ba. */
function saveSelectedLayout(publicationId, layoutId) {
    if (!publicationId) return;
    try {
        const map = JSON.parse(localStorage.getItem(STORAGE_KEYS.LAYOUT_SELECTED)) || {};
        if (layoutId) {
            map[publicationId] = layoutId;
        } else {
            delete map[publicationId];
        }
        localStorage.setItem(STORAGE_KEYS.LAYOUT_SELECTED, JSON.stringify(map));
    } catch { /* localStorage nem elérhető */ }
}

export default function LayoutView({ filteredArticles }) {
    const { publications, layouts, activePublicationId, storage, validations } = useData();
    const [columns, setColumns] = useState(() => loadColumns(activePublicationId));
    const [zoom, setZoom] = useState(ZOOM_DEFAULT);
    const [naturalWidth, setNaturalWidth] = useState(null);
    const [selectedLayoutId, setSelectedLayoutId] = useState(() => loadSelectedLayout(activePublicationId));
    const layoutViewRef = useRef(null);

    // Ref-ek a stabil event handler closure-ökhoz
    const columnsRef = useRef(columns);
    const columnsToRef = useRef(null);
    const zoomRef = useRef(zoom);
    const zoomToRef = useRef(null);

    // rAF + debounce ref-ek a smooth zoom-hoz
    const pendingZoomRef = useRef(null);
    const rafRef = useRef(null);
    const zoomTimerRef = useRef(null);

    // Dinamikus oldalarány — az első betöltött thumbnail-ből detektálva
    const pageAspectRef = useRef(null);

    // Thumbnail természetes pixelszélesség — pixel-arány alapú zoom%-kijelzőhöz
    const naturalWidthRef = useRef(null);

    // Zoom természetes méretek — transform: scale() wrapper méretezéséhez
    const baseWidthRef = useRef(null);
    const baseHeightRef = useRef(null);
    const wrapperRef = useRef(null);

    const publication = useMemo(
        () => publications.find(p => p.$id === activePublicationId),
        [publications, activePublicationId]
    );

    const publicationIds = useMemo(
        () => publications.map(p => p.$id),
        [publications]
    );

    // Kiadvány váltáskor oszlopszám betöltése + zoom reset + arány reset + layout reset
    useEffect(() => {
        setColumns(loadColumns(activePublicationId));
        setSelectedLayoutId(loadSelectedLayout(activePublicationId));
        setZoom(ZOOM_DEFAULT);
        zoomRef.current = ZOOM_DEFAULT;
        pageAspectRef.current = null;
        naturalWidthRef.current = null;
        setNaturalWidth(null);
        baseWidthRef.current = null;
        baseHeightRef.current = null;
        if (layoutViewRef.current) {
            layoutViewRef.current.style.transform = '';
            layoutViewRef.current.style.removeProperty('width');
            layoutViewRef.current.style.removeProperty('--page-aspect-ratio');
            layoutViewRef.current.style.removeProperty('--layout-zoom');
            layoutViewRef.current.style.removeProperty('--page-ratio');
        }
        if (wrapperRef.current) {
            wrapperRef.current.style.width = '';
            wrapperRef.current.style.height = '';
        }
    }, [activePublicationId]);

    // ─── Oldalarány detektálás az első betöltött thumbnail-ből ───────────────
    // A load event nem buborékol → capture phase szükséges.
    // A detektált arány CSS variable-ként kerül a layout-view-re,
    // amit a placeholder-ek és empty-slot-ok használnak.

    useEffect(() => {
        const view = layoutViewRef.current;
        if (!view) return;

        const handleLoad = (e) => {
            if (e.target.tagName !== 'IMG' || pageAspectRef.current) return;
            const { naturalWidth, naturalHeight } = e.target;
            if (naturalWidth > 0 && naturalHeight > 0) {
                pageAspectRef.current = `${naturalWidth} / ${naturalHeight}`;
                naturalWidthRef.current = naturalWidth;
                view.style.setProperty('--page-aspect-ratio', pageAspectRef.current);
                // --page-ratio: oldal CSS-pixel szélessége / eredeti pixelszélesség
                // Ezt a CSS clamp() alapú betűméret-skálázáshoz használjuk
                const vw = view.offsetWidth;
                const sw = Math.max(1, vw - 40 - (columnsRef.current - 1) * 20);
                view.style.setProperty('--page-ratio', String(sw / (columnsRef.current * 2) / naturalWidth));
                setNaturalWidth(naturalWidth); // state → re-render a displayZoom frissítéséhez
            }
        };

        view.addEventListener('load', handleLoad, true);
        return () => view.removeEventListener('load', handleLoad, true);
    }, []);

    // ─── Thumbnail URL ───────────────────────────────────────────────────────

    const getThumbnailUrl = useCallback((fileId) => {
        if (!storage) return '';
        try {
            return storage.getFileView({ bucketId: BUCKETS.THUMBNAILS, fileId });
        } catch {
            return '';
        }
    }, [storage]);

    // Validáció indexelés (articleId → [{type, message, source}])
    const validationIndex = useMemo(() => {
        const map = new Map();
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
    }, [validations]);

    // Alap (első) layout ID — fallback oldalakhoz
    const defaultLayoutId = useMemo(
        () => layouts.length > 0 ? layouts[0].$id : null,
        [layouts]
    );

    // ─── Oldaltérkép + spreadek ──────────────────────────────────────────────

    const spreads = useMemo(() => {
        if (!publication) return [];

        const coverageStart = publication.coverageStart || 1;
        const coverageEnd = publication.coverageEnd || 1;
        if (coverageEnd < coverageStart) return [];

        const pageMap = buildPageMap(
            filteredArticles, coverageStart, coverageEnd, getThumbnailUrl,
            selectedLayoutId, defaultLayoutId
        );
        return buildSpreads(pageMap, coverageStart, coverageEnd);
    }, [filteredArticles, publication, getThumbnailUrl, selectedLayoutId, defaultLayoutId]);

    // Cache-ből szinkron betöltött képek esetén a load event a listener regisztrálása
    // előtt tüzel — ezért renderelés UTÁN is ellenőrizzük a már kész képeket.
    useEffect(() => {
        if (pageAspectRef.current) return;
        const view = layoutViewRef.current;
        if (!view) return;
        const img = view.querySelector('img');
        if (!img?.complete || img.naturalWidth <= 0) return;

        const nw = img.naturalWidth;
        const nh = img.naturalHeight;
        pageAspectRef.current = `${nw} / ${nh}`;
        naturalWidthRef.current = nw;
        view.style.setProperty('--page-aspect-ratio', pageAspectRef.current);
        const vw = view.offsetWidth;
        const sw = Math.max(1, vw - 40 - (columnsRef.current - 1) * 20);
        view.style.setProperty('--page-ratio', String(sw / (columnsRef.current * 2) / nw));
        setNaturalWidth(nw);
    }, [spreads]);

    /**
     * Oszlopszám alkalmazása a nézet középpontjának megőrzésével.
     * Az input mező és a +/- gombok hívják.
     */
    const columnsTo = useCallback((newColumns) => {
        const view = layoutViewRef.current;
        const wrapper = wrapperRef.current;
        if (!view || !wrapper) return;
        const container = wrapper.parentElement;
        if (!container) return;

        const clamped = Math.max(COLUMNS_MIN, Math.min(COLUMNS_MAX, Math.round(newColumns)));
        if (clamped === columnsRef.current) return;

        // Középpont ráta mentése
        const { scrollTop, scrollHeight, clientHeight } = container;
        const ratioY = scrollHeight > clientHeight
            ? (scrollTop + clientHeight / 2) / scrollHeight
            : 0.5;

        // CSS Grid oszlopszám alkalmazása
        view.style.setProperty('--spread-columns', String(clamped));

        // Ha zoomed, magasság újraszámítás (grid átrendezés)
        if (baseWidthRef.current !== null) {
            const savedTransform = view.style.transform;
            view.style.transform = 'none';
            baseHeightRef.current = view.scrollHeight;
            view.style.transform = savedTransform;
            wrapper.style.height = (baseHeightRef.current * zoomRef.current) + 'px';
        }

        // Szinkron reflow kényszerítés
        void container.scrollHeight;

        // Scroll visszaállítás
        container.scrollTop = ratioY * container.scrollHeight - container.clientHeight / 2;

        // --page-ratio frissítése: oszlopszám-váltáskor az oldalszélesség megváltozik
        const nw = naturalWidthRef.current;
        if (nw) {
            const vw = baseWidthRef.current ?? view.offsetWidth;
            const sw = Math.max(1, vw - 40 - (clamped - 1) * 20);
            view.style.setProperty('--page-ratio', String(sw / (clamped * 2) / nw));
        }

        // React state + localStorage szinkron
        setColumns(clamped);
    }, []);

    /**
     * Vizuális zoom alkalmazása a nézet középpontjának megőrzésével.
     * Ctrl+wheel / trackpad pinch / mobil touch pinch ezt hívja.
     *
     * rAF batching: gyors egymás utáni hívások egyetlen frame-be kerülnek.
     * React state debounce: a toolbar %-kijelző csak a gesztus végén frissül.
     */
    const zoomTo = useCallback((newZoom) => {
        const clamped = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, newZoom));
        if (Math.abs(clamped - zoomRef.current) < 0.001) return;

        pendingZoomRef.current = clamped;

        if (!rafRef.current) {
            rafRef.current = requestAnimationFrame(() => {
                rafRef.current = null;
                const target = pendingZoomRef.current;
                const oldZoom = zoomRef.current;

                const view = layoutViewRef.current;
                const wrapper = wrapperRef.current;
                const container = wrapper?.parentElement;
                if (!view || !wrapper || !container) return;

                // Scroll középpont mentése (container koordináta-rendszerben)
                const centerY = container.scrollTop + container.clientHeight / 2;
                const centerX = container.scrollLeft + container.clientWidth / 2;
                const ratio = target / oldZoom;

                if (Math.abs(target - 1) < 0.01) {
                    // Reset → reszponzív layout visszaállítása
                    view.style.transform = '';
                    view.style.width = '';
                    view.style.removeProperty('--layout-zoom');
                    wrapper.style.width = '';
                    wrapper.style.height = '';
                    baseWidthRef.current = null;
                    baseHeightRef.current = null;
                } else {
                    // Első zoom: természetes méretek rögzítése (transform nélküli állapot)
                    if (baseWidthRef.current === null) {
                        baseWidthRef.current = view.offsetWidth;
                        view.style.width = baseWidthRef.current + 'px';
                        baseHeightRef.current = view.scrollHeight;
                    }

                    // Transform alkalmazás (tisztán vizuális — layout nem változik)
                    view.style.transform = `scale(${target})`;
                    view.style.setProperty('--layout-zoom', String(target));

                    // Wrapper méretezés → scroll terület a konténerben
                    wrapper.style.width = (baseWidthRef.current * target) + 'px';
                    wrapper.style.height = (baseHeightRef.current * target) + 'px';
                }

                // Scroll visszaállítás (matematikai arány)
                container.scrollTop = centerY * ratio - container.clientHeight / 2;
                container.scrollLeft = centerX * ratio - container.clientWidth / 2;

                zoomRef.current = target;
            });
        }

        // Toolbar %-kijelző frissítés debounce-olva (React re-render elkerülése gesztus közben)
        clearTimeout(zoomTimerRef.current);
        zoomTimerRef.current = setTimeout(() => setZoom(zoomRef.current), 150);
    }, []);

    // Ref szinkronizálás
    useEffect(() => { columnsRef.current = columns; }, [columns]);
    useEffect(() => { columnsToRef.current = columnsTo; }, [columnsTo]);
    useEffect(() => { zoomToRef.current = zoomTo; }, [zoomTo]);

    // rAF + timeout cleanup unmount-kor
    useEffect(() => {
        return () => {
            if (rafRef.current) cancelAnimationFrame(rafRef.current);
            if (zoomTimerRef.current) clearTimeout(zoomTimerRef.current);
        };
    }, []);

    // localStorage mentés oszlopszám változáskor
    useEffect(() => {
        saveColumns(activePublicationId, columns, publicationIds);
    }, [columns, activePublicationId, publicationIds]);

    // ─── Ctrl+Wheel / trackpad pinch handler → vizuális zoom ──────────────────

    useEffect(() => {
        const wrapper = wrapperRef.current;
        if (!wrapper) return;
        const container = wrapper.parentElement;
        if (!container) return;

        const handleWheel = (e) => {
            if (!e.ctrlKey) return;
            e.preventDefault();

            // Exponenciális zoom: kicsi delta (trackpad) → finom, nagy delta (egérgörgő) → erőteljes
            const factor = Math.pow(0.99, e.deltaY);
            zoomToRef.current(zoomRef.current * factor);
        };

        container.addEventListener('wheel', handleWheel, { passive: false });
        return () => container.removeEventListener('wheel', handleWheel);
    }, []);

    // ─── Mobil touch pinch handler → vizuális zoom ────────────────────────────

    useEffect(() => {
        const wrapper = wrapperRef.current;
        if (!wrapper) return;
        const container = wrapper.parentElement;
        if (!container) return;

        let startDistance = 0;
        let startZoom = 1;

        const getDistance = (touches) => {
            const dx = touches[0].clientX - touches[1].clientX;
            const dy = touches[0].clientY - touches[1].clientY;
            return Math.sqrt(dx * dx + dy * dy);
        };

        const handleTouchStart = (e) => {
            if (e.touches.length === 2) {
                startDistance = getDistance(e.touches);
                startZoom = zoomRef.current;
            }
        };

        const handleTouchMove = (e) => {
            if (e.touches.length !== 2 || !startDistance) return;
            e.preventDefault();

            // Smooth zoom: arányos a kétujjas távolság változáshoz
            const currentDistance = getDistance(e.touches);
            const ratio = currentDistance / startDistance;
            zoomToRef.current(startZoom * ratio);
        };

        const handleTouchEnd = () => {
            startDistance = 0;
        };

        container.addEventListener('touchstart', handleTouchStart, { passive: true });
        container.addEventListener('touchmove', handleTouchMove, { passive: false });
        container.addEventListener('touchend', handleTouchEnd, { passive: true });

        return () => {
            container.removeEventListener('touchstart', handleTouchStart);
            container.removeEventListener('touchmove', handleTouchMove);
            container.removeEventListener('touchend', handleTouchEnd);
        };
    }, []);

    // ─── Layout választás kezelő ────────────────────────────────────────────

    const handleLayoutChange = useCallback((e) => {
        const value = e.target.value;
        setSelectedLayoutId(value);
        saveSelectedLayout(activePublicationId, value);
    }, [activePublicationId]);

    // Ha nincs kiválasztott layout, vagy a kiválasztott layout már nem létezik → első layout auto-kiválasztás
    useEffect(() => {
        if (layouts.length === 0) return;
        if (!selectedLayoutId || !layouts.some(l => l.$id === selectedLayoutId)) {
            const firstId = layouts[0].$id;
            setSelectedLayoutId(firstId);
            saveSelectedLayout(activePublicationId, firstId);
        }
    }, [layouts, selectedLayoutId, activePublicationId]);

    // ─── Layout mentése PDF-ként (böngésző print → Save as PDF) ─────────────

    const exportAsPdf = useCallback(() => {
        window.print();
    }, []);

    if (!publication) {
        return <div className="empty-state">Válassz egy kiadványt</div>;
    }

    if (spreads.length === 0) {
        return <div className="empty-state">Érvénytelen oldaltartomány</div>;
    }

    // Pixel-arány alapú zoom% — eredeti thumbnail pixelszám vs. megjelenített pixelszám
    const viewWidth = baseWidthRef.current ?? layoutViewRef.current?.offsetWidth ?? 0;
    const spreadAreaWidth = Math.max(1, viewWidth - 40 - (columns - 1) * 20);
    const displayZoom = naturalWidth && viewWidth > 0
        ? Math.round(zoom * spreadAreaWidth / (columns * 2) / naturalWidth * 100)
        : null;

    return (
        <>
            {/* Oszlopszám + zoom toolbar */}
            <div className="layout-toolbar">
                {/* Layout választó dropdown */}
                {layouts.length > 1 && (
                    <select
                        className="layout-select"
                        value={selectedLayoutId || ''}
                        onChange={handleLayoutChange}
                        title="Elrendezés szűrő"
                    >
                        {layouts.map(l => (
                            <option key={l.$id} value={l.$id}>{l.name}</option>
                        ))}
                    </select>
                )}
                <div className="zoom-control">
                    <button
                        className="zoom-btn"
                        title="Kevesebb oszlop"
                        disabled={columns <= COLUMNS_MIN}
                        onClick={() => columnsTo(columns - 1)}
                    >
                        −
                    </button>
                    <input
                        type="number"
                        className="columns-input"
                        min={COLUMNS_MIN}
                        max={COLUMNS_MAX}
                        value={columns}
                        onChange={e => {
                            const val = parseInt(e.target.value, 10);
                            if (!isNaN(val)) columnsTo(val);
                        }}
                    />
                    <button
                        className="zoom-btn"
                        title="Több oszlop"
                        disabled={columns >= COLUMNS_MAX}
                        onClick={() => columnsTo(columns + 1)}
                    >
                        +
                    </button>
                    <span className="zoom-separator" />
                    <input
                        type="range"
                        className="zoom-slider"
                        min={ZOOM_MIN * 100}
                        max={ZOOM_MAX * 100}
                        value={Math.round(zoom * 100)}
                        onChange={e => zoomTo(parseInt(e.target.value, 10) / 100)}
                    />
                    <button
                        className="zoom-reset"
                        title="Zoom visszaállítása"
                        onClick={() => zoomTo(ZOOM_DEFAULT)}
                    >
                        {displayZoom != null ? `${displayZoom}%` : '—'}
                    </button>
                    <span className="zoom-separator" />
                    <button
                        className="zoom-btn export-btn"
                        title="Layout mentése PDF-ként"
                        onClick={exportAsPdf}
                    >
                        📄
                    </button>
                </div>
            </div>

            {/* Scrollozható terület — a toolbar ezen kívül marad */}
            <div className="layout-scroll-area">
                {/* Zoom wrapper — méretezés a scrollozható terület biztosításához */}
                <div className="layout-zoom-wrapper" ref={wrapperRef}>
                    {/* Layout nézet — CSS Grid + transform: scale() (imperatív) */}
                    <div
                        className="layout-view"
                        ref={layoutViewRef}
                        style={{ '--spread-columns': columns }}
                    >
                        {spreads.map(spread => (
                            <div className="spread" key={spread.leftNum ?? spread.rightNum}>
                                <PageSlot
                                    pageData={spread.left}
                                    pageNum={spread.leftNum}
                                    validationItems={spread.left?.articleId ? validationIndex.get(spread.left.articleId) || null : null}
                                />
                                <PageSlot
                                    pageData={spread.right}
                                    pageNum={spread.rightNum}
                                    validationItems={spread.right?.articleId ? validationIndex.get(spread.right.articleId) || null : null}
                                />
                            </div>
                        ))}
                    </div>
                </div>
            </div>
        </>
    );
}

// ─── Oldaltérkép építés ─────────────────────────────────────────────────────

/**
 * Oldaltérkép építés thumbnail-ekből.
 *
 * Ha selectedLayoutId meg van adva, csak az adott layout cikkeinek thumbnail-jeit
 * használja elsődlegesen, és az üres oldalakhoz az alap layout (defaultLayoutId)
 * cikkeinek thumbnail-jeit tölti be halvány fallback-ként.
 */
function buildPageMap(articles, coverageStart, coverageEnd, getThumbnailUrl, selectedLayoutId, defaultLayoutId) {
    const pageMap = {};

    for (let p = coverageStart; p <= coverageEnd; p++) {
        pageMap[p] = null;
    }

    // Ha nincs layout szűrés, minden cikk megjelenik (eredeti viselkedés)
    if (!selectedLayoutId) {
        fillPageMap(pageMap, articles, coverageStart, coverageEnd, getThumbnailUrl, false);
        return pageMap;
    }

    // Layout variáció: alap layout halványítva + a kiválasztott layout felülírásai élénken.
    // 1. lépés: alap layout cikkei (halványítva — örökölt oldalak)
    if (defaultLayoutId) {
        const defaultArticles = articles.filter(a => a.layout === defaultLayoutId);
        fillPageMap(pageMap, defaultArticles, coverageStart, coverageEnd, getThumbnailUrl, true);
    }

    // 2. lépés: kiválasztott layout cikkei felülírják az alap layout oldalait (élénken)
    const selectedArticles = articles.filter(a => a.layout === selectedLayoutId);
    fillPageMap(pageMap, selectedArticles, coverageStart, coverageEnd, getThumbnailUrl, false, true);

    return pageMap;
}

/**
 * Cikkek thumbnail-jeinek betöltése az oldaltérképbe.
 * @param {boolean} isFallback - Ha true, csak üres oldalakat tölt ki, és fallback jelölést kap
 * @param {boolean} override - Ha true, felülírja a meglévő oldal bejegyzéseket (layout variáció)
 */
function fillPageMap(pageMap, articles, coverageStart, coverageEnd, getThumbnailUrl, isFallback, override = false) {
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

            // Fallback: csak üres oldalakat tölt ki
            if (isFallback) {
                if (existing) continue;
                pageMap[pageNum] = {
                    fileId: thumb.fileId,
                    thumbnailUrl: getThumbnailUrl(thumb.fileId),
                    articleId: article.$id,
                    articleName: article.name,
                    state: article.state,
                    ignored: article.ignored,
                    pageNum,
                    isFallback: true
                };
                continue;
            }

            if (override) {
                // Layout variáció: felülírja az alap layout oldalait
                const entry = {
                    fileId: thumb.fileId,
                    thumbnailUrl: getThumbnailUrl(thumb.fileId),
                    articleId: article.$id,
                    articleName: article.name,
                    state: article.state,
                    ignored: article.ignored,
                    pageNum
                };

                // Ütközés-kezelés variáción belül is
                const prev = pageMap[pageNum];
                if (prev && prev.articleName && !prev.isFallback) {
                    if (!prev.conflict) {
                        prev.conflict = true;
                        prev.conflictArticles = [prev.articleName];
                    }
                    prev.conflictArticles.push(article.name);
                } else {
                    pageMap[pageNum] = entry;
                }
            } else if (existing && existing.articleName && !existing.isFallback) {
                // Ütközés (nem fallback elemek között)
                if (!existing.conflict) {
                    existing.conflict = true;
                    existing.conflictArticles = [existing.articleName];
                }
                existing.conflictArticles.push(article.name);
            } else {
                pageMap[pageNum] = {
                    fileId: thumb.fileId,
                    thumbnailUrl: getThumbnailUrl(thumb.fileId),
                    articleId: article.$id,
                    articleName: article.name,
                    state: article.state,
                    ignored: article.ignored,
                    pageNum
                };
            }
        }
    }
}

// ─── Spread építés ──────────────────────────────────────────────────────────

function buildSpreads(pageMap, coverageStart, coverageEnd) {
    const spreads = [];

    // 1. oldal: címlap (jobb oldal önállóan)
    spreads.push({
        left: null,
        leftNum: null,
        right: pageMap[coverageStart]
            ? { ...pageMap[coverageStart], pageNum: coverageStart }
            : { pageNum: coverageStart },
        rightNum: coverageStart
    });

    // Páros spreadek: 2-3, 4-5, 6-7, ...
    for (let p = coverageStart + 1; p <= coverageEnd; p += 2) {
        const leftNum = p;
        const rightNum = p + 1;

        const leftData = leftNum <= coverageEnd
            ? (pageMap[leftNum]
                ? { ...pageMap[leftNum], pageNum: leftNum }
                : { pageNum: leftNum })
            : null;
        const rightData = rightNum <= coverageEnd
            ? (pageMap[rightNum]
                ? { ...pageMap[rightNum], pageNum: rightNum }
                : { pageNum: rightNum })
            : null;

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
