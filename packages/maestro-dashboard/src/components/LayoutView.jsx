/**
 * Maestro Dashboard — Layout nézet (Flatplan)
 *
 * Oldalpár (spread) alapú áttekintés thumbnail képekkel.
 * Magazin konvenció: 1. oldal jobb, 2-3, 4-5, ... spreadek.
 * Zoom slider CSS custom property-vel (re-render nélkül).
 */

import React, { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import { useData } from '../contexts/DataContext.jsx';
import { BUCKETS, STORAGE_KEYS } from '../config.js';
import PageSlot from './PageSlot.jsx';

// ─── Zoom állandók ──────────────────────────────────────────────────────────

const ZOOM_DEFAULT = 180;
const ZOOM_MIN = 80;
const ZOOM_MAX = 800;
const ZOOM_STEP = 10;

function loadZoomLevel() {
    const stored = localStorage.getItem(STORAGE_KEYS.LAYOUT_ZOOM);
    if (stored) {
        const val = parseInt(stored, 10);
        if (!isNaN(val) && val >= ZOOM_MIN && val <= ZOOM_MAX) return val;
    }
    return ZOOM_DEFAULT;
}

// ─── Komponens ──────────────────────────────────────────────────────────────

export default function LayoutView({ filteredArticles }) {
    const { publications, activePublicationId, storage } = useData();
    const [zoom, setZoom] = useState(loadZoomLevel);
    const layoutViewRef = useRef(null);

    const publication = useMemo(
        () => publications.find(p => p.$id === activePublicationId),
        [publications, activePublicationId]
    );

    // Zoom alkalmazása CSS custom property-vel (re-render nélkül)
    useEffect(() => {
        if (layoutViewRef.current) {
            layoutViewRef.current.style.setProperty('--page-width', zoom + 'px');
        }
        localStorage.setItem(STORAGE_KEYS.LAYOUT_ZOOM, String(zoom));
    }, [zoom]);

    // Thumbnail URL generálás
    const getThumbnailUrl = useCallback((fileId) => {
        if (!storage) return '';
        try {
            return storage.getFileView(BUCKETS.THUMBNAILS, fileId);
        } catch {
            return '';
        }
    }, [storage]);

    // Oldaltérkép + spreadek
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
            {/* Zoom toolbar */}
            <div className="layout-toolbar">
                <div className="zoom-control">
                    <button
                        className="zoom-btn"
                        title="Kicsinyítés"
                        onClick={() => setZoom(z => Math.max(ZOOM_MIN, z - ZOOM_STEP))}
                    >
                        −
                    </button>
                    <input
                        type="range"
                        min={ZOOM_MIN}
                        max={ZOOM_MAX}
                        step={ZOOM_STEP}
                        value={zoom}
                        onChange={e => setZoom(parseInt(e.target.value, 10))}
                    />
                    <button
                        className="zoom-btn"
                        title="Nagyítás"
                        onClick={() => setZoom(z => Math.min(ZOOM_MAX, z + ZOOM_STEP))}
                    >
                        +
                    </button>
                </div>
            </div>

            {/* Layout nézet */}
            <div
                className="layout-view"
                ref={layoutViewRef}
                style={{ '--page-width': zoom + 'px' }}
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
