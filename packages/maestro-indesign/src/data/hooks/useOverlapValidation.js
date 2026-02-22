/**
 * @file useOverlapValidation.js
 * @description Figyeli a lokális oldalszám-változásokat és futtatja az átfedés-validációt.
 *
 * A hook a `MaestroEvent.pageRangesChanged` eseményre hallgat, amely akkor váltódik ki,
 * amikor egy cikk oldalszámai megváltoznak (felhasználói módosítás vagy auto-correct).
 * Az érintett publikáció összes cikkét validálja a PublicationStructureValidator segítségével,
 * és az eredményeket a ValidationContext-be + Appwrite-ba írja.
 *
 * Induláskor betölti a meglévő validációs eredményeket az adatbázisból.
 */

import { useEffect, useRef, useCallback } from "react";
import { MaestroEvent } from "../../core/config/maestroEvents.js";
import { useData } from "../../core/contexts/DataContext.jsx";
import { useValidation } from "../../core/contexts/ValidationContext.jsx";
import { useToast } from "../../ui/common/Toast/ToastContext.jsx";
import { PublicationStructureValidator } from "../../core/utils/validators/PublicationStructureValidator.js";
import { tables, DATABASE_ID, VALIDATIONS_COLLECTION_ID, ID, Query } from "../../core/config/appwriteConfig.js";
import { log, logError } from "../../core/utils/logger.js";
import { withRetry } from "../../core/utils/promiseUtils.js";

const VALIDATION_SOURCE = "structure";
const PAGE_SIZE = 1000;

// Egyetlen megosztott példány
const structureValidator = new PublicationStructureValidator();

/**
 * Lapozva lekéri az összes validációs sort az Appwrite-ból a megadott szűrőkkel.
 * PAGE_SIZE-os kötegekben halad, amíg az utolsó köteg kisebb, mint PAGE_SIZE.
 */
async function fetchAllValidationRows(baseQueries) {
    const allRows = [];
    let offset = 0;

    while (true) {
        const response = await withRetry(
            () => tables.listRows({
                databaseId: DATABASE_ID,
                tableId: VALIDATIONS_COLLECTION_ID,
                queries: [
                    ...baseQueries,
                    Query.limit(PAGE_SIZE),
                    Query.offset(offset)
                ]
            }),
            { operationName: "fetchValidationRows" }
        );

        if (!response || !Array.isArray(response.rows)) {
            logError('[useOverlapValidation] Hibás válasz a tables.listRows-tól:', response);
            break;
        }

        allRows.push(...response.rows);

        if (response.rows.length < PAGE_SIZE) break;
        offset += PAGE_SIZE;
    }

    return allRows;
}

/**
 * Hook az oldalszám-átfedések automatikus validálásához.
 * Workspace szinten kell bekötni (pl. PublicationList), hogy minden változásra reagáljon.
 */
export const useOverlapValidation = () => {
    const { articles, publications, layouts } = useData();
    const { updatePublicationValidation } = useValidation();
    const { showToast } = useToast();

    // Ref-ek, hogy az event handler mindig a friss adatot lássa
    const articlesRef = useRef(articles);
    const publicationsRef = useRef(publications);
    const layoutsRef = useRef(layouts);

    useEffect(() => {
        articlesRef.current = articles;
    }, [articles]);

    useEffect(() => {
        publicationsRef.current = publications;
    }, [publications]);

    useEffect(() => {
        layoutsRef.current = layouts;
    }, [layouts]);

    /**
     * Betölti az összes meglévő validációs eredményt az Appwrite-ból
     * és feltölti a ValidationContext-et.
     */
    useEffect(() => {
        const loadExistingValidations = async () => {
            try {
                const allRows = await fetchAllValidationRows([
                    Query.equal('source', VALIDATION_SOURCE)
                ]);

                if (allRows.length === 0) return;

                // Publikációnként csoportosítjuk a betöltött eredményeket
                const byPublication = {};
                for (const doc of allRows) {
                    if (!byPublication[doc.publicationId]) {
                        byPublication[doc.publicationId] = { resultsMap: new Map(), allArticleIds: [] };
                    }
                    
                    const items = [];
                    if (doc.errors && doc.errors.length > 0) {
                        items.push(...doc.errors.map(msg => ({ type: 'error', message: msg, source: VALIDATION_SOURCE })));
                    }
                    if (doc.warnings && doc.warnings.length > 0) {
                        items.push(...doc.warnings.map(msg => ({ type: 'warning', message: msg, source: VALIDATION_SOURCE })));
                    }

                    if (items.length > 0) {
                        byPublication[doc.publicationId].resultsMap.set(doc.articleId, items);
                    }
                }

                // Minden publikáció cikkjeit is összegyűjtjük a tiszta törléshez
                for (const pubId of Object.keys(byPublication)) {
                    const pubArticles = articlesRef.current.filter(a => a.publicationId === pubId);
                    byPublication[pubId].allArticleIds = pubArticles.map(a => a.$id);
                }

                // Batchben frissítjük a ValidationContext-et
                for (const { resultsMap, allArticleIds } of Object.values(byPublication)) {
                    updatePublicationValidation(resultsMap, allArticleIds, VALIDATION_SOURCE);
                }

                log(`[useOverlapValidation] ${allRows.length} validáció betöltve az adatbázisból.`);
            } catch (error) {
                logError('[useOverlapValidation] Validációk betöltése sikertelen:', error);
            }
        };

        loadExistingValidations();
    // Csak mount-kor fut
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    /**
     * Validációs eredmények mentése az Appwrite-ba.
     * Upsert logika: meglévőket frissíti, újakat létrehozza, eltűnteket törli.
     */
    const persistToDatabase = useCallback(async (publicationId, resultsMap) => {
        try {
            // 1. Meglévő validációs dokumentumok lekérése ehhez a publikációhoz
            const existingRows = await fetchAllValidationRows([
                Query.equal('publicationId', publicationId),
                Query.equal('source', VALIDATION_SOURCE)
            ]);

            const existingByArticle = new Map();
            for (const doc of existingRows) {
                existingByArticle.set(doc.articleId, doc.$id);
            }

            const operations = [];

            // 2. Eredménnyel rendelkező cikkek: update vagy create
            for (const [articleId, result] of resultsMap) {
                if (result.errors.length === 0 && result.warnings.length === 0) continue;

                const data = {
                    errors: result.errors,
                    warnings: result.warnings
                };

                if (existingByArticle.has(articleId)) {
                    // Update
                    const rowId = existingByArticle.get(articleId);
                    operations.push({
                        label: `update validation for article ${articleId}`,
                        run: () => withRetry(
                            () => tables.updateRow({
                                databaseId: DATABASE_ID,
                                tableId: VALIDATIONS_COLLECTION_ID,
                                rowId,
                                data
                            }),
                            { operationName: `updateValidation(${articleId})` }
                        )
                    });
                    existingByArticle.delete(articleId);
                } else {
                    // Create — ID-t előre generáljuk, hogy retry esetén ne jöjjön létre duplikátum
                    const generatedRowId = ID.unique();
                    operations.push({
                        label: `create validation for article ${articleId}`,
                        run: () => withRetry(
                            () => tables.createRow({
                                databaseId: DATABASE_ID,
                                tableId: VALIDATIONS_COLLECTION_ID,
                                rowId: generatedRowId,
                                data: {
                                    articleId,
                                    publicationId,
                                    source: VALIDATION_SOURCE,
                                    ...data
                                }
                            }),
                            { operationName: `createValidation(${articleId})` }
                        )
                    });
                }
            }

            // 3. Maradék régi dokumentumok törlése (cikkek, amikhez már nincs hiba/warning)
            for (const [, docId] of existingByArticle) {
                operations.push({
                    label: `delete validation doc ${docId}`,
                    run: () => withRetry(
                        () => tables.deleteRow({
                            databaseId: DATABASE_ID,
                            tableId: VALIDATIONS_COLLECTION_ID,
                            rowId: docId
                        }),
                        { operationName: `deleteValidation(${docId})` }
                    )
                });
            }

            // 4. Párhuzamos végrehajtás Promise.allSettled-del
            //    A withRetry már kezel minden egyes műveletnél 3 próbálkozást,
            //    ezért itt nem kell külön retry logika.
            if (operations.length > 0) {
                const results = await Promise.allSettled(operations.map(op => op.run()));

                const failed = results
                    .map((result, i) => ({ result, op: operations[i] }))
                    .filter(({ result }) => result.status === 'rejected');

                if (failed.length === 0) {
                    log(`[useOverlapValidation] ${operations.length} DB művelet végrehajtva (pub: ${publicationId}).`);
                    return;
                }

                // Véglegesen sikertelen műveletek logolása (a withRetry már 3x próbálkozott)
                for (const { result, op } of failed) {
                    logError(
                        `[useOverlapValidation] DB művelet sikertelen (pub: ${publicationId}, op: ${op.label}):`,
                        result.reason
                    );
                }

                throw new Error(
                    `${failed.length}/${operations.length} DB művelet végleg sikertelen (pub: ${publicationId}). ` +
                    `Részleges mentés történt, a validációs állapot inkonzisztens lehet.`
                );
            }
        } catch (error) {
            logError('[useOverlapValidation] Appwrite mentés sikertelen:', error);
            throw error;
        }
    }, []);

    /**
     * Segédfüggvény: Validációs eredmény térkép átalakítása (ValidationContext számára).
     * { errors, warnings } -> Array<ValidationItem>
     */
    const transformResultsToItems = (resultsMap) => {
        const itemsMap = new Map();
        for (const [articleId, result] of resultsMap) {
            const items = [];
            if (result.errors && result.errors.length > 0) {
                items.push(...result.errors.map(msg => ({ type: 'error', message: msg, source: VALIDATION_SOURCE })));
            }
            if (result.warnings && result.warnings.length > 0) {
                items.push(...result.warnings.map(msg => ({ type: 'warning', message: msg, source: VALIDATION_SOURCE })));
            }
            if (items.length > 0) {
                itemsMap.set(articleId, items);
            }
        }
        return itemsMap;
    };

    /**
     * Toast értesítés, ha a validáció hibákat talált.
     * Konfigurációs változásoknál (layout, coverage) hívjuk,
     * ahol a user nem feltétlenül látja a cikk szintű ValidationSection-t.
     */
    const notifyIfErrors = useCallback((resultsMap) => {
        const articlesWithErrors = [...resultsMap.values()].filter(r => r.errors.length > 0).length;
        if (articlesWithErrors > 0) {
            showToast(
                'Struktúra hibák észlelve',
                'error',
                `${articlesWithErrors} cikknél átfedés vagy határon kívüli oldalak találhatók.`
            );
        }
    }, [showToast]);

    const handlePageRangesChanged = useCallback((event) => {
        const { article: changedArticle } = event.detail;
        if (!changedArticle?.publicationId) return;

        const publicationId = changedArticle.publicationId;

        // Publikáció megkeresése
        const publication = publicationsRef.current.find(p => p.$id === publicationId);
        if (!publication) return;

        // Testvér cikkek összegyűjtése — a frissített cikket az event-ből kapottra cseréljük
        const siblingArticles = articlesRef.current
            .filter(a => a.publicationId === publicationId)
            .map(a => a.$id === changedArticle.$id ? changedArticle : a);

        // Validáció futtatása
        const resultsMap = structureValidator.validatePerArticle({
            publication,
            articles: siblingArticles,
            layouts: layoutsRef.current
        });

        // Eredmények beírása a ValidationContext-be (azonnali UI frissítés)
        const allArticleIds = siblingArticles.map(a => a.$id);
        const itemsMap = transformResultsToItems(resultsMap);
        updatePublicationValidation(itemsMap, allArticleIds, VALIDATION_SOURCE);

        // Eredmények mentése az Appwrite-ba (háttérben)
        persistToDatabase(publicationId, resultsMap);
    }, [updatePublicationValidation, persistToDatabase]);

    /**
     * Publikáció coverage változás kezelése.
     * Újravalidálja az összes cikket az adott publikációban.
     */
    const handlePublicationCoverageChanged = useCallback((event) => {
        const { publication } = event.detail;
        if (!publication?.$id) return;

        // Az adott publikáció összes cikkje
        const pubArticles = articlesRef.current.filter(a => a.publicationId === publication.$id);
        if (pubArticles.length === 0) return;

        // Validáció futtatása a frissített publikáció adatokkal
        const resultsMap = structureValidator.validatePerArticle({
            publication,
            articles: pubArticles,
            layouts: layoutsRef.current
        });

        // Eredmények beírása a ValidationContext-be
        const allArticleIds = pubArticles.map(a => a.$id);
        const itemsMap = transformResultsToItems(resultsMap);
        updatePublicationValidation(itemsMap, allArticleIds, VALIDATION_SOURCE);

        // Eredmények mentése az Appwrite-ba
        persistToDatabase(publication.$id, resultsMap);

        // Toast értesítés (konfigurációs változás → user nem feltétlenül látja a ValidationSection-t)
        notifyIfErrors(resultsMap);
    }, [updatePublicationValidation, persistToDatabase, notifyIfErrors]);

    /**
     * Layout változás kezelése.
     * Mivel az átfedés-vizsgálat layout-onként csoportosít,
     * egy layout változás átrendezheti az átfedéseket.
     *
     * Kétféle hívás:
     *   - Egyedi: `{ article }` — egyetlen cikk layout-ja változott
     *   - Tömeges: `{ articles, publicationId }` — layout törléskor több cikk átrendelve
     */
    const handleLayoutChanged = useCallback((event) => {
        const { article: changedArticle, articles: changedArticles, publicationId: directPubId } = event.detail;
        const publicationId = changedArticle?.publicationId || directPubId;
        if (!publicationId) return;

        const publication = publicationsRef.current.find(p => p.$id === publicationId);
        if (!publication) return;

        // Frissített cikk(ek) becsatolása a testvérek közé.
        // Az event detail-ből kapott cikkek felülírják a ref-ben lévő (esetleg stale) adatokat.
        const updatedMap = new Map();
        if (changedArticle) updatedMap.set(changedArticle.$id, changedArticle);
        if (changedArticles) changedArticles.forEach(a => updatedMap.set(a.$id, a));

        const siblingArticles = articlesRef.current
            .filter(a => a.publicationId === publicationId)
            .map(a => updatedMap.get(a.$id) || a);

        const resultsMap = structureValidator.validatePerArticle({
            publication,
            articles: siblingArticles,
            layouts: layoutsRef.current
        });

        const allArticleIds = siblingArticles.map(a => a.$id);
        const itemsMap = transformResultsToItems(resultsMap);
        updatePublicationValidation(itemsMap, allArticleIds, VALIDATION_SOURCE);
        persistToDatabase(publicationId, resultsMap);

        // Toast értesítés (konfigurációs változás → user nem feltétlenül látja a ValidationSection-t)
        notifyIfErrors(resultsMap);
    }, [updatePublicationValidation, persistToDatabase, notifyIfErrors]);

    /**
     * Cikkek hozzáadása utáni struktúra-ellenőrzés.
     * A cikkek felvétele után újravalidálja az adott publikáció összes cikkét,
     * hogy az esetleges átfedések vagy határon kívüli oldalak azonnal láthatóak legyenek.
     */
    const handleArticlesAdded = useCallback((event) => {
        const { publicationId } = event.detail;
        if (!publicationId) return;

        const publication = publicationsRef.current.find(p => p.$id === publicationId);
        if (!publication) return;

        const pubArticles = articlesRef.current.filter(a => a.publicationId === publicationId);
        if (pubArticles.length === 0) return;

        const resultsMap = structureValidator.validatePerArticle({
            publication,
            articles: pubArticles,
            layouts: layoutsRef.current
        });

        const allArticleIds = pubArticles.map(a => a.$id);
        const itemsMap = transformResultsToItems(resultsMap);
        updatePublicationValidation(itemsMap, allArticleIds, VALIDATION_SOURCE);
        persistToDatabase(publicationId, resultsMap);

        notifyIfErrors(resultsMap);
    }, [updatePublicationValidation, persistToDatabase, notifyIfErrors]);

    /**
     * Dokumentum bezárásakor is futtatunk egy ellenőrzést.
     * Ez biztosítja, hogy ha a 'pageRangesChanged' valamiért nem futott le
     * (pl. nem volt adatbázis módosítás, csak in-memory), akkor is
     * frissüljön a validációs állapot.
     */
    const handleDocumentClosed = useCallback((event) => {
        const { article } = event.detail;
        if (!article?.publicationId) return;
        
        const publicationId = article.publicationId;
        const publication = publicationsRef.current.find(p => p.$id === publicationId);
        if (!publication) return;

        // Az aktuális cikkekkel validálunk
        const pubArticles = articlesRef.current.filter(a => a.publicationId === publicationId);
        
        // Frissítés (Validálás)
        const resultsMap = structureValidator.validatePerArticle({
            publication,
            articles: pubArticles,
            layouts: layoutsRef.current
        });

        const allArticleIds = pubArticles.map(a => a.$id);
        const itemsMap = transformResultsToItems(resultsMap);
        updatePublicationValidation(itemsMap, allArticleIds, VALIDATION_SOURCE);
        persistToDatabase(publicationId, resultsMap);
    }, [updatePublicationValidation, persistToDatabase]);

    useEffect(() => {
        window.addEventListener(MaestroEvent.pageRangesChanged, handlePageRangesChanged);
        window.addEventListener(MaestroEvent.publicationCoverageChanged, handlePublicationCoverageChanged);
        window.addEventListener(MaestroEvent.layoutChanged, handleLayoutChanged);
        window.addEventListener(MaestroEvent.articlesAdded, handleArticlesAdded);
        window.addEventListener(MaestroEvent.documentClosed, handleDocumentClosed);

        return () => {
            window.removeEventListener(MaestroEvent.pageRangesChanged, handlePageRangesChanged);
            window.removeEventListener(MaestroEvent.publicationCoverageChanged, handlePublicationCoverageChanged);
            window.removeEventListener(MaestroEvent.layoutChanged, handleLayoutChanged);
            window.removeEventListener(MaestroEvent.articlesAdded, handleArticlesAdded);
            window.removeEventListener(MaestroEvent.documentClosed, handleDocumentClosed);
        };
    }, [handlePageRangesChanged, handlePublicationCoverageChanged, handleLayoutChanged, handleArticlesAdded, handleDocumentClosed]);
};
