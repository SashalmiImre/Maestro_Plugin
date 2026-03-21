/**
 * Maestro Dashboard — Tartalom fejléc
 *
 * Cím, nézet váltó, cikkszám, szűrő gomb.
 */

import React from 'react';

export default function ContentHeader({
    title, articleCount, activeView, onViewChange,
    isFilterActive, onFilterToggle
}) {
    return (
        <div className="content-header">
            <h2>{title}</h2>
            <div className="content-header-actions">
                <div className="view-toggle">
                    <button
                        className={`view-btn ${activeView === 'table' ? 'active' : ''}`}
                        title="Táblázat nézet"
                        onClick={() => onViewChange('table')}
                    >
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                            <line x1="3" y1="6" x2="21" y2="6"/>
                            <line x1="3" y1="12" x2="21" y2="12"/>
                            <line x1="3" y1="18" x2="21" y2="18"/>
                        </svg>
                    </button>
                    <button
                        className={`view-btn ${activeView === 'layout' ? 'active' : ''}`}
                        title="Elrendezés nézet"
                        onClick={() => onViewChange('layout')}
                    >
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                            <rect x="3" y="3" width="7" height="7" rx="1"/>
                            <rect x="14" y="3" width="7" height="7" rx="1"/>
                            <rect x="3" y="14" width="7" height="7" rx="1"/>
                            <rect x="14" y="14" width="7" height="7" rx="1"/>
                        </svg>
                    </button>
                </div>
                <span className="article-count">{articleCount} cikk</span>
                <button
                    className={`filter-toggle-btn ${isFilterActive ? 'active' : ''}`}
                    title="Szűrők"
                    onClick={onFilterToggle}
                    style={isFilterActive ? { color: '#3b82f6', borderColor: '#3b82f6' } : {}}
                >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <polygon points="22,3 2,3 10,12.46 10,19 14,21 14,12.46"/>
                    </svg>
                </button>
            </div>
        </div>
    );
}
