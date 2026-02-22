/**
 * @file ValidationContext.jsx
 * @description Validációs eredmények központi tárolója (source-aware).
 *
 * Belsőleg forrásonként (source) tárolja az eredményeket:
 *   Map<articleId, Map<source, { errors, warnings }>>
 *
 * Kifelé egyetlen összefésült Map-et mutat a UI komponenseknek:
 *   Map<articleId, { errors, warnings }>
 *
 * Így minden validátor (structure, preflight, stb.) önállóan felülírhatja
 * a saját eredményeit anélkül, hogy más validátor eredményeit érintené.
 */

import React, { createContext, useContext, useState, useCallback, useMemo } from "react";

import { VALIDATION_TYPES } from "../utils/messageConstants.js";

const ValidationContext = createContext(null);

export const useValidation = () => {
    const context = useContext(ValidationContext);
    if (!context) throw new Error("useValidation must be used within a ValidationProvider");
    return context;
};

/**
 * Összefésüli egy cikk összes source-ának eredményeit egyetlen listává.
 * @param {Map<string, Array<Object>>} sourceMap
 * @returns {Array<Object>}
 */
function mergeSourceResults(sourceMap) {
    let allItems = [];
    for (const items of sourceMap.values()) {
        if (Array.isArray(items)) {
            allItems = allItems.concat(items);
        }
    }
    return allItems;
}

export const ValidationProvider = ({ children }) => {
    // Belső: Map<articleId, Map<source, Array<ValidationItem>>>
    const [sourceResults, setSourceResults] = useState(new Map());

    const updatePublicationValidation = useCallback((resultsMap, allArticleIds, source) => {
        setSourceResults(previous => {
            const next = new Map(previous);

            for (const articleId of allArticleIds) {
                const articleSources = next.get(articleId);
                if (articleSources) {
                    const nextSources = new Map(articleSources);
                    nextSources.delete(source);
                    if (nextSources.size === 0) {
                        next.delete(articleId);
                    } else {
                        next.set(articleId, nextSources);
                    }
                }
            }

            for (const [articleId, items] of resultsMap) {
                if (items && items.length > 0) {
                    const articleSources = next.get(articleId) || new Map();
                    const nextSources = new Map(articleSources);
                    nextSources.set(source, items);
                    next.set(articleId, nextSources);
                }
            }
            return next;
        });
    }, []);

    const updateArticleValidation = useCallback((articleId, source, items) => {
        setSourceResults(previous => {
            const next = new Map(previous);
            const hasContent = items && items.length > 0;

            if (hasContent) {
                const articleSources = next.get(articleId) || new Map();
                const nextSources = new Map(articleSources);
                nextSources.set(source, items);
                next.set(articleId, nextSources);
            } else {
                const articleSources = next.get(articleId);
                if (articleSources) {
                    const nextSources = new Map(articleSources);
                    nextSources.delete(source);
                    if (nextSources.size === 0) {
                        next.delete(articleId);
                    } else {
                        next.set(articleId, nextSources);
                    }
                }
            }
            return next;
        });
    }, []);

    const clearArticleValidation = useCallback((articleId, source) => {
        setSourceResults(previous => {
            const articleSources = previous.get(articleId);
            if (!articleSources) return previous;

            if (source) {
                if (!articleSources.has(source)) return previous;
                const next = new Map(previous);
                const nextSources = new Map(articleSources);
                nextSources.delete(source);
                if (nextSources.size === 0) {
                    next.delete(articleId);
                } else {
                    next.set(articleId, nextSources);
                }
                return next;
            }

            const next = new Map(previous);
            next.delete(articleId);
            return next;
        });
    }, []);

    const validationResults = useMemo(() => {
        const merged = new Map();
        for (const [articleId, articleSourceMap] of sourceResults) {
            const items = mergeSourceResults(articleSourceMap);
            if (items.length > 0) {
                merged.set(articleId, items);
            }
        }
        return merged;
    }, [sourceResults]);

    const value = useMemo(() => ({
        validationResults,
        updatePublicationValidation,
        updateArticleValidation,
        clearArticleValidation
    }), [validationResults, updatePublicationValidation, updateArticleValidation, clearArticleValidation]);

    return (
        <ValidationContext.Provider value={value}>
            {children}
        </ValidationContext.Provider>
    );
};
