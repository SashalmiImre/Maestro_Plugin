/**
 * @file useDatabaseIntegrityValidation.js
 * @description Adatbázis-integritás validáció: oldalszámok szinkronban tartása az InDesign fájllal.
 *
 * Event-driven triggerek:
 * 1. `MaestroEvent.documentSaved`  — validáció mentéskor
 * 2. `MaestroEvent.documentClosed` — validáció bezáráskor (registerTask)
 *
 * A DatabaseIntegrityValidator auto-correct módban fut: ha eltérést talál
 * az InDesign fájl és az adatbázis között, automatikusan javítja az adatbázist,
 * és dispatolja a `MaestroEvent.pageRangesChanged` eventet (az overlap validátor számára).
 */

import { useEffect, useRef, useCallback } from "react";
import { MaestroEvent } from "../../core/config/maestroEvents.js";
import { useData } from "../../core/contexts/DataContext.jsx";
import { useToast } from "../../ui/common/Toast/ToastContext.jsx";
import { TOAST_TYPES } from "../../core/utils/constants.js";
import { DatabaseIntegrityValidator } from "../../core/utils/validators/index.js";
import { log, logError } from "../../core/utils/logger.js";

/**
 * Hook az adatbázis-integritás validáció event-driven kezeléséhez.
 * PublicationList szinten kell bekötni (a DocumentMonitor mellé).
 */
export const useDatabaseIntegrityValidation = () => {
    const { applyArticleUpdate } = useData();
    const { showToast } = useToast();
    const validator = useRef(new DatabaseIntegrityValidator());

    // Serialization: Promise chain a gyors egymás utáni mentések kezelésére
    const queueRef = useRef(Promise.resolve());

    /**
     * Futtatja a DatabaseIntegrityValidator-t auto-correct módban.
     * Ha eltérést talál, javít és toast-ot mutat.
     * Az auto-correction eredményét applyArticleUpdate-tel azonnal frissíti a DataContext-ben,
     * hogy az ArticleTable azonnal tükrözze a változásokat.
     */
    const handleValidation = useCallback(async (article) => {
        try {
            log(`[useDatabaseIntegrityValidation] Validáció futtatása: "${article.name}"`);

            const result = await validator.current.validate({
                article,
                autoCorrect: true
            });

            if (result.isValid && result.warnings?.length > 0) {
                log(`[useDatabaseIntegrityValidation] Javítás alkalmazva: ${result.warnings[0]}`);
                showToast('Adatok automatikusan javítva', TOAST_TYPES.SUCCESS, `A(z) „${article.name}" cikk adatai frissültek a dokumentum alapján.`);

                // Azonnali helyi frissítés a szerver válaszával
                if (result.correctedArticle) {
                    applyArticleUpdate(result.correctedArticle);
                }
            } else if (!result.isValid) {
                logError("[useDatabaseIntegrityValidation] Validáció sikertelen:", result.errors);
            }
        } catch (error) {
            logError("[useDatabaseIntegrityValidation] Validáció hiba:", error);
        }
    }, [showToast, applyArticleUpdate]);

    // Ref a stabil hivatkozáshoz az event handlerekben
    const handleValidationRef = useRef(handleValidation);
    useEffect(() => {
        handleValidationRef.current = handleValidation;
    }, [handleValidation]);

    /**
     * Event feliratkozások:
     * - MaestroEvent.documentSaved  → validáció futtatása (serializálva)
     * - MaestroEvent.documentClosed → validáció futtatása registerTask-kal
     */
    useEffect(() => {
        const handleDocumentSaved = (event) => {
            const { article } = event.detail;

            // Serializáció: gyors egymás utáni mentéseknél ne fusson párhuzamosan
            queueRef.current = queueRef.current.then(
                () => handleValidationRef.current(article)
            ).catch(error => {
                logError('[useDatabaseIntegrityValidation] Queue hiba:', error);
            });
        };

        const handleDocumentClosed = (event) => {
            const { article, registerTask } = event.detail;
            registerTask(handleValidationRef.current(article));
        };

        window.addEventListener(MaestroEvent.documentSaved, handleDocumentSaved);
        window.addEventListener(MaestroEvent.documentClosed, handleDocumentClosed);

        return () => {
            window.removeEventListener(MaestroEvent.documentSaved, handleDocumentSaved);
            window.removeEventListener(MaestroEvent.documentClosed, handleDocumentClosed);
        };
    }, []);
};
