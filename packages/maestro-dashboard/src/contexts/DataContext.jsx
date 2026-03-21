/**
 * Maestro Dashboard — Data Context
 *
 * Központi adat állapot: kiadványok, cikkek, határidők, validációk.
 * Appwrite REST lekérés + Realtime szinkronizáció.
 */

import React, { createContext, useContext, useState, useCallback, useEffect, useRef } from 'react';
import { Databases, Functions, Storage, Query } from 'appwrite';
import { getClient } from './AuthContext.jsx';
import {
    DATABASE_ID, COLLECTIONS, TEAMS, BUCKETS,
    GET_TEAM_MEMBERS_FUNCTION_ID,
    PAGE_SIZE, TEAM_CACHE_DURATION_MS
} from '../config.js';

const DataContext = createContext(null);

export function useData() {
    return useContext(DataContext);
}

export function DataProvider({ children }) {
    const [publications, setPublications] = useState([]);
    const [articles, setArticles] = useState([]);
    const [deadlines, setDeadlines] = useState([]);
    const [validations, setValidations] = useState([]);
    const [activePublicationId, setActivePublicationIdState] = useState(null);
    const [isLoading, setIsLoading] = useState(false);

    // Ref-ek a Realtime handler számára (stabil referencia)
    const activePublicationIdRef = useRef(null);

    // Appwrite szolgáltatások
    const servicesRef = useRef(null);
    if (!servicesRef.current) {
        const client = getClient();
        servicesRef.current = {
            databases: new Databases(client),
            functions: new Functions(client),
            storage: new Storage(client)
        };
    }
    const { databases, functions, storage } = servicesRef.current;

    // Csapattag cache
    const memberCacheRef = useRef({ map: new Map(), time: 0 });

    // ─── Kiadványok lekérése ────────────────────────────────────────────────

    const fetchPublications = useCallback(async () => {
        const allDocuments = [];
        let offset = 0;

        while (true) {
            const result = await databases.listDocuments(DATABASE_ID, COLLECTIONS.PUBLICATIONS, [
                Query.limit(PAGE_SIZE),
                Query.offset(offset),
                Query.orderAsc('name')
            ]);
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
        setIsLoading(true);

        try {
            const [articlesResult, deadlinesResult, validationsResult] = await Promise.all([
                databases.listDocuments(DATABASE_ID, COLLECTIONS.ARTICLES, [
                    Query.equal('publicationId', publicationId),
                    Query.limit(1000),
                    Query.orderAsc('startPage')
                ]).catch(() => ({ documents: [] })),
                databases.listDocuments(DATABASE_ID, COLLECTIONS.DEADLINES, [
                    Query.equal('publicationId', publicationId),
                    Query.limit(100)
                ]).catch(() => ({ documents: [] })),
                databases.listDocuments(DATABASE_ID, COLLECTIONS.USER_VALIDATIONS, [
                    Query.equal('publicationId', publicationId),
                    Query.limit(1000)
                ]).catch(() => ({ documents: [] }))
            ]);

            setArticles(articlesResult.documents);
            setDeadlines(deadlinesResult.documents);
            setValidations(validationsResult.documents);
        } finally {
            setIsLoading(false);
        }
    }, [databases]);

    // ─── Csapattag feloldás ─────────────────────────────────────────────────

    const fetchAllTeamMembers = useCallback(async () => {
        const cache = memberCacheRef.current;
        const now = Date.now();
        if (cache.map.size > 0 && (now - cache.time) < TEAM_CACHE_DURATION_MS) {
            return cache.map;
        }

        const allTeamIds = Object.values(TEAMS);
        const results = await Promise.allSettled(
            allTeamIds.map(teamId =>
                functions.createExecution(
                    GET_TEAM_MEMBERS_FUNCTION_ID,
                    JSON.stringify({ teamId }),
                    false
                )
            )
        );

        const map = new Map();
        for (const result of results) {
            if (result.status !== 'fulfilled') continue;
            try {
                const response = JSON.parse(result.value.responseBody);
                if (response.success && response.members) {
                    for (const m of response.members) {
                        if (!map.has(m.userId)) {
                            map.set(m.userId, m.name);
                        }
                    }
                }
            } catch { /* parse hiba — kihagyjuk */ }
        }

        memberCacheRef.current = { map, time: now };
        return map;
    }, [functions]);

    const getMemberName = useCallback((userId) => {
        return memberCacheRef.current.map.get(userId) || null;
    }, []);

    // ─── Realtime feliratkozás ──────────────────────────────────────────────

    useEffect(() => {
        const client = getClient();
        const channelName = (collection) =>
            `databases.${DATABASE_ID}.collections.${collection}.documents`;

        const unsubscribe = client.subscribe([
            channelName(COLLECTIONS.ARTICLES),
            channelName(COLLECTIONS.PUBLICATIONS),
            channelName(COLLECTIONS.DEADLINES),
            channelName(COLLECTIONS.USER_VALIDATIONS)
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
                    case 'deadlines':
                        applyDeadlineEvent(eventType, payload, activePublicationIdRef, setDeadlines);
                        break;
                    case 'validations':
                        applyValidationEvent(eventType, payload, activePublicationIdRef, setValidations);
                        break;
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
        publications, articles, deadlines, validations,
        activePublicationId, isLoading, storage,
        fetchPublications, switchPublication,
        fetchAllTeamMembers, getMemberName
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
        if (ch.includes(COLLECTIONS.DEADLINES)) return 'deadlines';
        if (ch.includes(COLLECTIONS.USER_VALIDATIONS)) return 'validations';
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

function applyValidationEvent(eventType, payload, pubIdRef, setValidations) {
    if (payload.publicationId !== pubIdRef.current) return;

    if (eventType === 'delete') {
        setValidations(prev => prev.filter(v => v.$id !== payload.$id));
    } else {
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
}
