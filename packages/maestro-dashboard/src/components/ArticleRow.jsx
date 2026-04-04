/**
 * Maestro Dashboard — Egyetlen cikk sor (React.memo)
 *
 * ★ A villódzás-mentesség kulcsa: csak akkor renderel újra,
 *   ha ennek a cikknek az adata ténylegesen változott.
 */

import React from 'react';
import { WORKFLOW_CONFIG, MARKERS, LOCK_TYPE } from '../config.js';
import ValidationIcons from './ValidationIcons.jsx';

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
    let variant;
    if (article.lockType === LOCK_TYPE.SYSTEM) {
        label = 'MAESTRO';
        variant = 'maestro';
    } else if (article.lockOwnerId === currentUser?.$id) {
        label = 'ÉN';
        variant = 'me';
    } else {
        const name = getMemberName(article.lockOwnerId);
        label = name ? name.toUpperCase() : 'MÁS';
        variant = 'other';
    }

    return <span className={`lock-label lock-label--${variant}`}>{label}</span>;
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
            style={{ backgroundColor: color, color }}
            title={label + suffix}
        />
    );
}

