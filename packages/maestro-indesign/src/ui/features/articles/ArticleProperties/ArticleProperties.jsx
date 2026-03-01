// React
import React, { useState } from "react";

// Contexts & Custom Hooks
import { useUser } from "../../../../core/contexts/UserContext.jsx";
import { useData } from "../../../../core/contexts/DataContext.jsx";
import { useValidation } from "../../../../core/contexts/ValidationContext.jsx";
import { useToast } from "../../../common/Toast/ToastContext.jsx";
import { useArticles } from "../../../../data/hooks/useArticles.js";
import { useUnifiedValidation } from "../../../../data/hooks/useUnifiedValidation.js";

// Config & Constants
import { MaestroEvent, dispatchMaestroEvent } from "../../../../core/config/maestroEvents.js";
import { VALIDATION_SOURCES } from "../../../../core/utils/validationConstants.js";
import { VALIDATION_TYPES } from "../../../../core/utils/messageConstants.js";

// Feature Components
import { GeneralSection } from "./GeneralSection.jsx";
import { ContributorsSection } from "./ContributorsSection.jsx";
import { ValidationSection } from "./ValidationSection.jsx";

// Utils
import { isValidFileName } from "../../../../core/utils/pathUtils.js";
import { WorkflowEngine } from "../../../../core/utils/workflow/workflowEngine.js";
import { canUserMoveArticle } from "../../../../core/utils/workflow/workflowPermissions.js";
import { SCRIPT_LANGUAGE_JAVASCRIPT, TOAST_TYPES } from "../../../../core/utils/constants.js";
import { WORKFLOW_CONFIG, MARKERS } from "../../../../core/utils/workflow/workflowConstants.js";
import { log, logError, logWarn } from "../../../../core/utils/logger.js";
import {
    generateRenumberDocumentScript,
    generateExtractPageRangesScript,
    generateIsDocumentOpenScript,
    generateOpenDocumentScript,
    generateSaveDocumentScript,
    generateCloseDocumentScript,
    parsePageRangesResult,
    parseExecutionStatus
} from "../../../../core/utils/indesign/index.js";

// ── Komponens ────────────────────────────────────────────────────────────────

export const ArticleProperties = ({ article, publication, onUpdate }) => {
    const { user } = useUser();
    const { updateArticle, applyArticleUpdate } = useData();
    const { updateArticleValidation } = useValidation();
    const { renameArticle } = useArticles(article?.publicationId, null, false);
    const { showToast } = useToast();
    const { hasErrors } = useUnifiedValidation(article);
    const [isSyncing, setIsSyncing] = useState(false);
    const isIgnored = ((typeof article?.markers === 'number' ? article.markers : 0) & MARKERS.IGNORE) !== 0;

    // ── Mező frissítés ───────────────────────────────────────────────────────

    /**
     * Egyetlen cikkmező frissítése az adatbázisban.
     * A 'name' mezőt a renameArticle hook kezeli (fájl átnevezéssel együtt),
     * minden mást közvetlen Appwrite updateDocument hívással frissít.
     *
     * @param {string} field - Mezőnév
     * @param {*}      value - Új érték
     */
    const handleFieldUpdate = async (field, value) => {
        if (field === 'name') {
            // Fájlnév karakter validáció
            if (!isValidFileName(value)) {
                showToast(
                    'Érvénytelen fájlnév',
                    TOAST_TYPES.ERROR,
                    'A név nem tartalmazhat a következő karaktereket: \\ / : * ? " < > |'
                );
                return;
            }

            // Zárolás ellenőrzése: ha más szerkeszti, az átnevezés hibát okozna nála
            if (article.lockOwnerId && article.lockOwnerId !== user?.$id) {
                showToast(
                    'Az átnevezés nem lehetséges',
                    TOAST_TYPES.ERROR,
                    'A cikket jelenleg más felhasználó szerkeszti. Az átnevezés az ő nem mentett módosításainak elvesztését okozná.'
                );
                return;
            }

            setIsSyncing(true);
            try {
                const updated = await renameArticle(article, value);
                if (updated && onUpdate) onUpdate(updated);
            } catch (error) {
                logError("[ArticleProperties] Rename failed:", error);
            } finally {
                setIsSyncing(false);
            }
            return;
        }

        setIsSyncing(true);
        try {
            const updated = await updateArticle(article.$id, { [field]: value });

            if (updated[field] !== value) {
                logWarn(`[ArticleProperties] A '${field}' mező NEM frissült! Várt: ${value}, Kapott: ${updated[field]}`);
                showToast('A mező frissítése sikertelen', TOAST_TYPES.ERROR, `A(z) „${field}" mező nem frissült a várt értékre. Próbáld meg újra, vagy frissítsd az adatokat.`);
            } else {
                showToast('Módosítás mentve', TOAST_TYPES.SUCCESS);
            }

            // Layout változás → átfedés-újravalidálás
            if (field === 'layout') {
                dispatchMaestroEvent(MaestroEvent.layoutChanged, { article: updated });
            }

            if (onUpdate) onUpdate(updated);
        } catch (error) {
            logError(`[ArticleProperties] Failed to update ${field}:`, error);
            showToast('Mentés sikertelen', TOAST_TYPES.ERROR, error.message || 'Ismeretlen hiba történt a mező frissítése közben.');
        } finally {
            setIsSyncing(false);
        }
    };

    // ── InDesign script végrehajtás ──────────────────────────────────────────

    /** InDesign ExtendScript futtatása logolással. */
    const executeInDesignScript = (script, description) => {
        log(`[ArticleProperties] ${description}...`);
        const app = require("indesign").app;
        return app.doScript(script, SCRIPT_LANGUAGE_JAVASCRIPT, []);
    };

    // ── Oldalszám változtatás ────────────────────────────────────────────────

    /**
     * Kezdőoldal módosítása InDesign átszámozással.
     *
     * ORCHESTRATOR minta — atomi InDesign műveletek sorozata:
     *   1. Dokumentum nyitva van-e? (állapot megőrzés)
     *   2. Megnyitás ha szükséges
     *   3. Átszámozás (renumber)
     *   4. Új oldalszámok kinyerése (extract page ranges)
     *   5. Mentés (maestroSkipMonitor flag-gel)
     *   6. Bezárás (ha mi nyitottuk)
     *
     * @param {number} newStartPage - Új kezdőoldal
     * @param {number} offset       - Eltolás (newStart - oldStart, lehet negatív)
     * @returns {Promise<boolean>} Sikeres-e a művelet
     */
    const handlePageNumberChange = async (newStartPage, offset) => {
        if (!article.filePath) {
            showToast('Oldalszám módosítás nem lehetséges', TOAST_TYPES.ERROR, 'A cikkhez nem tartozik fájl útvonal. Ellenőrizd, hogy a cikk megfelelően van-e beállítva.');
            return false;
        }

        if (article.startPage == null) {
            showToast('Oldalszám módosítás nem lehetséges', TOAST_TYPES.ERROR, 'A cikknek még nincs beállítva érvényes kezdőoldala.');
            return false;
        }

        // Új végoldal kiszámítása az aktuális oldalszám alapján
        const currentStart = article.startPage || 0;
        const currentEnd = article.endPage || currentStart;
        const articlePageCount = currentEnd - currentStart + 1;
        const newEndPage = newStartPage + articlePageCount - 1;

        // Kiadvány-terjedelem validáció
        if (publication?.coverageStart != null && publication?.coverageEnd != null) {
            if (newStartPage < publication.coverageStart) {
                showToast('Érvénytelen oldalszám', TOAST_TYPES.ERROR, `A megadott kezdőoldal (${newStartPage}) a kiadvány terjedelme (${publication.coverageStart}–${publication.coverageEnd}) elé esik.`);
                return false;
            }
            if (newEndPage > publication.coverageEnd) {
                showToast('Érvénytelen oldalszám', TOAST_TYPES.ERROR, `A cikk végoldala (${newEndPage}) túllépi a kiadvány terjedelmét (${publication.coverageStart}–${publication.coverageEnd}).`);
                return false;
            }
        }

        setIsSyncing(true);
        const filePath = article.filePath;
        let wasAlreadyOpen = false;

        try {
            // 1. Dokumentum nyitva van-e?
            const isOpenResult = executeInDesignScript(generateIsDocumentOpenScript(filePath), "Checking if document is open");
            wasAlreadyOpen = String(isOpenResult).trim() === "true";
            log('[ArticleProperties] Document open state:', wasAlreadyOpen);

            // 2. Megnyitás ha szükséges
            if (!wasAlreadyOpen) {
                const openResult = executeInDesignScript(generateOpenDocumentScript(filePath, true, false), "Opening document in background");
                if (openResult !== "success") throw new Error(`Could not open document: ${openResult}`);
            } else {
                executeInDesignScript(generateOpenDocumentScript(filePath, false, false), "Ensuring document active");
            }

            // 3. Átszámozás
            const renumberResult = executeInDesignScript(generateRenumberDocumentScript(offset, filePath), "Renumbering document");
            const parsedRenumber = parseExecutionStatus(renumberResult);
            if (!parsedRenumber.success) throw new Error(parsedRenumber.error);

            // 4. Oldalszámok kinyerése
            const extractResultStr = executeInDesignScript(generateExtractPageRangesScript(filePath), "Extracting new page ranges");
            const extractResult = parsePageRangesResult(extractResultStr);
            if (!extractResult.success) {
                logWarn('[ArticleProperties] Page extraction failed:', extractResult.error);
            }

            // 5. Mentés (maestroSkipMonitor: DocumentMonitor ne reagáljon)
            if (typeof window !== 'undefined') window.maestroSkipMonitor = true;
            const saveResult = executeInDesignScript(generateSaveDocumentScript(filePath), "Saving document");
            const parsedSave = parseExecutionStatus(saveResult);
            if (!parsedSave.success) {
                throw new Error(`Failed to save document: ${parsedSave.error || 'Unknown error'}`);
            }

            // 6. Bezárás (csak ha mi nyitottuk)
            if (!wasAlreadyOpen) {
                executeInDesignScript(generateCloseDocumentScript(filePath), "Closing document (restoring state)");
            }

            // Adatbázis frissítés
            const updateData = {
                startPage: extractResult.success ? extractResult.startPage : newStartPage,
                endPage: extractResult.success ? extractResult.endPage : (article.endPage ? article.endPage + offset : null),
                pageRanges: extractResult.success ? extractResult.pageRanges : article.pageRanges
            };

            log('[ArticleProperties] Updating database with:', updateData);

            const updated = await updateArticle(article.$id, updateData);

            showToast('Oldalszámok frissítve', TOAST_TYPES.SUCCESS);

            // Átfedés-validáció kiváltása
            dispatchMaestroEvent(MaestroEvent.pageRangesChanged, { article: updated });

            if (onUpdate) onUpdate(updated);
            return true;

        } catch (error) {
            logError('[ArticleProperties] Start page change failed:', error);

            // Ha mi nyitottuk meg és hiba történt, próbáljuk bezárni
            if (!wasAlreadyOpen && filePath) {
                try {
                    executeInDesignScript(generateCloseDocumentScript(filePath), "Emergency cleanup");
                } catch (cleanupError) {
                    logError('[ArticleProperties] Failed to close document during cleanup:', cleanupError);
                }
            }

            showToast('Az átszámozás sikertelen', TOAST_TYPES.ERROR, error.message || 'Ismeretlen hiba történt az oldalszámok módosítása közben.');
            return false;
        } finally {
            setIsSyncing(false);
        }
    };

    // ── Állapotváltás (workflow) ─────────────────────────────────────────────

    /**
     * Workflow állapotátmenet végrehajtása.
     * Validál (WorkflowEngine.validateTransition), majd végrehajt (executeTransition).
     *
     * @param {number} targetState - Cél-állapot száma
     */
    const handleStateTransition = async (targetState) => {
        setIsSyncing(true);

        if (hasErrors) {
            showToast(
                'Az állapotváltás nem lehetséges',
                TOAST_TYPES.ERROR,
                'A cikkhez javítatlan hibák tartoznak (validáció vagy felhasználói üzenet). Kérjük, javítsd vagy minősítsd vissza őket.'
            );
            setIsSyncing(false);
            return;
        }

        // Jogosultsági ellenőrzés (a validáció előtt — a drága preflight ne fusson feleslegesen)
        const permission = canUserMoveArticle(article, article.state, user);
        if (!permission.allowed) {
            showToast(
                'Nincs jogosultságod az állapotváltáshoz',
                TOAST_TYPES.ERROR,
                permission.reason
            );
            setIsSyncing(false);
            return;
        }

        if (!article.filePath && !article.FilePath) {
            logError("[ArticleProperties] Missing file path for article:", article);
            showToast('Az állapotváltás nem lehetséges', TOAST_TYPES.ERROR, 'A cikkhez nem tartozik fájl útvonal. Próbáld frissíteni az adatokat.');
            setIsSyncing(false);
            return;
        }

        try {
            const validation = await WorkflowEngine.validateTransition(article, targetState);
            if (!validation.isValid) {
                setIsSyncing(false);
                // Csatolatlan meghajtó → specifikus toast, a validációs eredményeket nem bántjuk
                if (validation.skipped) {
                    const driveList = validation.unmountedDrives?.join(', ') || '';
                    showToast(
                        'Az állapotváltás nem lehetséges',
                        TOAST_TYPES.ERROR,
                        `A preflight ellenőrzés nem tudott lefutni, mert a következő hálózati meghajtó(k) nem elérhetők: ${driveList}. ` +
                        'Kérjük, ellenőrizd a hálózati kapcsolatot, majd próbáld újra.'
                    );
                    return;
                }

                // Preflight hibák beírása a ValidationContext-be → megjelennek a ValidationSection-ben
                const items = [];
                if (validation.errors?.length > 0) {
                    items.push(...validation.errors.map(msg => ({ type: VALIDATION_TYPES.ERROR, message: msg, source: VALIDATION_SOURCES.PREFLIGHT })));
                }
                if (validation.warnings?.length > 0) {
                    items.push(...validation.warnings.map(msg => ({ type: VALIDATION_TYPES.WARNING, message: msg, source: VALIDATION_SOURCES.PREFLIGHT })));
                }
                if (items.length > 0) {
                    updateArticleValidation(article.$id, VALIDATION_SOURCES.PREFLIGHT, items);
                }

                const errorDetails = validation.errors?.length > 0
                    ? validation.errors.join('\n')
                    : 'Az ellenőrzés során nem azonosítható hiba merült fel. Próbáld meg újra.';
                showToast('Az állapotváltás nem lehetséges', TOAST_TYPES.ERROR, errorDetails);
                return;
            }

            const result = await WorkflowEngine.executeTransition(article, targetState, user);
            if (result.success) {
                if (result.document) applyArticleUpdate(result.document);
                if (onUpdate && result.document) onUpdate(result.document);
                const targetConfig = WORKFLOW_CONFIG[targetState]?.config;
                showToast(`Állapot: ${targetConfig?.label || 'Frissítve'}`, TOAST_TYPES.SUCCESS);
            } else {
                logError("[ArticleProperties] Transition error:", result.error);
                showToast('Az állapotváltás sikertelen', TOAST_TYPES.ERROR, result.error || 'Ismeretlen hiba történt a végrehajtás során.');
            }
        } catch (error) {
            logError("[ArticleProperties] Transition exception:", error);
            showToast('Az állapotváltás sikertelen', TOAST_TYPES.ERROR, error.message || 'Váratlan hiba történt a végrehajtás során.');
        } finally {
            setIsSyncing(false);
        }
    };

    // ── Renderelés ───────────────────────────────────────────────────────────

    return (
        <div style={{
            padding: "16px",
            position: "relative",
            zIndex: 1,
            height: "100%",
            display: "flex",
            flexDirection: "column",
            boxSizing: "border-box"
        }}>
            <div style={{
                display: "flex",
                flexDirection: "column",
                flex: "1 1 auto",
                overflowY: "auto",
                minHeight: 0,
                paddingBottom: "16px",
                paddingRight: "8px"
            }}>
                {/* Figyelmeztető üzenet ha a cikk ki van hagyva — minden szekció ELŐTT */}
                {isIgnored && (
                    <div style={{
                        backgroundColor: "var(--spectrum-global-color-gray-300)",
                        borderRadius: "4px",
                        padding: "10px 12px",
                        marginBottom: "12px",
                        fontSize: "12px",
                        color: "var(--spectrum-global-color-gray-800)",
                        textAlign: "center",
                        position: "relative",
                        zIndex: 2,
                        flexShrink: 0
                    }}>
                        A cikk ideiglenesen ki van hagyva a kiadványból. A „Kimarad" jelölő kikapcsolásával a munka onnan folytatható, ahol abbamaradt.
                    </div>
                )}

                <GeneralSection
                    article={article}
                    user={user}
                    onFieldUpdate={handleFieldUpdate}
                    onPageNumberChange={handlePageNumberChange}
                    onStateTransition={handleStateTransition}
                    isSyncing={isSyncing}
                />

                <ValidationSection article={article} disabled={isIgnored} />

                <ContributorsSection
                    article={article}
                    onFieldUpdate={handleFieldUpdate}
                    disabled={isIgnored}
                />
            </div>
        </div>
    );
};
