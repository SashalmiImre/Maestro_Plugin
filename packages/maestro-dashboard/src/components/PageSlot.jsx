/**
 * Maestro Dashboard — Egyetlen oldal-slot (React.memo)
 *
 * ★ A villódzás-mentesség kulcsa: az <img> tag nem renderelődik újra,
 *   ha a thumbnailUrl nem változik.
 */

import React from 'react';
import { STATUS_COLORS } from '../config.js';
import ValidationIcons from './ValidationIcons.jsx';

const PageSlot = React.memo(function PageSlot({ pageData, pageNum, validationItems }) {
    // Üres hely (pl. címlap bal oldala)
    if (!pageData && pageNum === null) {
        return <div className="page-slot empty-slot" />;
    }

    // Placeholder (nincs thumbnail)
    if (!pageData || !pageData.thumbnailUrl) {
        return (
            <div className="page-slot placeholder">
                <div className="page-thumb-area">
                    <span className="page-number">{pageNum || '?'}</span>
                </div>
                <div className="page-info">
                    <span className="page-number">{pageNum || '?'}</span>
                </div>
            </div>
        );
    }

    // Állapot szín sáv
    const stateColor = pageData.state != null
        ? (STATUS_COLORS[pageData.state] || '#999')
        : '#999';
    const ignoredClass = pageData.ignored ? ' ignored' : '';
    const fallbackClass = pageData.isFallback ? ' fallback' : '';

    return (
        <div className={`page-slot${ignoredClass}${fallbackClass}`}>
            <div className="page-image">
                <img
                    src={pageData.thumbnailUrl}
                    alt={`${pageData.pageNum}. oldal`}
                    loading="lazy"
                />
                {pageData.conflict && (
                    <div
                        className="page-conflict-badge"
                        title={`Oldalütközés: ${pageData.conflictArticles.join(', ')}`}
                    >
                        <svg width="16" height="16" viewBox="0 0 14 14">
                            <path d="M7 1L13 13H1L7 1Z" fill="#ea580c"/>
                            <path d="M7 5.5v3" stroke="white" strokeWidth="1.5" strokeLinecap="round"/>
                            <circle cx="7" cy="10.5" r="0.8" fill="white"/>
                        </svg>
                    </div>
                )}
                <ValidationIcons
                    items={validationItems}
                    className="page-validation-badge"
                    size={16}
                />
            </div>
            <div className="page-state-bar" style={{ backgroundColor: stateColor }} />
            <div className="page-info">
                <span className="page-number">{pageData.pageNum}</span>
                <span className="article-name" title={pageData.articleName}>
                    {pageData.articleName}
                </span>
            </div>
        </div>
    );
});

export default PageSlot;
