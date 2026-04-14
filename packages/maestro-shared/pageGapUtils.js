/**
 * @fileoverview Oldalrés-detektálás: meghatározza a kiadvány lefedetlen oldalszakaszait.
 *
 * A kiadvány terjedelmén (coverageStart–coverageEnd) belül megkeresi azokat az összefüggő
 * oldalcsoportokat, amelyekhez egyetlen cikk sincs rendelve, és helykitöltő objektumokat
 * ad vissza az ArticleTable számára.
 *
 * @module shared/pageGapUtils
 */

import { getInitialState } from "./workflowRuntime.js";

/**
 * Meghatározza a kiadvány oldalterjedelmén belüli lefedetlen (hozzárendeletlen) oldaltartományokat.
 *
 * A függvény az ÖSSZES cikket figyelembe veszi (szűrés előtti állapot),
 * hogy a valós fizikai oldalfoglaltságot tükrözze.
 *
 * @param {Array} articles - A kiadvány ÖSSZES cikke (szűrés előtt)
 * @param {Object} publication - A kiadvány objektum (coverageStart, coverageEnd)
 * @param {Object} [workflow] - A compiled workflow JSON (opcionális, a placeholder állapothoz)
 * @returns {Array<Object>} Helykitöltő objektumok tömbje
 */
export function buildPlaceholderRows(articles, publication, workflow) {
    const coverageStart = publication?.coverageStart;
    const coverageEnd = publication?.coverageEnd;

    // Ha nincs definiált terjedelem, nem tudunk rést számolni
    if (coverageStart == null || coverageEnd == null) return [];
    if (coverageEnd < coverageStart) return [];

    // Foglalt oldalak összegyűjtése (Set a gyors kereséshez)
    const occupiedPages = new Set();

    for (const article of articles) {
        // pageRanges elsőbbséget élvez (szekciókra bontott cikkek)
        if (article.pageRanges) {
            try {
                const ranges = typeof article.pageRanges === 'string'
                    ? JSON.parse(article.pageRanges)
                    : article.pageRanges;

                if (Array.isArray(ranges)) {
                    for (const range of ranges) {
                        if (Array.isArray(range) && range.length === 2) {
                            for (let p = range[0]; p <= range[1]; p++) {
                                occupiedPages.add(p);
                            }
                        }
                    }
                    continue;
                }
            } catch (e) {
                // JSON parse hiba — fallback a startPage/endPage-re
            }
        }

        // Fallback: startPage–endPage
        if (article.startPage != null) {
            const end = article.endPage ?? article.startPage;
            for (let p = article.startPage; p <= end; p++) {
                occupiedPages.add(p);
            }
        }
    }

    // Összefüggő rések keresése a kiadvány terjedelmén belül
    const placeholders = [];
    let gapStart = null;

    for (let page = coverageStart; page <= coverageEnd; page++) {
        if (!occupiedPages.has(page)) {
            if (gapStart === null) gapStart = page;
        } else {
            if (gapStart !== null) {
                placeholders.push(createPlaceholder(gapStart, page - 1, workflow));
                gapStart = null;
            }
        }
    }

    // Ha a terjedelem végén is rés volt
    if (gapStart !== null) {
        placeholders.push(createPlaceholder(gapStart, coverageEnd, workflow));
    }

    return placeholders;
}

/**
 * Helykitöltő objektum létrehozása.
 * A struktúra kompatibilis a cikk objektumokkal a táblázat rendereléshez és a sürgősség-számításhoz.
 *
 * @param {number} startPage
 * @param {number} endPage
 * @param {Object} [workflow] - Ha megadott, az initial state ID-ját használja; különben `"designing"` fallback.
 * @returns {Object}
 */
function createPlaceholder(startPage, endPage, workflow) {
    return {
        $id: `placeholder-${startPage}-${endPage}`,
        name: null,
        startPage,
        endPage,
        state: getInitialState(workflow) || "designing",
        markers: 0,
        isPlaceholder: true
    };
}
