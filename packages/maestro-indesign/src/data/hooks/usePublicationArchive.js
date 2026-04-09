/**
 * @fileoverview Teljes kiadvány archiválási hook.
 *
 * Kiszámítja, hogy az aktív kiadvány archiválható-e (minden cikk ARCHIVABLE
 * + nincs oldalrés + felhasználói jogosultság), és szekvenciálisan futtatja
 * az archive + export_pdf parancsot minden cikkre.
 *
 * @module data/hooks/usePublicationArchive
 */

// React
import { useMemo, useState, useCallback, useRef } from "react";

// Kontextusok & Hook-ok
import { useData } from "../../core/contexts/DataContext.jsx";
import { useUser } from "../../core/contexts/UserContext.jsx";
import { useToast } from "../../ui/common/Toast/ToastContext.jsx";

// Konfiguráció & Konstansok
import { TOAST_TYPES } from "../../core/utils/constants.js";
import { isTerminalState, canRunCommand } from "maestro-shared/workflowRuntime.js";

// Segédfüggvények
import { executeCommand } from "../../core/commands/index.js";
import { buildPlaceholderRows } from "../../core/utils/pageGapUtils.js";
import { log, logError } from "../../core/utils/logger.js";

/**
 * Teljes kiadvány archiválási hook.
 *
 * @returns {{
 *   canArchivePublication: boolean,
 *   isArchiving: boolean,
 *   archiveProgress: { current: number, total: number, currentArticleName: string } | null,
 *   archivePublication: () => Promise<void>
 * }}
 */
export function usePublicationArchive() {
    const { articles, publications, activePublicationId, workflow } = useData();
    const { user } = useUser();
    const { showToast } = useToast();

    const [isArchiving, setIsArchiving] = useState(false);
    const [archiveProgress, setArchiveProgress] = useState(null);

    // Ref-ek a hosszú aszinkron ciklus számára — a closure-ök elavulhatnak percek alatt
    const isArchivingRef = useRef(false);
    const articlesRef = useRef(articles);
    const publicationRef = useRef(null);
    const userRef = useRef(user);
    articlesRef.current = articles;
    userRef.current = user;

    const publication = useMemo(() => {
        if (!activePublicationId) return null;
        return publications.find(p => p.$id === activePublicationId) || null;
    }, [publications, activePublicationId]);
    publicationRef.current = publication;

    /**
     * Meghatározza, hogy a teljes kiadvány archiválás gombja megjeleníthető-e.
     *
     * Feltételek:
     * 1. Van aktív kiadvány cikkekkel
     * 2. A coverage be van állítva (coverageStart és coverageEnd)
     * 3. Minden cikk ARCHIVABLE állapotban van
     * 4. Nincs oldalrés (buildPlaceholderRows üres)
     * 5. A felhasználó az archive parancs csapataiban van
     */
    const canArchivePublication = useMemo(() => {
        if (!publication || articles.length === 0 || !workflow) return false;
        if (publication.coverageStart == null || publication.coverageEnd == null) return false;

        const allTerminal = articles.every(a => isTerminalState(workflow, a.state));
        if (!allTerminal) return false;

        if (buildPlaceholderRows(articles, publication).length > 0) return false;

        // A felhasználó futtathatja-e az archive parancsot a terminális állapotban
        const terminalState = articles[0]?.state;
        const userGroups = user?.groupSlugs || [];
        return canRunCommand(workflow, terminalState, 'archive', userGroups).allowed;
    }, [articles, publication, user, workflow]);

    /**
     * Szekvenciálisan archiválja az összes cikket (archive + PDF export).
     */
    const archivePublication = useCallback(async () => {
        if (!publicationRef.current || isArchivingRef.current) return;

        isArchivingRef.current = true;
        setIsArchiving(true);
        setArchiveProgress(null);

        const sorted = [...articlesRef.current].sort((a, b) => (a.startPage || 0) - (b.startPage || 0));
        const total = sorted.length;
        const pub = publicationRef.current;

        log(`[PublicationArchive] Indítás — kiadvány: ${pub.name}, cikkek: ${total}`);
        showToast(`Teljes archiválás indítása... (${total} cikk)`, TOAST_TYPES.INFO);

        let successCount = 0;
        const errors = [];

        try {
            for (let i = 0; i < sorted.length; i++) {
                const article = sorted[i];
                setArchiveProgress({ current: i + 1, total, currentArticleName: article.name });

                const archiveResult = await executeCommand('archive', { item: article, publication: pub, user: userRef.current });

                if (!archiveResult.success) {
                    const msg = `${article.name}: archiválás — ${archiveResult.error}`;
                    logError(`[PublicationArchive] ${msg}`);
                    errors.push(msg);
                    continue;
                }

                const pdfResult = await executeCommand('export_pdf', { item: article, publication: pub, user: userRef.current });

                if (!pdfResult.success) {
                    const msg = `${article.name}: PDF export — ${pdfResult.error}`;
                    logError(`[PublicationArchive] ${msg}`);
                    errors.push(msg);
                    continue;
                }

                successCount++;
            }

            if (errors.length === 0) {
                showToast(`Archiválás kész: ${successCount}/${total} cikk sikeresen archiválva`, TOAST_TYPES.SUCCESS);
            } else if (successCount > 0) {
                showToast(`Archiválás befejezve: ${successCount}/${total} sikeres, ${errors.length} hiba`, TOAST_TYPES.WARNING, errors.join('\n'));
            } else {
                showToast(`Archiválás sikertelen`, TOAST_TYPES.ERROR, errors.join('\n'));
            }

            log(`[PublicationArchive] Befejezve — sikeres: ${successCount}/${total}, hibák: ${errors.length}`);
        } finally {
            isArchivingRef.current = false;
            setIsArchiving(false);
            setArchiveProgress(null);
        }
    }, [showToast]);

    return { canArchivePublication, isArchiving, archiveProgress, archivePublication };
}
