/**
 * Maestro Dashboard — Data Context
 *
 * Központi adat állapot: kiadványok, cikkek, határidők, validációk.
 * Appwrite REST lekérés + Realtime szinkronizáció.
 */

import React, { createContext, useContext, useState, useCallback, useEffect, useRef } from 'react';
import { Databases, Storage, Query } from 'appwrite';
import { getClient } from './AuthContext.jsx';
import {
    DATABASE_ID, COLLECTIONS, BUCKETS,
    PAGE_SIZE, TEAM_CACHE_DURATION_MS
} from '../config.js';

const DataContext = createContext(null);

export function useData() {
    return useContext(DataContext);
}

export function DataProvider({ children }) {
    const [publications, setPublications] = useState([]);
    const [articles, setArticles] = useState([]);
    const [layouts, setLayouts] = useState([]);
    const [deadlines, setDeadlines] = useState([]);
    const [validations, setValidations] = useState([]);
    const [workflow, setWorkflow] = useState(null);
    const [activePublicationId, setActivePublicationIdState] = useState(null);
    const [isLoading, setIsLoading] = useState(false);

    // Ref-ek a Realtime handler számára (stabil referencia)
    const activePublicationIdRef = useRef(null);
    // Az aktuális kiadvány article $id-jainak Set-je — validáció Realtime szűréshez
    const articleIdsRef = useRef(new Set());

    // Appwrite szolgáltatások
    const servicesRef = useRef(null);
    if (!servicesRef.current) {
        const client = getClient();
        servicesRef.current = {
            databases: new Databases(client),
            storage: new Storage(client)
        };
    }
    const { databases, storage } = servicesRef.current;

    // Csapattag cache
    const memberCacheRef = useRef({ map: new Map(), time: 0 });

    // ─── Kiadványok lekérése ────────────────────────────────────────────────

    const fetchPublications = useCallback(async () => {
        const allDocuments = [];
        let offset = 0;

        while (true) {
            const result = await databases.listDocuments({
                databaseId: DATABASE_ID,
                collectionId: COLLECTIONS.PUBLICATIONS,
                queries: [
                    Query.limit(PAGE_SIZE),
                    Query.offset(offset),
                    Query.orderAsc('name')
                ]
            });
            allDocuments.push(...result.documents);
            if (result.documents.length < PAGE_SIZE) break;
            offset += PAGE_SIZE;
        }

        setPublications(allDocuments);
        return allDocuments;
    }, [databases]);

    // ─── Kiadvány váltás ────────────────────────────────────────────────────

    const switchPublication = useCallback(async (publicationId) => {
        activePublicationIdRef.current = publicationId;
        setActivePublicationIdState(publicationId);
        setLayouts([]);
        setIsLoading(true);

        try {
            // 1. fázis: cikkek, layoutok, határidők párhuzamosan
            const [articlesResult, layoutsResult, deadlinesResult] = await Promise.all([
                databases.listDocuments({
                    databaseId: DATABASE_ID,
                    collectionId: COLLECTIONS.ARTICLES,
                    queries: [
                        Query.equal('publicationId', publicationId),
                        Query.limit(1000),
                        Query.orderAsc('startPage')
                    ]
                }).catch(() => ({ documents: [] })),
                databases.listDocuments({
                    databaseId: DATABASE_ID,
                    collectionId: COLLECTIONS.LAYOUTS,
                    queries: [
                        Query.equal('publicationId', publicationId),
                        Query.limit(100),
                        Query.orderAsc('order')
                    ]
                }).catch(() => ({ documents: [] })),
                databases.listDocuments({
                    databaseId: DATABASE_ID,
                    collectionId: COLLECTIONS.DEADLINES,
                    queries: [
                        Query.equal('publicationId', publicationId),
                        Query.limit(100)
                    ]
                }).catch(() => ({ documents: [] }))
            ]);

            setArticles(articlesResult.documents);
            setLayouts(layoutsResult.documents);
            setDeadlines(deadlinesResult.documents);

            // articleIdsRef szinkronizálása — Realtime szűréshez
            articleIdsRef.current = new Set(articlesResult.documents.map(a => a.$id));

            // 2. fázis: validációk articleId alapján (plugin DataContext mintájára)
            const articleIds = articlesResult.documents.map(a => a.$id);
            let allValidations = [];

            try {
                if (articleIds.length > 0) {
                    const CHUNK_SIZE = 100;
                    const chunks = [];
                    for (let i = 0; i < articleIds.length; i += CHUNK_SIZE) {
                        chunks.push(articleIds.slice(i, i + CHUNK_SIZE));
                    }

                    // Mindkét validáció kollekció lekérése párhuzamosan, kötegelt articleId lekérdezéssel
                    const [userValResults, sysValResults] = await Promise.all([
                        Promise.all(chunks.map(ids =>
                            databases.listDocuments({
                                databaseId: DATABASE_ID,
                                collectionId: COLLECTIONS.USER_VALIDATIONS,
                                queries: [
                                    Query.equal('articleId', ids),
                                    Query.limit(Math.min(5000, ids.length * 10))
                                ]
                            }).catch(() => ({ documents: [] }))
                        )),
                        Promise.all(chunks.map(ids =>
                            databases.listDocuments({
                                databaseId: DATABASE_ID,
                                collectionId: COLLECTIONS.SYSTEM_VALIDATIONS,
                                queries: [
                                    Query.equal('articleId', ids),
                                    Query.limit(Math.min(5000, ids.length * 5))
                                ]
                            }).catch(() => ({ documents: [] }))
                        ))
                    ]);

                    const userValidationDocs = userValResults.flatMap(r => r.documents);
                    const sysValidationDocs = sysValResults.flatMap(r => r.documents);
                    const flatSysValidations = sysValidationDocs.flatMap(flattenSystemValidationRecord);
                    allValidations = [...flatSysValidations, ...userValidationDocs];
                }
            } catch {
                // Hálózati hiba esetén üres validáció-lista (stale adat elkerülése)
                allValidations = [];
            }

            setValidations(allValidations);
        } finally {
            setIsLoading(false);
        }
    }, [databases]);

    // ─── Csoporttag feloldás ────────────────────────────────────────────────

    const fetchAllGroupMembers = useCallback(async () => {
        const cache = memberCacheRef.current;
        const now = Date.now();
        if (cache.map.size > 0 && (now - cache.time) < TEAM_CACHE_DURATION_MS) {
            return cache.map;
        }

        const editorialOfficeId = localStorage.getItem('maestro.activeEditorialOfficeId');
        if (!editorialOfficeId) return new Map();

        try {
            const result = await databases.listDocuments({
                databaseId: DATABASE_ID,
                collectionId: COLLECTIONS.GROUP_MEMBERSHIPS,
                queries: [
                    Query.equal('editorialOfficeId', editorialOfficeId),
                    Query.limit(500)
                ]
            });

            const map = new Map();
            for (const m of result.documents) {
                if (!map.has(m.userId)) {
                    map.set(m.userId, m.userName || '');
                }
            }

            memberCacheRef.current = { map, time: now };
            return map;
        } catch {
            return new Map();
        }
    }, [databases]);

    const getMemberName = useCallback((userId) => {
        return memberCacheRef.current.map.get(userId) || null;
    }, []);

    // ─── Workflow lekérés ────────────────────────────────────────────────────

    const fetchWorkflow = useCallback(async () => {
        const editorialOfficeId = localStorage.getItem('maestro.activeEditorialOfficeId');
        if (!editorialOfficeId) { setWorkflow(null); return; }

        try {
            const result = await databases.listDocuments({
                databaseId: DATABASE_ID,
                collectionId: COLLECTIONS.WORKFLOWS,
                queries: [
                    Query.equal('editorialOfficeId', editorialOfficeId),
                    Query.limit(1)
                ]
            });
            if (result.documents.length > 0) {
                const doc = result.documents[0];
                const compiled = typeof doc.compiled === 'string' ? JSON.parse(doc.compiled) : doc.compiled;
                setWorkflow(compiled);
            } else {
                setWorkflow(null);
            }
        } catch (err) {
            console.error('[DataContext] Workflow fetch hiba:', err);
        }
    }, [databases]);

    // Workflow betöltése induláskor
    useEffect(() => {
        fetchWorkflow();
    }, [fetchWorkflow]);

    // ─── Realtime feliratkozás ──────────────────────────────────────────────

    useEffect(() => {
        const client = getClient();
        const channelName = (collection) =>
            `databases.${DATABASE_ID}.collections.${collection}.documents`;

        const unsubscribe = client.subscribe([
            channelName(COLLECTIONS.ARTICLES),
            channelName(COLLECTIONS.PUBLICATIONS),
            channelName(COLLECTIONS.LAYOUTS),
            channelName(COLLECTIONS.DEADLINES),
            channelName(COLLECTIONS.USER_VALIDATIONS),
            channelName(COLLECTIONS.SYSTEM_VALIDATIONS),
            channelName(COLLECTIONS.WORKFLOWS)
        ], (response) => {
            const eventType = getEventType(response.events);
            if (!eventType) return;

            const collection = getCollection(response.channels);
            if (!collection) return;

            const payload = response.payload;

            try {
                switch (collection) {
                    case 'articles':
                        applyArticleEvent(eventType, payload, activePublicationIdRef, setArticles);
                        break;
                    case 'publications':
                        applyPublicationEvent(eventType, payload, setPublications);
                        break;
                    case 'layouts':
                        applyLayoutEvent(eventType, payload, activePublicationIdRef, setLayouts);
                        break;
                    case 'deadlines':
                        applyDeadlineEvent(eventType, payload, activePublicationIdRef, setDeadlines);
                        break;
                    case 'validations':
                        applyValidationEvent(eventType, payload, articleIdsRef, setValidations);
                        break;
                    case 'system_validations':
                        applySystemValidationEvent(eventType, payload, articleIdsRef, setValidations);
                        break;
                    case 'workflows': {
                        const activeOfficeId = localStorage.getItem('maestro.activeEditorialOfficeId');
                        if (eventType === 'delete') {
                            // Workflow doc törölve → újralekérés (fetchWorkflow kezeli a null esetet)
                            fetchWorkflow();
                        } else if (payload.compiled && payload.editorialOfficeId === activeOfficeId) {
                            try {
                                const compiled = typeof payload.compiled === 'string' ? JSON.parse(payload.compiled) : payload.compiled;
                                setWorkflow(compiled);
                            } catch { /* parse error */ }
                        }
                        break;
                    }
                }
            } catch (error) {
                console.error('Realtime event handler error', {
                    eventType, collection,
                    error: error?.message || error
                });
            }
        });

        return () => unsubscribe();
    }, []);

    const value = {
        publications, articles, layouts, deadlines, validations, workflow,
        activePublicationId, isLoading, storage,
        fetchPublications, switchPublication, fetchWorkflow,
        fetchAllGroupMembers, getMemberName
    };

    return (
        <DataContext.Provider value={value}>
            {children}
        </DataContext.Provider>
    );
}

// ─── Realtime segédfüggvények ──────────────────────────────────────────────

function getEventType(events) {
    for (const e of events) {
        if (e.includes('.create')) return 'create';
        if (e.includes('.update')) return 'update';
        if (e.includes('.delete')) return 'delete';
    }
    return null;
}

function getCollection(channels) {
    for (const ch of channels) {
        if (ch.includes(COLLECTIONS.ARTICLES)) return 'articles';
        if (ch.includes(COLLECTIONS.PUBLICATIONS)) return 'publications';
        if (ch.includes(COLLECTIONS.LAYOUTS)) return 'layouts';
        if (ch.includes(COLLECTIONS.DEADLINES)) return 'deadlines';
        if (ch.includes(COLLECTIONS.USER_VALIDATIONS)) return 'validations';
        if (ch.includes(COLLECTIONS.SYSTEM_VALIDATIONS)) return 'system_validations';
        if (ch.includes(COLLECTIONS.WORKFLOWS)) return 'workflows';
    }
    return null;
}

function applyArticleEvent(eventType, payload, pubIdRef, setArticles) {
    if (payload.publicationId !== pubIdRef.current) return;

    if (eventType === 'delete') {
        setArticles(prev => prev.filter(a => a.$id !== payload.$id));
    } else {
        setArticles(prev => {
            const idx = prev.findIndex(a => a.$id === payload.$id);
            if (idx >= 0) {
                // Elavulás-védelem
                const local = prev[idx];
                if (local.$updatedAt && payload.$updatedAt &&
                    new Date(local.$updatedAt) > new Date(payload.$updatedAt)) {
                    return prev;
                }
                const next = [...prev];
                next[idx] = payload;
                return next;
            }
            return [...prev, payload];
        });
    }
}

function applyPublicationEvent(eventType, payload, setPublications) {
    if (eventType === 'delete') {
        setPublications(prev => prev.filter(p => p.$id !== payload.$id));
    } else {
        setPublications(prev => {
            const idx = prev.findIndex(p => p.$id === payload.$id);
            if (idx >= 0) {
                const next = [...prev];
                next[idx] = payload;
                return next;
            }
            return [...prev, payload];
        });
    }
}

function applyLayoutEvent(eventType, payload, pubIdRef, setLayouts) {
    if (payload.publicationId !== pubIdRef.current) return;

    if (eventType === 'delete') {
        setLayouts(prev => prev.filter(l => l.$id !== payload.$id));
    } else {
        setLayouts(prev => {
            const idx = prev.findIndex(l => l.$id === payload.$id);
            if (idx >= 0) {
                const local = prev[idx];
                if (local.$updatedAt && payload.$updatedAt &&
                    new Date(local.$updatedAt) > new Date(payload.$updatedAt)) {
                    return prev;
                }
                const next = [...prev];
                next[idx] = payload;
                return next;
            }
            return [...prev, payload].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
        });
    }
}

function applyDeadlineEvent(eventType, payload, pubIdRef, setDeadlines) {
    if (payload.publicationId !== pubIdRef.current) return;

    if (eventType === 'delete') {
        setDeadlines(prev => prev.filter(d => d.$id !== payload.$id));
    } else {
        setDeadlines(prev => {
            const idx = prev.findIndex(d => d.$id === payload.$id);
            if (idx >= 0) {
                const next = [...prev];
                next[idx] = payload;
                return next;
            }
            return [...prev, payload];
        });
    }
}

function applyValidationEvent(eventType, payload, articleIdsRef, setValidations) {
    // userValidations: csak az aktív kiadvány cikkeihez tartozó eseményeket kezeljük.
    // Delete esetén $id alapján szűrünk (a cikk már törölve lehet az articleIdsRef-ből).
    if (eventType === 'delete') {
        setValidations(prev => prev.filter(v => v.$id !== payload.$id));
        return;
    }
    if (!articleIdsRef.current.has(payload.articleId)) return;
    setValidations(prev => {
        const idx = prev.findIndex(v => v.$id === payload.$id);
        if (idx >= 0) {
            const next = [...prev];
            next[idx] = payload;
            return next;
        }
        return [...prev, payload];
    });
}

/**
 * Egy `validations` (rendszer) rekordból lapos validáció-itemeket generál,
 * amelyek kompatibilisek az ArticleTable validationIndex formátumával.
 *
 * @param {Object} record - Appwrite validations rekord (errors[], warnings[], articleId, source)
 * @returns {Array} Lapos validáció-itemek tömbje
 */
function flattenSystemValidationRecord(record) {
    const errors = (record.errors || []).map((msg, i) => ({
        $id: `${record.$id}-e-${i}`,
        articleId: record.articleId,
        type: 'error',
        description: msg,
        source: record.source,
        isResolved: false
    }));
    const warnings = (record.warnings || []).map((msg, i) => ({
        $id: `${record.$id}-w-${i}`,
        articleId: record.articleId,
        type: 'warning',
        description: msg,
        source: record.source,
        isResolved: false
    }));
    return [...errors, ...warnings];
}

/**
 * Realtime handler a `validations` (rendszer) kollekció eseményeire.
 * Egy rekord create/update esetén az adott articleId + source kombinációhoz tartozó
 * összes lapos itemet lecseréli az újra lapított eredménnyel.
 */
function applySystemValidationEvent(eventType, payload, articleIdsRef, setValidations) {
    // system validations: csak az aktív kiadvány cikkeihez tartozó eseményeket kezeljük.
    // Delete esetén articleId + source alapján törlünk, ha még szerepel a state-ben.
    const { articleId, source } = payload;

    if (eventType !== 'delete' && !articleIdsRef.current.has(articleId)) return;

    setValidations(prev => {
        // Régi lapos itemek eltávolítása erre az articleId + source párra
        const filtered = prev.filter(v => !(v.articleId === articleId && v.source === source));
        if (eventType === 'delete') return filtered;
        // Új lapos itemek hozzáadása
        return [...filtered, ...flattenSystemValidationRecord(payload)];
    });
}
