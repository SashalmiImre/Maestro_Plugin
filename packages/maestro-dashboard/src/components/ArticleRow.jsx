/**
 * Maestro Dashboard — Egyetlen cikk sor (React.memo)
 *
 * ★ A villódzás-mentesség kulcsa: csak akkor renderel újra,
 *   ha ennek a cikknek az adata ténylegesen változott.
 */

import React from 'react';
import { WORKFLOW_CONFIG, MARKERS, LOCK_TYPE, VALIDATION_TYPES } from '../config.js';

const ArticleRow = React.memo(function ArticleRow({
    article, maxPage, urgency, validationItems, currentUser, getMemberName
}) {
    // Placeholder sor — szürke, nem interaktív
    if (article.isPlaceholder) {
        return (
            <tr className="placeholder-row">
                <td className="col-range">
                    <PageRange article={article} maxPage={maxPage} />
                </td>
                <td className="col-name">
                    <span className="placeholder-name">Nincs hozzárendelt cikk</span>
                </td>
                <td className="col-lock" />
                <td className="col-state" />
                <td className="col-validate" />
            </tr>
        );
    }

    const bgStyle = urgency?.background ? { background: urgency.background } : undefined;

    return (
        <tr style={bgStyle}>
            <td className="col-range">
                <PageRange article={article} maxPage={maxPage} />
            </td>
            <td className="col-name">
                {article.name
                    ? article.name
                    : <span className="article-unnamed">Névtelen</span>
                }
            </td>
            <td className="col-lock">
                <LockLabel article={article} currentUser={currentUser} getMemberName={getMemberName} />
            </td>
            <td className="col-state">
                <StateIndicator article={article} />
            </td>
            <td className="col-validate">
                <ValidationIcons items={validationItems} />
            </td>
        </tr>
    );
});

export default ArticleRow;

// ─── Cella komponensek ──────────────────────────────────────────────────────

function PageRange({ article, maxPage }) {
    if (!article.startPage) return null;
    const padding = String(maxPage).length;
    const pad = (n) => String(n).padStart(padding, '0');
    const start = pad(article.startPage);

    if (article.endPage && article.endPage !== article.startPage) {
        return <span className="page-range">{start}–{pad(article.endPage)}</span>;
    }
    return <span className="page-range">{start}</span>;
}

function LockLabel({ article, currentUser, getMemberName }) {
    if (!article.lockOwnerId) return null;

    let label;
    if (article.lockType === LOCK_TYPE.SYSTEM) {
        label = 'MAESTRO';
    } else if (article.lockOwnerId === currentUser?.$id) {
        label = 'ÉN';
    } else {
        const name = getMemberName(article.lockOwnerId);
        label = name ? name.toUpperCase() : 'MÁS';
    }

    return <span className="lock-label">{label}</span>;
}

function StateIndicator({ article }) {
    const state = article.state ?? 0;
    const config = WORKFLOW_CONFIG[state];
    const markers = typeof article.markers === 'number' ? article.markers : 0;
    const isIgnored = (markers & MARKERS.IGNORE) !== 0;
    const color = isIgnored ? '#9E9E9E' : (config?.color || '#999');
    const label = config?.label || 'Ismeretlen';
    const suffix = isIgnored ? ' (Kimarad)' : '';

    return (
        <span
            className="state-dot"
            style={{ backgroundColor: color }}
            title={label + suffix}
        />
    );
}

function ValidationIcons({ items }) {
    if (!items || items.length === 0) return null;

    const hasErrors = items.some(i => i.type === VALIDATION_TYPES.ERROR);
    const hasWarnings = items.some(i => i.type === VALIDATION_TYPES.WARNING);

    const tooltip = items.map(i => {
        const prefix = i.type === VALIDATION_TYPES.ERROR
            ? (i.source === 'user' ? '[Gond]' : '[Hiba]')
            : (i.source === 'user' ? '[Infó]' : '[Figy.]');
        return `${prefix} ${i.message}`;
    }).join('\n');

    return (
        <div className="validation-icons" title={tooltip}>
            {hasErrors && (
                <svg width="14" height="14" viewBox="0 0 14 14">
                    <circle cx="7" cy="7" r="6" fill="#dc2626"/>
                    <path d="M4.5 4.5l5 5M9.5 4.5l-5 5" stroke="white" strokeWidth="1.5" strokeLinecap="round"/>
                </svg>
            )}
            {hasWarnings && (
                <svg width="14" height="14" viewBox="0 0 14 14">
                    <path d="M7 1L13 13H1L7 1Z" fill="#ea580c"/>
                    <path d="M7 5.5v3" stroke="white" strokeWidth="1.5" strokeLinecap="round"/>
                    <circle cx="7" cy="10.5" r="0.8" fill="white"/>
                </svg>
            )}
        </div>
    );
}
