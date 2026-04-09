/**
 * Maestro Dashboard — StateNode
 *
 * Custom xyflow node típus a workflow állapotok megjelenítéséhez.
 * Színes accent sáv, címke, slug ID, duration, badge-ek, handle-ek.
 */

import React, { memo } from 'react';
import { Handle, Position } from '@xyflow/react';

/**
 * Validátor ID rövidítések a badge-ekhez.
 */
function validatorBadge(v) {
    const id = typeof v === 'string' ? v : v?.validator;
    if (!id) return null;
    switch (id) {
        case 'file_accessible':       return 'FA';
        case 'page_number_check':     return 'PN';
        case 'filename_verification': return 'FN';
        case 'preflight_check':       return 'PF';
        default:                      return id.slice(0, 2).toUpperCase();
    }
}

/**
 * Duration kijelzés formázás.
 *
 * @param {{ perPage?: number, fixed?: number }} duration
 * @returns {string}
 */
function formatDuration(duration) {
    if (!duration) return '';
    const parts = [];
    if (duration.perPage) parts.push(`${duration.perPage} min/oldal`);
    if (duration.fixed) parts.push(`${duration.fixed} min fix`);
    return parts.join(' + ') || '—';
}

function StateNode({ data, selected }) {
    const { label, color, duration, isInitial, isTerminal, validations, commands } = data;

    // Összegyűjtött validátor badge-ek (requiredToEnter + requiredToExit, deduplikálva)
    const validatorBadges = [];
    const seen = new Set();
    for (const list of [validations?.requiredToEnter, validations?.requiredToExit]) {
        if (!Array.isArray(list)) continue;
        for (const v of list) {
            const badge = validatorBadge(v);
            if (badge && !seen.has(badge)) {
                seen.add(badge);
                validatorBadges.push(badge);
            }
        }
    }

    // Parancs badge-ek (első 3)
    const commandBadges = (commands || []).slice(0, 3).map(c => c.id);

    return (
        <div
            className={`state-node ${selected ? 'state-node--selected' : ''}`}
            style={{ '--node-color': color || '#888' }}
        >
            {/* Szín accent sáv */}
            <div className="state-node__accent" />

            {/* Handle: input (bal) */}
            {!isInitial && (
                <Handle type="target" position={Position.Left} className="state-node__handle" />
            )}

            {/* Tartalom */}
            <div className="state-node__body">
                <div className="state-node__label">{label}</div>
                <div className="state-node__id">{data.label !== data.id ? data.id || '' : ''}</div>

                <div className="state-node__duration">{formatDuration(duration)}</div>

                {/* Badge-ek */}
                {(validatorBadges.length > 0 || commandBadges.length > 0) && (
                    <div className="state-node__badges">
                        {validatorBadges.map(b => (
                            <span key={b} className="state-node__badge state-node__badge--validator" title={b}>
                                {b}
                            </span>
                        ))}
                        {commandBadges.map(c => (
                            <span key={c} className="state-node__badge state-node__badge--command" title={c}>
                                {c.split('_').map(w => w[0]).join('').toUpperCase()}
                            </span>
                        ))}
                    </div>
                )}

                {/* Státusz ikonok */}
                {(isInitial || isTerminal) && (
                    <div className="state-node__status">
                        {isInitial && <span className="state-node__status-icon state-node__status-icon--initial" title="Kezdőállapot">●</span>}
                        {isTerminal && <span className="state-node__status-icon state-node__status-icon--terminal" title="Végállapot">■</span>}
                    </div>
                )}
            </div>

            {/* Handle: output (jobb) */}
            {!isTerminal && (
                <Handle type="source" position={Position.Right} className="state-node__handle" />
            )}
        </div>
    );
}

export default memo(StateNode);
