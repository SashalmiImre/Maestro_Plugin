/**
 * Maestro Dashboard — Layout nézet (Flatplan)
 *
 * Oldalpár (spread) alapú áttekintés thumbnail képekkel.
 * Magazin konvenció: 1. oldal jobb, 2-3, 4-5, ... spreadek.
 * Fix oszlopszám CSS Grid-del, kiadványonként localStorage-ban tárolva.
 * Ctrl+Wheel / trackpad pinch / mobil touch pinch → CSS zoom (vizuális nagyítás).
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
const ZOOM_MAX = 4;

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

export default function LayoutView({ filteredArticles }) {
    const { publications, activePublicationId, storage } = useData();
    const [columns, setColumns] = useState(() => loadColumns(activePublicationId));
    const [zoom, setZoom] = useState(ZOOM_DEFAULT);
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

    const publication = useMemo(
        () => publications.find(p => p.$id === activePublicationId),
        [publications, activePublicationId]
    );

    const publicationIds = useMemo(
        () => publications.map(p => p.$id),
        [publications]
    );

    // Kiadvány váltáskor oszlopszám betöltése + zoom reset + arány reset
    useEffect(() => {
        setColumns(loadColumns(activePublicationId));
        setZoom(ZOOM_DEFAULT);
        zoomRef.current = ZOOM_DEFAULT;
        pageAspectRef.current = null;
        if (layoutViewRef.current) {
            layoutViewRef.current.style.zoom = ZOOM_DEFAULT;
            layoutViewRef.current.style.removeProperty('--page-aspect-ratio');
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
                view.style.setProperty('--page-aspect-ratio', pageAspectRef.current);
            }
        };

        view.addEventListener('load', handleLoad, true);
        return () => view.removeEventListener('load', handleLoad, true);
    }, []);

    /**
     * Oszlopszám alkalmazása a nézet középpontjának megőrzésével.
     * Az input mező és a +/- gombok hívják.
     */
    const columnsTo = useCallback((newColumns) => {
        const view = layoutViewRef.current;
        if (!view) return;
        const container = view.parentElement;
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

        // Szinkron reflow kényszerítés
        void container.scrollHeight;

        // Scroll visszaállítás
        container.scrollTop = ratioY * container.scrollHeight - container.clientHeight / 2;

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
                const container = view?.parentElement;
                if (!container) return;

                // Középpont mentése
                const centerY = container.scrollTop + container.clientHeight / 2;
                const centerX = container.scrollLeft + container.clientWidth / 2;
                const ratio = target / oldZoom;

                // CSS zoom alkalmazás (imperatív — nem React inline style)
                view.style.zoom = target;

                // Scroll visszaállítás (matematikai arány, nincs kényszerített reflow)
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
        const view = layoutViewRef.current;
        if (!view) return;
        const container = view.parentElement;
        if (!container) return;

        const handleWheel = (e) => {
            if (!e.ctrlKey) return;
            e.preventDefault();

            // Exponenciális zoom: kicsi delta (trackpad) → finom, nagy delta (egérgörgő) → erőteljes
            const factor = Math.pow(0.995, e.deltaY);
            zoomToRef.current(zoomRef.current * factor);
        };

        container.addEventListener('wheel', handleWheel, { passive: false });
        return () => container.removeEventListener('wheel', handleWheel);
    }, []);

    // ─── Mobil touch pinch handler → vizuális zoom ────────────────────────────

    useEffect(() => {
        const view = layoutViewRef.current;
        if (!view) return;
        const container = view.parentElement;
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

    // ─── Thumbnail URL ───────────────────────────────────────────────────────

    const getThumbnailUrl = useCallback((fileId) => {
        if (!storage) return '';
        try {
            return storage.getFileView(BUCKETS.THUMBNAILS, fileId);
        } catch {
            return '';
        }
    }, [storage]);

    // ─── Oldaltérkép + spreadek ──────────────────────────────────────────────

    const spreads = useMemo(() => {
        if (!publication) return [];

        const coverageStart = publication.coverageStart || 1;
        const coverageEnd = publication.coverageEnd || 1;
        if (coverageEnd < coverageStart) return [];

        const pageMap = buildPageMap(filteredArticles, coverageStart, coverageEnd, getThumbnailUrl);
        return buildSpreads(pageMap, coverageStart, coverageEnd);
    }, [filteredArticles, publication, getThumbnailUrl]);

    if (!publication) {
        return <div className="empty-state">Válassz egy kiadványt</div>;
    }

    if (spreads.length === 0) {
        return <div className="empty-state">Érvénytelen oldaltartomány</div>;
    }

    return (
        <>
            {/* Oszlopszám + zoom toolbar */}
            <div className="layout-toolbar">
                <div className="zoom-control">
                    <button
                        className="zoom-btn"
                        title="Több oszlop (kicsinyítés)"
                        disabled={columns >= COLUMNS_MAX}
                        onClick={() => columnsTo(columns + 1)}
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
                        title="Kevesebb oszlop (nagyítás)"
                        disabled={columns <= COLUMNS_MIN}
                        onClick={() => columnsTo(columns - 1)}
                    >
                        +
                    </button>
                    <span className="zoom-separator" />
                    <button
                        className="zoom-reset"
                        title="Zoom visszaállítása (100%)"
                        onClick={() => zoomTo(ZOOM_DEFAULT)}
                    >
                        {Math.round(zoom * 100)}%
                    </button>
                </div>
            </div>

            {/* Layout nézet — CSS Grid + CSS zoom (imperatív) */}
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
                        />
                        <PageSlot
                            pageData={spread.right}
                            pageNum={spread.rightNum}
                        />
                    </div>
                ))}
            </div>
        </>
    );
}

// ─── Oldaltérkép építés ─────────────────────────────────────────────────────

function buildPageMap(articles, coverageStart, coverageEnd, getThumbnailUrl) {
    const pageMap = {};

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
                // Ütközés
                if (!existing.conflict) {
                    existing.conflict = true;
                    existing.conflictArticles = [existing.articleName];
                }
                existing.conflictArticles.push(article.name);
            } else {
                pageMap[pageNum] = {
                    fileId: thumb.fileId,
                    thumbnailUrl: getThumbnailUrl(thumb.fileId),
                    articleName: article.name,
                    state: article.state,
                    ignored: article.ignored,
                    pageNum
                };
            }
        }
    }

    return pageMap;
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
