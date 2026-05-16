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

import { getStateValidations } from "maestro-shared/workflowRuntime.js";
import { VALIDATOR_TYPES, VALIDATION_SOURCES } from "../../core/utils/validationConstants.js";
import { VALIDATION_TYPES } from "../../core/utils/messageConstants.js";
import { tables, DATABASE_ID, COLLECTIONS, ID, Query } from "../../core/config/appwriteConfig.js";
import { log, logError } from "../../core/utils/logger.js";
import { withRetry } from "../../core/utils/promiseUtils.js";
import { fetchAllValidationRows, queuePersist } from "../../core/utils/validationPersist.js";
import { TOAST_TYPES } from "../../core/utils/constants.js";
import { useTenantAclSnapshot } from "./useTenantAclSnapshot.js";

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
    const { articles, publications, workflow } = useData();
    const { updateArticleValidation, clearArticleValidation } = useValidation();
    const { showToast } = useToast();
    // Tenant doc-szintű ACL snapshot — ADR 0014 (`withCreator` defense-in-depth).
    const buildPermissions = useTenantAclSnapshot('useWorkflowValidation');

    const articlesRef = useRef(articles);
    const publicationsRef = useRef(publications);
    const workflowRef = useRef(workflow);

    useEffect(() => { articlesRef.current = articles; }, [articles]);
    useEffect(() => { publicationsRef.current = publications; }, [publications]);
    useEffect(() => { workflowRef.current = workflow; }, [workflow]);

    /**
     * Betölti az összes meglévő validációt az Appwrite-ból
     * és feltölti a ValidationContext-et.
     */
    useEffect(() => {
        const loadExistingValidations = async () => {
            try {
                // Betöltjük a 'preflight' forrású validációkat (hardkódolva a kompatibilitás miatt,
                // de később kiterjeszthető más forrásokra is)
                const allRows = await fetchAllValidationRows(
                    [Query.equal('source', VALIDATION_SOURCES.PREFLIGHT)],
                    'useWorkflowValidation.loadExisting'
                );

                if (allRows.length === 0) return;

                for (const doc of allRows) {
                    const items = [];
                    if (doc.errors && doc.errors.length > 0) {
                        items.push(...doc.errors.map(msg => ({ type: VALIDATION_TYPES.ERROR, message: msg, source: VALIDATION_SOURCES.PREFLIGHT })));
                    }
                    if (doc.warnings && doc.warnings.length > 0) {
                        items.push(...doc.warnings.map(msg => ({ type: VALIDATION_TYPES.WARNING, message: msg, source: VALIDATION_SOURCES.PREFLIGHT })));
                    }
                    
                    if (items.length > 0) {
                        updateArticleValidation(doc.articleId, VALIDATION_SOURCES.PREFLIGHT, items);
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
     * Per-(articleId, source) queuePersist: sorba fűzi az egymás utáni hívásokat,
     * hogy a fetch+write párok ne keveredjenek.
     */
    const persistToDatabase = useCallback((articleId, publicationId, source, result) => {
        const permissions = buildPermissions();
        if (!permissions) return Promise.resolve();
        return queuePersist(`${source}::${articleId}`, async () => {
            try {
                // 1. Meglévő sor keresése ehhez a cikkhez és forráshoz
                const existingRows = await fetchAllValidationRows(
                    [
                        Query.equal('articleId', articleId),
                        Query.equal('source', source)
                    ],
                    'useWorkflowValidation.persistFetch'
                );

                const hasContent = result.errors.length > 0 || result.warnings.length > 0;
                const data = { errors: result.errors, warnings: result.warnings };

                if (hasContent) {
                    if (existingRows.length > 0) {
                        await withRetry(
                            () => tables.updateRow({
                                databaseId: DATABASE_ID,
                                tableId: COLLECTIONS.SYSTEM_VALIDATIONS,
                                rowId: existingRows[0].$id,
                                data
                            }),
                            { operationName: `updatePreflight(${articleId})` }
                        );
                    } else {
                        // Create — ID-t előre generáljuk, hogy retry esetén ne jöjjön létre duplikátum
                        const generatedRowId = ID.unique();
                        await withRetry(
                            () => tables.createRow({
                                databaseId: DATABASE_ID,
                                tableId: COLLECTIONS.SYSTEM_VALIDATIONS,
                                rowId: generatedRowId,
                                data: {
                                    articleId,
                                    publicationId,
                                    source,
                                    ...data
                                },
                                permissions
                            }),
                            { operationName: `createPreflight(${articleId})` }
                        );
                    }
                } else if (existingRows.length > 0) {
                    await withRetry(
                        () => tables.deleteRow({
                            databaseId: DATABASE_ID,
                            tableId: COLLECTIONS.SYSTEM_VALIDATIONS,
                            rowId: existingRows[0].$id
                        }),
                        { operationName: `deletePreflight(${articleId})` }
                    );
                }

                log(`[useWorkflowValidation] Eredmény mentve (article: ${articleId}, source: ${source}, hibák: ${result.errors.length}).`);
            } catch (error) {
                logError('[useWorkflowValidation] DB mentés sikertelen:', error);
            }
        });
    }, [buildPermissions]);

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

        // Kiadvány rootPath átadása az útvonal feloldáshoz (ExtendScript-nek abszolút kell)
        const pub = publicationsRef.current?.find(p => p.$id === article.publicationId);
        const resultWrapper = await validate(article, validatorType, { options, publicationRootPath: pub?.rootPath });
        const result = resultWrapper.details[validatorType] || resultWrapper; // Fallback ha structure changes

        // Csatolatlan meghajtók → csak toast, nem mentjük
        if (result.skipped) {
            log(`[useWorkflowValidation] Kihagyva (csatolatlan meghajtó) — ${result.unmountedDrives?.join(', ')}`);
            const driveList = result.unmountedDrives?.join(', ') || '';
            showToast(
                'A validáció nem futott le',
                TOAST_TYPES.ERROR,
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
        const source = validatorType === VALIDATOR_TYPES.PREFLIGHT_CHECK ? VALIDATION_SOURCES.PREFLIGHT : validatorType;

        // ValidationContext frissítés - Átalakítás ValidationItem-ekre
        const items = [];
        if (validationResult.errors.length > 0) {
            items.push(...validationResult.errors.map(msg => ({ type: VALIDATION_TYPES.ERROR, message: msg, source })));
        }
        if (validationResult.warnings.length > 0) {
            items.push(...validationResult.warnings.map(msg => ({ type: VALIDATION_TYPES.WARNING, message: msg, source })));
        }

        updateArticleValidation(article.$id, source, items);

        // DB mentés - Marad a régi struktúra (errors/warnings tömbök)
        persistToDatabase(article.$id, article.publicationId, source, validationResult);

        return result;
    }, [updateArticleValidation, persistToDatabase, showToast]);

    // Legacy wrapper a kompatibilitásért (Workspace.jsx, preflightCheck.js)
    const runAndPersistPreflight = useCallback((article) => {
        const wf = workflowRef.current;
        const stateValidations = getStateValidations(wf, article.state);
        const preflightConfig = stateValidations?.onEntry?.find(v => v.validator === VALIDATOR_TYPES.PREFLIGHT_CHECK);
        const options = preflightConfig?.options || {};

        return runValidation(article, VALIDATOR_TYPES.PREFLIGHT_CHECK, options);
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
            const wf = workflowRef.current;
            const stateValidations = getStateValidations(wf, article.state);
            if (!stateValidations?.onEntry) return;

            stateValidations.onEntry.forEach(config => {
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
            const wf = workflowRef.current;
            const stateValidations = getStateValidations(wf, article.state);
            if (!stateValidations?.onEntry) return;

            stateValidations.onEntry.forEach(config => {
                log(`[useWorkflowValidation] Auto-validáció (closed): ${config.validator} (${article.name})`);
                registerTask(callbacksRef.current.runValidation(article, config.validator, config.options));
            });
        };

        const handleStateChanged = (event) => {
            const { article, previousState, newState } = event.detail;
            if (!article?.$id) return;

            // A cikk ref-alapú ellenőrzése: ha időközben kiesett a scope-ból
            // (pub switch / törlés), az eseményre nem reagálunk.
            // A payload cikk-objektumát a CF szinkron válaszából kapjuk — ez a legfrissebb
            // állapot, még a DataContext applyArticleUpdate előtti pillanatban is.
            const stillExists = articlesRef.current.some(a => a.$id === article.$id);
            if (!stillExists) return;

            const wf = workflowRef.current;
            const prevValidations = getStateValidations(wf, previousState);
            const newValidations = getStateValidations(wf, newState);

            const hadPreflight = prevValidations?.onEntry?.some(v => v.validator === VALIDATOR_TYPES.PREFLIGHT_CHECK);
            const hasPreflight = newValidations?.onEntry?.some(v => v.validator === VALIDATOR_TYPES.PREFLIGHT_CHECK);

            if (hadPreflight && !hasPreflight) {
                 log(`[useWorkflowValidation] Preflight eredmények törlése (kilépés): "${article.name}"`);
                 callbacksRef.current.clearArticleValidation(article.$id, VALIDATION_SOURCES.PREFLIGHT);
                 callbacksRef.current.persistToDatabase(article.$id, article.publicationId, VALIDATION_SOURCES.PREFLIGHT, { errors: [], warnings: [] });
            }

            // Belépés az új állapotba: futtatás
            runAutoValidations(article);
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
