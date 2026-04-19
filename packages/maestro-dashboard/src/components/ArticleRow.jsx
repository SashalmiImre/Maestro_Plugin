/**
 * Maestro Dashboard — Egyetlen cikk sor (React.memo)
 *
 * ★ A villódzás-mentesség kulcsa: csak akkor renderel újra,
 *   ha ennek a cikknek az adata ténylegesen változott.
 */

import React from 'react';
import { MARKERS, LOCK_TYPE } from '../config.js';
import { useData } from '../contexts/DataContext.jsx';
import { getStateConfig } from '@shared/workflowRuntime.js';
import ValidationIcons from './ValidationIcons.jsx';

const ArticleRow = React.memo(function ArticleRow({
    article, maxPage, urgency, validationItems, currentUser, getMemberName
}) {
    // data-label attribútumok a mobil card nézethez (responsive.css).
    // A tablet-en+ felett ignorálva (table cellák maradnak), mobilon a ::before
    // pseudo-elem olvassa ki a címket a cella elé.
    // Placeholder sor — szürke, nem interaktív
    if (article.isPlaceholder) {
        return (
            <tr className="placeholder-row">
                <td className="col-range" data-label="Terj.">
                    <PageRange article={article} maxPage={maxPage} />
                </td>
                <td className="col-name" data-label="Cikknév">
                    <span className="placeholder-name">Nincs hozzárendelt cikk</span>
                </td>
                <td className="col-lock" data-label="Zárolta" />
                <td className="col-state" data-label="Státusz" />
                <td className="col-validate" data-label="Validáció" />
            </tr>
        );
    }

    const bgStyle = urgency?.background ? { background: urgency.background } : undefined;

    return (
        <tr style={bgStyle}>
            <td className="col-range" data-label="Terj.">
                <PageRange article={article} maxPage={maxPage} />
            </td>
            <td className="col-name" data-label="Cikknév">
                {article.name
                    ? article.name
                    : <span className="article-unnamed">Névtelen</span>
                }
            </td>
            <td className="col-lock" data-label="Zárolta">
                <LockLabel article={article} currentUser={currentUser} getMemberName={getMemberName} />
            </td>
            <td className="col-state" data-label="Státusz">
                <StateIndicator article={article} />
            </td>
            <td className="col-validate" data-label="Validáció">
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
    const { workflow } = useData();
    const state = article.state || "";
    const config = getStateConfig(workflow, state);
    const markers = typeof article.markers === 'number' ? article.markers : 0;
    const isIgnored = (markers & MARKERS.IGNORE) !== 0;
    const color = isIgnored ? '#9E9E9E' : (config?.color || '#999');
    const label = config?.label || 'Ismeretlen';
    const suffix = isIgnored ? ' (Kimarad)' : '';
    const fullLabel = label + suffix;

    return (
        <span
            className="state-cell"
            title={fullLabel}
            aria-label={`Állapot: ${fullLabel}`}
        >
            <span
                className="state-dot"
                style={{ backgroundColor: color, color }}
                aria-hidden="true"
            />
            <span className="state-label">{fullLabel}</span>
        </span>
    );
}

