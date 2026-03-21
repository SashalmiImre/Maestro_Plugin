/**
 * Maestro Dashboard — Cikk tábla
 *
 * Rendezés, sürgősség háttér, validáció ikonok.
 * React.memo ArticleRow-val a villódzás-mentes frissítéshez.
 */

import React, { useState, useMemo, useCallback } from 'react';
import { useAuth } from '../contexts/AuthContext.jsx';
import { useData } from '../contexts/DataContext.jsx';
import { LOCK_TYPE, VALIDATION_TYPES } from '../config.js';
import { useUrgency } from '../hooks/useUrgency.js';
import ArticleRow from './ArticleRow.jsx';

const MAX_PAGE_SORT_FALLBACK = 99999;

export default function ArticleTable({ filteredArticles }) {
    const { user } = useAuth();
    const { deadlines, validations, getMemberName, publications, activePublicationId } = useData();
    const [sortColumn, setSortColumn] = useState('range');
    const [sortDirection, setSortDirection] = useState('asc');

    // Sürgősség-számítás
    const { urgencyMap } = useUrgency(filteredArticles, deadlines);

    // Validáció indexelés
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

    // Rendezés
    const sorted = useMemo(() => {
        const arr = [...filteredArticles];
        arr.sort((a, b) => {
            let valA, valB;

            switch (sortColumn) {
                case 'range':
                    valA = a.startPage || MAX_PAGE_SORT_FALLBACK;
                    valB = b.startPage || MAX_PAGE_SORT_FALLBACK;
                    break;
                case 'name':
                    valA = a.name ? a.name.toLowerCase() : '';
                    valB = b.name ? b.name.toLowerCase() : '';
                    break;
                case 'lock':
                    valA = getLockSortValue(a, user, getMemberName);
                    valB = getLockSortValue(b, user, getMemberName);
                    break;
                case 'state':
                    valA = a.state ?? 0;
                    valB = b.state ?? 0;
                    break;
                case 'validator':
                    valA = getValidationSeverity(a, validationIndex);
                    valB = getValidationSeverity(b, validationIndex);
                    break;
                default:
                    valA = a[sortColumn];
                    valB = b[sortColumn];
            }

            if (valA < valB) return sortDirection === 'asc' ? -1 : 1;
            if (valA > valB) return sortDirection === 'asc' ? 1 : -1;

            // Másodlagos rendezés: név
            if (sortColumn !== 'name') {
                const nameA = a.name ? a.name.toLowerCase() : '';
                const nameB = b.name ? b.name.toLowerCase() : '';
                if (nameA < nameB) return -1;
                if (nameA > nameB) return 1;
            }

            return 0;
        });
        return arr;
    }, [filteredArticles, sortColumn, sortDirection, validationIndex, user, getMemberName]);

    // Kiadvány (maxPage a zero-padding-hez)
    const maxPage = useMemo(() => {
        const pub = publications.find(p => p.$id === activePublicationId);
        return pub?.coverageEnd || 999;
    }, [publications, activePublicationId]);

    const handleSort = useCallback((col) => {
        setSortColumn(prev => {
            if (prev === col) {
                setSortDirection(d => d === 'asc' ? 'desc' : 'asc');
                return prev;
            }
            setSortDirection('asc');
            return col;
        });
    }, []);

    if (!filteredArticles || filteredArticles.length === 0) {
        return <div className="empty-state">Nincsenek cikkek</div>;
    }

    return (
        <table className="article-table">
            <thead>
                <tr>
                    <SortHeader id="range" label="Terj." cssClass="col-range"
                        sortColumn={sortColumn} sortDirection={sortDirection} onSort={handleSort} />
                    <SortHeader id="name" label="Cikknév" cssClass="col-name"
                        sortColumn={sortColumn} sortDirection={sortDirection} onSort={handleSort} />
                    <SortHeader id="lock" label="Zárolta" cssClass="col-lock"
                        sortColumn={sortColumn} sortDirection={sortDirection} onSort={handleSort} />
                    <SortHeader id="state" label="Státusz" cssClass="col-state"
                        sortColumn={sortColumn} sortDirection={sortDirection} onSort={handleSort} />
                    <SortHeader id="validator" label="⚠" cssClass="col-validate"
                        sortColumn={sortColumn} sortDirection={sortDirection} onSort={handleSort} />
                </tr>
            </thead>
            <tbody>
                {sorted.map(article => (
                    <ArticleRow
                        key={article.$id}
                        article={article}
                        maxPage={maxPage}
                        urgency={urgencyMap.get(article.$id)}
                        validationItems={validationIndex.get(article.$id) || null}
                        currentUser={user}
                        getMemberName={getMemberName}
                    />
                ))}
            </tbody>
        </table>
    );
}

// ─── Rendezés fejléc ────────────────────────────────────────────────────────

function SortHeader({ id, label, cssClass, sortColumn, sortDirection, onSort }) {
    const isSorted = sortColumn === id;
    const arrow = isSorted ? (sortDirection === 'asc' ? '▲' : '▼') : '';

    return (
        <th
            className={`${cssClass} ${isSorted ? 'sorted' : ''}`}
            onClick={() => onSort(id)}
            style={{ cursor: 'pointer' }}
        >
            {label}<span className="sort-arrow">{arrow}</span>
        </th>
    );
}

// ─── Segédfüggvények ────────────────────────────────────────────────────────

function getLockSortValue(article, currentUser, getMemberName) {
    if (!article.lockOwnerId) return '';
    if (article.lockType === LOCK_TYPE.SYSTEM) return 'maestro';
    if (article.lockOwnerId === currentUser?.$id) return 'én';
    return getMemberName(article.lockOwnerId) || 'más';
}

function getValidationSeverity(article, validationMap) {
    const items = validationMap.get(article.$id);
    if (!items) return 0;
    if (items.some(i => i.type === VALIDATION_TYPES.ERROR)) return 2;
    if (items.some(i => i.type === VALIDATION_TYPES.WARNING)) return 1;
    return 0;
}
