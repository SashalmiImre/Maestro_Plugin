/**
 * @fileoverview Ellenőrzi az oldalszám átfedéseket és a tartományon kívüli oldalakat egy kiadványban.
 */

import { ValidatorBase } from "./ValidatorBase.js";

export class PublicationStructureValidator extends ValidatorBase {
    constructor() {
        super('publication');
    }

    /**
     * Layout ID feloldása névre a layouts tömbből.
     * @param {string} layoutId - A layout azonosítója
     * @param {Array} [layouts] - A layoutok tömbje ({ $id, name })
     * @returns {string} A layout neve, vagy az ID ha nincs találat
     */
    resolveLayoutName(layoutId, layouts) {
        if (!layouts || !Array.isArray(layouts) || layoutId === 'default') return layoutId;
        const layout = layouts.find(l => l.$id === layoutId);
        return layout ? layout.name : layoutId;
    }

    /**
     * Validálja a cikkek oldaltartományait egy kiadványon belül.
     * @param {Object} publicationData - { publication: { coverageStart, coverageEnd }, articles: [], layouts?: [] }
     */
    async validate(publicationData) {
        const errors = [];
        const warnings = [];

        const { publication, articles } = publicationData;

        if (!publication || !articles) {
            return this.failure("Invalid context for PublicationStructureValidator");
        }

        const pubStart = publication.coverageStart || 0;
        const pubEnd = publication.coverageEnd || 9999;

        // 1. Határok ellenőrzése (Bounds Check) - Minden cikket külön vizsgálunk
        this.checkBounds(articles, pubStart, pubEnd, errors);

        // 2. Átfedések ellenőrzése (Overlap Check) - Layout szerint csoportosítva
        this.checkOverlaps(articles, errors, publicationData.layouts);

        return errors.length > 0 ? this.failure(errors, warnings) : this.success(warnings);
    }

    /**
     * Ellenőrzi, hogy a cikkek a kiadvány határain belül vannak-e.
     */
    checkBounds(articles, pubStart, pubEnd, errors) {
        for (const article of articles) {
            const start = article.startPage;
            const end = article.endPage;

            if (start !== null && start < pubStart) {
                errors.push(`"${article.name}" a kiadvány kezdete (${pubStart}) előtt kezdődik.`);
            }
            if (end !== null && end > pubEnd) {
                errors.push(`"${article.name}" a kiadvány vége (${pubEnd}) után végződik.`);
            }
        }
    }

    /**
     * Ellenőrzi az átfedéseket a cikkek között, figyelembe véve a layout-ot és az oldalszekciókat.
     * @param {Array} articles - A cikkek tömbje
     * @param {Array} errors - Hibaüzenetek tömbje (módosítható)
     * @param {Array} [layouts] - A layoutok tömbje a név feloldáshoz
     */
    checkOverlaps(articles, errors, layouts) {
        // Csoportosítás layout szerint
        const articlesByLayout = {};
        
        for (const article of articles) {
            // Ha nincs layout megadva, 'default'-ként kezeljük
            const layout = article.layout || 'default';
            if (!articlesByLayout[layout]) {
                articlesByLayout[layout] = [];
            }
            articlesByLayout[layout].push(article);
        }

        // Minden layout csoporton belül vizsgáljuk az átfedéseket
        Object.entries(articlesByLayout).forEach(([layout, layoutArticles]) => {
            // Ha csak 1 cikk van a layouton, nincs kivel ütközni
            if (layoutArticles.length < 2) return;

            // Foglalt oldalak térképe ehhez a layouthoz: pageNumber -> articleName
            const occupiedPages = new Map();

            for (const article of layoutArticles) {
                const pages = this.getOccupiedPages(article);
                
                for (const page of pages) {
                    if (occupiedPages.has(page)) {
                        const conflictingArticleName = occupiedPages.get(page);
                        // Hiba üzenet generálása
                        const layoutDisplayName = this.resolveLayoutName(layout, layouts);
                        const layoutMsg = layout !== 'default' ? ` (Layout: ${layoutDisplayName})` : '';
                        errors.push(`Átfedés észlelve a(z) "${article.name}" és a(z) "${conflictingArticleName}" között a(z) ${page}. oldalon${layoutMsg}.`);
                        
                        // Ne spammeljük tele a hibákat ugyanazzal a párral, ha sok oldalon ütköznek
                        // De a jelenlegi logikával minden ütköző oldalt jelez. 
                        // Ez lehet sok, de pontos. Ha nem akarunk sokat, break-elhetünk a pages cikluson.
                        // Egyelőre hagyjuk, hogy jelezze az elsőt minden cikk-párnál?
                        // A fenti logika minden oldalra dob hibát.
                        // Optimalizálás: Csak egyszer jelentsük két cikk között.
                        // De a map csak EGY nevet tárol. Mi van ha 3 cikk ütközik?
                        // Ez a map logika egyszerűsített. 
                        // Robusztusabb lenne range metszeteket nézni, de a "szekciók" miatt ez bonyolultabb.
                        // Maradjunk a Page Map-nél, de kezeljük a duplikált hibákat a végén, vagy szűrjük.
                        // Vagy break-eljünk az adott cikkhez, ha már találtunk ütközést EZZEL a cikkel?
                        // Nem, mert más cikkel is ütközhet.
                        
                        // Finomítás: Csak akkor adjuk hozzá, ha még nincs benne specifikus üzenet?
                        // Inkább hagyjuk, max. pár sor hiba lesz.
                        
                    } else {
                        occupiedPages.set(page, article.name);
                    }
                }
            }
        });
    }

    /**
     * Visszaadja a cikk által elfoglalt összes oldalszámot tömbként.
     * Figyelembe veszi a pageRanges mezőt (JSON tömb formátum: "[[1,3],[5,5],[8,10]]"),
     * különben a start-end tartományt használja fallback-ként.
     */
    getOccupiedPages(article) {
        const pages = new Set();

        // 1. pageRanges alapján (JSON tömb: "[[start,end],[start,end],...]")
        if (article.pageRanges) {
            try {
                const ranges = typeof article.pageRanges === 'string'
                    ? JSON.parse(article.pageRanges)
                    : article.pageRanges;

                if (Array.isArray(ranges)) {
                    for (const range of ranges) {
                        if (Array.isArray(range) && range.length === 2) {
                            const [start, end] = range;
                            for (let i = start; i <= end; i++) pages.add(i);
                        }
                    }
                }
            } catch (e) {
                // JSON parse hiba — fallback-re esünk
            }
        }

        // 2. Fallback: startPage - endPage (ha pageRanges nem adott vagy parse sikertelen)
        if (pages.size === 0 && article.startPage != null && article.endPage != null) {
            for (let i = article.startPage; i <= article.endPage; i++) {
                pages.add(i);
            }
        }

        return Array.from(pages);
    }

    /**
     * Validálja a cikkek oldaltartományait és per-article eredményeket ad vissza.
     * Az eredmény Map-ben minden érintett cikkhez tartozik errors/warnings tömb.
     *
     * @param {Object} publicationData - { publication: { coverageStart, coverageEnd }, articles: [], layouts?: [] }
     * @returns {Map<string, { errors: string[], warnings: string[] }>} articleId → eredmények
     */
    validatePerArticle(publicationData) {
        const { publication, articles, layouts } = publicationData;
        const resultsMap = new Map();

        if (!publication || !articles) return resultsMap;

        const ensureEntry = (articleId) => {
            if (!resultsMap.has(articleId)) {
                resultsMap.set(articleId, { errors: [], warnings: [] });
            }
            return resultsMap.get(articleId);
        };

        const pubStart = publication.coverageStart || 0;
        const pubEnd = publication.coverageEnd || 9999;

        // 1. Határok ellenőrzése — hiba az adott cikkre
        for (const article of articles) {
            const start = article.startPage;
            const end = article.endPage;

            if (start !== null && start < pubStart) {
                ensureEntry(article.$id).errors.push(
                    `A kiadvány kezdete (${pubStart}) előtt kezdődik.`
                );
            }
            if (end !== null && end > pubEnd) {
                ensureEntry(article.$id).errors.push(
                    `A kiadvány vége (${pubEnd}) után végződik.`
                );
            }
        }

        // 2. Átfedések — hiba MINDKÉT érintett cikkre
        const articlesByLayout = {};
        for (const article of articles) {
            const layout = article.layout || 'default';
            if (!articlesByLayout[layout]) articlesByLayout[layout] = [];
            articlesByLayout[layout].push(article);
        }

        for (const [layout, layoutArticles] of Object.entries(articlesByLayout)) {
            if (layoutArticles.length < 2) continue;

            // pageNumber → { articleId, articleName }
            const occupiedPages = new Map();
            // Párok nyilvántartása, hogy ne duplikáljunk üzeneteket
            const reportedPairs = new Set();

            for (const article of layoutArticles) {
                const pages = this.getOccupiedPages(article);

                for (const page of pages) {
                    if (occupiedPages.has(page)) {
                        const conflicting = occupiedPages.get(page);
                        const pairKey = [article.$id, conflicting.articleId].sort().join(':');

                        if (!reportedPairs.has(pairKey)) {
                            reportedPairs.add(pairKey);
                            const layoutDisplayName = this.resolveLayoutName(layout, layouts);
                            const layoutMsg = layout !== 'default' ? ` (Layout: ${layoutDisplayName})` : '';

                            ensureEntry(article.$id).errors.push(
                                `Átfedés: "${conflicting.articleName}", ${page}. oldal${layoutMsg}`
                            );
                            ensureEntry(conflicting.articleId).errors.push(
                                `Átfedés: "${article.name}", ${page}. oldal${layoutMsg}`
                            );
                        }
                    } else {
                        occupiedPages.set(page, { articleId: article.$id, articleName: article.name });
                    }
                }
            }
        }

        return resultsMap;
    }
}
