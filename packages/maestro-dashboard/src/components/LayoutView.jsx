/**
 * Maestro Dashboard — Layout nézet (Flatplan)
 *
 * Oldalpár (spread) alapú áttekintés thumbnail képekkel.
 * Magazin konvenció: 1. oldal jobb, 2-3, 4-5, ... spreadek.
 * Fix oszlopszám CSS Grid-del, kiadványonként localStorage-ban tárolva.
 * Ctrl+Wheel / trackpad pinch / mobil touch pinch az oszlopszámot lépteti.
 */

import React, { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import { useData } from '../contexts/DataContext.jsx';
import { BUCKETS, STORAGE_KEYS } from '../config.js';
import PageSlot from './PageSlot.jsx';

// ─── Oszlopszám állandók ─────────────────────────────────────────────────────

const COLUMNS_DEFAULT = 5;
const COLUMNS_MIN = 1;
const COLUMNS_MAX = 12;

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
    const layoutViewRef = useRef(null);

    // Ref-ek a stabil event handler closure-ökhoz
    const columnsRef = useRef(columns);
    const columnsToRef = useRef(null);

    const publication = useMemo(
        () => publications.find(p => p.$id === activePublicationId),
        [publications, activePublicationId]
    );

    const publicationIds = useMemo(
        () => publications.map(p => p.$id),
        [publications]
    );

    // Kiadvány váltáskor oszlopszám betöltése
    useEffect(() => {
        setColumns(loadColumns(activePublicationId));
    }, [activePublicationId]);

    /**
     * Oszlopszám alkalmazása a nézet középpontjának megőrzésével.
     * Minden zoom forrás (input, gombok, wheel, pinch) ezt hívja.
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

    // Ref szinkronizálás
    useEffect(() => { columnsRef.current = columns; }, [columns]);
    useEffect(() => { columnsToRef.current = columnsTo; }, [columnsTo]);

    // localStorage mentés oszlopszám változáskor
    useEffect(() => {
        saveColumns(activePublicationId, columns, publicationIds);
    }, [columns, activePublicationId, publicationIds]);

    // ─── Ctrl+Wheel / trackpad pinch handler ─────────────────────────────────

    useEffect(() => {
        const view = layoutViewRef.current;
        if (!view) return;
        const container = view.parentElement;
        if (!container) return;

        let wheelAccumulator = 0;

        const handleWheel = (e) => {
            if (!e.ctrlKey) return;
            e.preventDefault();

            // Trackpad pinch kis delta-kat ad, egérgörgő nagyokat — normalizálás
            wheelAccumulator += e.deltaY;
            const threshold = Math.abs(e.deltaY) > 50 ? 1 : 20;

            if (Math.abs(wheelAccumulator) >= threshold) {
                const direction = wheelAccumulator > 0 ? 1 : -1;
                columnsToRef.current(columnsRef.current + direction);
                wheelAccumulator = 0;
            }
        };

        container.addEventListener('wheel', handleWheel, { passive: false });
        return () => container.removeEventListener('wheel', handleWheel);
    }, []);

    // ─── Mobil touch pinch handler ───────────────────────────────────────────

    useEffect(() => {
        const view = layoutViewRef.current;
        if (!view) return;
        const container = view.parentElement;
        if (!container) return;

        let initialDistance = 0;

        const getDistance = (touches) => {
            const dx = touches[0].clientX - touches[1].clientX;
            const dy = touches[0].clientY - touches[1].clientY;
            return Math.sqrt(dx * dx + dy * dy);
        };

        const handleTouchStart = (e) => {
            if (e.touches.length === 2) {
                initialDistance = getDistance(e.touches);
            }
        };

        const handleTouchMove = (e) => {
            if (e.touches.length !== 2 || !initialDistance) return;
            e.preventDefault();

            const currentDistance = getDistance(e.touches);
            const ratio = currentDistance / initialDistance;

            // Küszöb: 30%-os változás kell egy lépéshez
            if (ratio < 0.7) {
                columnsToRef.current(columnsRef.current + 1);
                initialDistance = currentDistance;
            } else if (ratio > 1.3) {
                columnsToRef.current(columnsRef.current - 1);
                initialDistance = currentDistance;
            }
        };

        const handleTouchEnd = () => {
            initialDistance = 0;
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
            {/* Oszlopszám toolbar */}
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
                </div>
            </div>

            {/* Layout nézet — CSS Grid */}
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
