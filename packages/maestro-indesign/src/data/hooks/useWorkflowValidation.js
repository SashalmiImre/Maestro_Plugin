/**
 * @file useWorkflowValidation.js
 * @description Preflight validációs eredmények kezelése: futtatás, mentés, betöltés és életciklus.
 *
 * Event-driven triggerek:
 * 1. `MaestroEvent.documentSaved`  — futtatás, ha az állapot megkívánja
 * 2. `MaestroEvent.documentClosed` — futtatás (registerTask), ha az állapot megkívánja
 * 3. `MaestroEvent.stateChanged`   — futtatás belépéskor / törlés kilépéskor a preflight zónából
 * 4. Manuális gomb (command handler hívja a runAndPersistPreflight-ot)
 *
 * Az eredményeket az Appwrite validations kollekcióba menti (source: "preflight"),
 * és a ValidationContext-en keresztül frissíti a UI-t (source-aware replace).
 */

import { useEffect, useRef, useCallback } from "react";
import { MaestroEvent } from "../../core/config/maestroEvents.js";
import { useData } from "../../core/contexts/DataContext.jsx";
import { useValidation } from "../../core/contexts/ValidationContext.jsx";
import { useToast } from "../../ui/common/Toast/ToastContext.jsx";

import { WORKFLOW_CONFIG } from "../../core/utils/workflow/workflowConstants.js";
import { tables, DATABASE_ID, VALIDATIONS_COLLECTION_ID, ID, Query } from "../../core/config/appwriteConfig.js";
import { log, logError } from "../../core/utils/logger.js";

const VALIDATION_SOURCE = "preflight";
const PAGE_SIZE = 1000;



/**
 * Lapozva lekéri az összes preflight validációs sort az Appwrite-ból.
 */
async function fetchAllPreflightRows(baseQueries) {
    const allRows = [];
    let offset = 0;

    while (true) {
        const response = await tables.listRows({
            databaseId: DATABASE_ID,
            tableId: VALIDATIONS_COLLECTION_ID,
            queries: [
                ...baseQueries,
                Query.limit(PAGE_SIZE),
                Query.offset(offset)
            ]
        });

        if (!response || !Array.isArray(response.rows)) {
            logError('[useWorkflowValidation] Hibás válasz a tables.listRows-tól:', response);
            break;
        }

        allRows.push(...response.rows);

        if (response.rows.length < PAGE_SIZE) break;
        offset += PAGE_SIZE;
    }

    return allRows;
}

/**
 * Hook a preflight validációs eredmények kezeléséhez.
 * Workspace szinten kell bekötni.
 *
 * Feliratkozik a `MaestroEvent.documentSaved`, `MaestroEvent.documentClosed` és
 * `MaestroEvent.stateChanged` eseményekre, és önállóan kezeli a preflight életciklusát.
 *
 * @returns {{ runAndPersistPreflight: (article: Object) => Promise<Object> }}
 */
export const useWorkflowValidation = () => {
    const { articles } = useData();
    const { updateArticleValidation, clearArticleValidation } = useValidation();
    const { showToast } = useToast();

    const articlesRef = useRef(articles);

    useEffect(() => {
        articlesRef.current = articles;
    }, [articles]);

    /**
     * Betölti az összes meglévő validációt az Appwrite-ból
     * és feltölti a ValidationContext-et.
     */
    useEffect(() => {
        const loadExistingValidations = async () => {
            try {
                // Betöltjük a 'preflight' forrású validációkat (hardkódolva a kompatibilitás miatt,
                // de később kiterjeszthető más forrásokra is)
                const allRows = await fetchAllPreflightRows([
                    Query.equal('source', VALIDATION_SOURCE)
                ]);

                if (allRows.length === 0) return;

                for (const doc of allRows) {
                    const items = [];
                    if (doc.errors && doc.errors.length > 0) {
                        items.push(...doc.errors.map(msg => ({ type: 'error', message: msg, source: VALIDATION_SOURCE })));
                    }
                    if (doc.warnings && doc.warnings.length > 0) {
                        items.push(...doc.warnings.map(msg => ({ type: 'warning', message: msg, source: VALIDATION_SOURCE })));
                    }
                    
                    if (items.length > 0) {
                        updateArticleValidation(doc.articleId, VALIDATION_SOURCE, items);
                    }
                }

                log(`[useWorkflowValidation] ${allRows.length} validáció betöltve az adatbázisból.`);
            } catch (error) {
                logError('[useWorkflowValidation] Validációk betöltése sikertelen:', error);
            }
        };

        loadExistingValidations();
    // Csak mount-kor fut
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    /**
     * Egyetlen cikk validációs eredményét menti (upsert) az Appwrite-ba.
     */
    const persistToDatabase = useCallback(async (articleId, publicationId, source, result) => {
        try {
            // 1. Meglévő sor keresése ehhez a cikkhez és forráshoz
            const existingRows = await fetchAllPreflightRows([
                Query.equal('articleId', articleId),
                Query.equal('source', source)
            ]);

            const hasContent = result.errors.length > 0 || result.warnings.length > 0;
            const data = { errors: result.errors, warnings: result.warnings };

            if (hasContent) {
                if (existingRows.length > 0) {
                    // Update
                    await tables.updateRow({
                        databaseId: DATABASE_ID,
                        tableId: VALIDATIONS_COLLECTION_ID,
                        rowId: existingRows[0].$id,
                        data
                    });
                } else {
                    // Create
                    await tables.createRow({
                        databaseId: DATABASE_ID,
                        tableId: VALIDATIONS_COLLECTION_ID,
                        rowId: ID.unique(),
                        data: {
                            articleId,
                            publicationId,
                            source: source,
                            ...data
                        }
                    });
                }
            } else if (existingRows.length > 0) {
                // Nincs hiba → régi sor törlése
                await tables.deleteRow({
                    databaseId: DATABASE_ID,
                    tableId: VALIDATIONS_COLLECTION_ID,
                    rowId: existingRows[0].$id
                });
            }

            log(`[useWorkflowValidation] Eredmény mentve (article: ${articleId}, source: ${source}, hibák: ${result.errors.length}).`);
        } catch (error) {
            logError('[useWorkflowValidation] DB mentés sikertelen:', error);
        }
    }, []);

    /**
     * Futtat egy specifikus validációt egy cikkre, menti az eredményt és frissíti a UI-t.
     *
     * @param {Object} article - A validálandó cikk objektum
     * @param {string} validatorType - A validátor típusa (pl. 'preflight_check')
     * @param {Object} [options] - Opcionális paraméterek a validátornak (pl. { profile: '...' })
     * @returns {Promise<Object>} Validációs eredmény
     */
    const runValidation = useCallback(async (article, validatorType, options = {}) => {
        // ValidationRunner használata
        // Importáljuk dinamikusan vagy használjunk egy importot fentről?
        // A validationRunner.js-ből importált `validate` függvényt használjuk.
        // Mivel ez 'use hook', a fájl elején importáljuk a `validate` fv-t.
        const { validate } = await import("../../core/utils/validationRunner.js");
        
        const resultWrapper = await validate(article, validatorType, { options });
        const result = resultWrapper.details[validatorType] || resultWrapper; // Fallback ha structure changes

        // Csatolatlan meghajtók → csak toast, nem mentjük
        if (result.skipped) {
            log(`[useWorkflowValidation] Kihagyva (csatolatlan meghajtó) — ${result.unmountedDrives?.join(', ')}`);
            const driveList = result.unmountedDrives?.join(', ') || '';
            showToast(
                'A validáció nem futott le',
                'error',
                `A következő hálózati meghajtó(k) nem elérhetők: ${driveList}. ` +
                'Kérjük, ellenőrizd a hálózati kapcsolatot, majd próbáld újra.'
            );
            return result;
        }

        const validationResult = {
            errors: result.errors || [],
            warnings: result.warnings || []
        };

        // Forrás meghatározása a típusból (egyelőre leképezzük 'preflight'-ra ha preflight_check)
        // Ha később több típus lesz, itt lehet logikázni.
        const source = validatorType === 'preflight_check' ? 'preflight' : validatorType;

        // ValidationContext frissítés - Átalakítás ValidationItem-ekre
        const items = [];
        if (validationResult.errors.length > 0) {
            items.push(...validationResult.errors.map(msg => ({ type: 'error', message: msg, source })));
        }
        if (validationResult.warnings.length > 0) {
            items.push(...validationResult.warnings.map(msg => ({ type: 'warning', message: msg, source })));
        }

        updateArticleValidation(article.$id, source, items);

        // DB mentés - Marad a régi struktúra (errors/warnings tömbök)
        persistToDatabase(article.$id, article.publicationId, source, validationResult);

        return result;
    }, [updateArticleValidation, persistToDatabase, showToast]);

    // Legacy wrapper a kompatibilitásért (Workspace.jsx, preflightCheck.js)
    const runAndPersistPreflight = useCallback((article) => {
        // Preflight profile feloldása az aktuális állapotból? 
        // Vagy default? A gombnyomásos indításnál használhatjuk az aktuális állapot konfigurációját,
        // VAGY egy alapértelmezett profilt.
        // A WORKFLOW_CONFIG-ból kikeressük, van-e config erre az állapotra.
        const stateConfig = WORKFLOW_CONFIG[article.state]?.validations;
        const preflightConfig = stateConfig?.onEntry?.find(v => v.validator === 'preflight_check');
        const options = preflightConfig?.options || {}; // Default to empty if not configured (PreflightValidator defaults to Levil)

        return runValidation(article, 'preflight_check', options);
    }, [runValidation]);

    // Egyetlen ref a stabil hivatkozásokhoz az event handlerekben
    const callbacksRef = useRef({ runValidation, persistToDatabase, clearArticleValidation });
    useEffect(() => {
        callbacksRef.current = { runValidation, persistToDatabase, clearArticleValidation };
    }, [runValidation, persistToDatabase, clearArticleValidation]);

    /**
     * Event feliratkozások
     */
    useEffect(() => {
        /**
         * Segédfüggvény: állapothoz tartozó auto-run validációk futtatása
         */
        const runAutoValidations = (article) => {
            const stateConfig = WORKFLOW_CONFIG[article.state]?.validations;
            if (!stateConfig || !stateConfig.onEntry) return;

            stateConfig.onEntry.forEach(config => {
                log(`[useWorkflowValidation] Auto-validáció futtatása: ${config.validator} (${article.name})`);
                callbacksRef.current.runValidation(article, config.validator, config.options);
            });
        };

        const handleDocumentSaved = (event) => {
            const { article } = event.detail;
            runAutoValidations(article);
        };

        const handleDocumentClosed = (event) => {
            const { article, registerTask } = event.detail;
            const stateConfig = WORKFLOW_CONFIG[article.state]?.validations;
            if (!stateConfig || !stateConfig.onEntry) return;

            stateConfig.onEntry.forEach(config => {
                log(`[useWorkflowValidation] Auto-validáció (closed): ${config.validator} (${article.name})`);
                registerTask(callbacksRef.current.runValidation(article, config.validator, config.options));
            });
        };

        const handleStateChanged = (event) => {
            const { article, previousState, newState } = event.detail;
            const prevConfig = WORKFLOW_CONFIG[previousState]?.validations;
            const newConfig = WORKFLOW_CONFIG[newState]?.validations;

            // 1. Kilépés a régi állapotból: takarítás?
            // Ha a régi állapotban volt 'preflight_check' auto-run, és az újban NINCS, akkor töröljük az eredményt?
            // A logika: ha egy validáció "auto-run" egy állapotban, akkor az eredménye addig érvényes, amíg abban az állapotban vagyunk?
            // Vagy amíg el nem avul?
            // A régi implementáció törölte a preflight eredményt, ha kiléptünk a PREFLIGHT_STATES-ből.
            
            // Megnézzük, hogy a régi állapotban volt-e preflight, és az újban van-e.
            const hadPreflight = prevConfig?.onEntry?.some(v => v.validator === 'preflight_check');
            const hasPreflight = newConfig?.onEntry?.some(v => v.validator === 'preflight_check');

            if (hadPreflight && !hasPreflight) {
                 log(`[useWorkflowValidation] Preflight eredmények törlése (kilépés): "${article.name}"`);
                 callbacksRef.current.clearArticleValidation(article.$id, 'preflight');
                 callbacksRef.current.persistToDatabase(article.$id, article.publicationId, 'preflight', { errors: [], warnings: [] });
            }

            // 2. Belépés az új állapotba: futtatás
            runAutoValidations(article); // Ez kezeli a hasPreflight esetet is
        };

        window.addEventListener(MaestroEvent.documentSaved, handleDocumentSaved);
        window.addEventListener(MaestroEvent.documentClosed, handleDocumentClosed);
        window.addEventListener(MaestroEvent.stateChanged, handleStateChanged);

        return () => {
            window.removeEventListener(MaestroEvent.documentSaved, handleDocumentSaved);
            window.removeEventListener(MaestroEvent.documentClosed, handleDocumentClosed);
            window.removeEventListener(MaestroEvent.stateChanged, handleStateChanged);
        };
    }, []);

    // Visszaadjuk a generic runValidation-t ÉS a legacy runAndPersistPreflight-ot is
    return { runValidation, runAndPersistPreflight };
};
