// React
import React, { useState, useCallback, useEffect, useMemo } from "react";

// Components
import { ArticleTable } from "../../articles/ArticleTable.jsx";
import { ConfirmDialog } from "../../../common/ConfirmDialog.jsx";
import { FilterBar } from "./FilterBar.jsx";

// Custom Hooks
import { useArticles } from "../../../../data/hooks/useArticles.js";
import { useUser } from "../../../../core/contexts/UserContext.jsx";
import { useToast } from "../../../common/Toast/ToastContext.jsx";

// Utils
import { WORKFLOW_STATES, MARKERS, TEAM_ARTICLE_FIELD, labelMatchesSlug } from "../../../../core/utils/workflow/workflowConstants.js";
import { DRIVE_CHECK_INTERVAL_MS, STORAGE_KEYS } from "../../../../core/utils/constants.js";
import { log, logError } from "../../../../core/utils/logger.js";
import { checkPathAccessible, toNativePath } from "../../../../core/utils/pathUtils.js";
import { MaestroEvent, dispatchMaestroEvent } from "../../../../core/config/maestroEvents.js";
import { checkElementPermission, PUBLICATION_ELEMENT_PERMISSIONS } from "../../../../core/utils/workflow/elementPermissions.js";
import { buildPlaceholderRows } from "../../../../core/utils/pageGapUtils.js";

export const Publication = React.memo(({ publication, onDelete, onRename, onShowProperties, isExpanded, onToggle }) => {
    const { user } = useUser();
    const { showToast } = useToast();
    const {
        articles,
        addArticle,
        openArticle
    } = useArticles(publication.$id, publication.rootPath);

    const [isHovered, setIsHovered] = useState(false);

    // Meghajtó/mappa elérhetőség ellenőrzése (rootPath)
    const [isDriveAccessible, setIsDriveAccessible] = useState(true);
    // Egyszeri elérhetőség-ellenőrzés mount-kor (összecsukott állapotban is fusson)
    useEffect(() => {
        let mounted = true;
        checkPathAccessible(toNativePath(publication.rootPath))
            .then(accessible => { if (mounted) setIsDriveAccessible(accessible); });
        return () => { mounted = false; };
    }, [publication.rootPath]);

    // Folyamatos polling (2s) + event listenerek — ha a kiadvány ki van nyitva
    useEffect(() => {
        if (!isExpanded) return;

        let mounted = true;
        let isChecking = false;

        const checkAccess = async () => {
            if (isChecking) return;
            isChecking = true;
            try {
                const accessible = await checkPathAccessible(
                    toNativePath(publication.rootPath)
                );
                if (mounted) setIsDriveAccessible(accessible);
            } finally {
                isChecking = false;
            }
        };

        checkAccess();

        const pollIntervalId = setInterval(checkAccess, DRIVE_CHECK_INTERVAL_MS);

        const handleFocus = () => checkAccess();
        window.addEventListener('focus', handleFocus);
        window.addEventListener(MaestroEvent.panelShown, handleFocus);
        window.addEventListener(MaestroEvent.dataRefreshRequested, handleFocus);
        return () => {
            mounted = false;
            clearInterval(pollIntervalId);
            window.removeEventListener('focus', handleFocus);
            window.removeEventListener(MaestroEvent.panelShown, handleFocus);
            window.removeEventListener(MaestroEvent.dataRefreshRequested, handleFocus);
        };
    }, [isExpanded, publication.rootPath]);

    // Dialog state
    const [dialogOpen, setDialogOpen] = useState(false);
    const [dialogConfig, setDialogConfig] = useState({ title: "", message: "", isAlert: false });

    // Filter state (localStorage-ból inicializálva)
    const [filterOpen, setFilterOpen] = useState(false);
    const [statusFilters, setStatusFilters] = useState(() => {
        try {
            const saved = localStorage.getItem(STORAGE_KEYS.FILTER_STATUS);
            if (saved) {
                const parsed = JSON.parse(saved);
                if (Array.isArray(parsed)) return parsed;
            }
        } catch (error) {
            logError(`[Publication] Error parsing statusFilters from localStorage (key: ${STORAGE_KEYS.FILTER_STATUS}):`, error);
        }
        return Object.values(WORKFLOW_STATES);
    });
    const [showIgnored, setShowIgnored] = useState(
        () => localStorage.getItem(STORAGE_KEYS.FILTER_SHOW_IGNORED) !== 'false'
    );
    const [showOnlyMine, setShowOnlyMine] = useState(
        () => localStorage.getItem(STORAGE_KEYS.FILTER_SHOW_ONLY_MINE) === 'true'
    );
    const [showPlaceholders, setShowPlaceholders] = useState(
        () => localStorage.getItem(STORAGE_KEYS.FILTER_SHOW_PLACEHOLDERS) !== 'false'
    );

    const allStatuses = Object.values(WORKFLOW_STATES);
    const isFilterActive = statusFilters.length !== allStatuses.length || !showIgnored || showOnlyMine || !showPlaceholders;

    const handleFilterClick = (e) => {
        e.stopPropagation();
        setFilterOpen(!filterOpen);
    };

    const handleStatusFiltersChange = useCallback((newFilters) => {
        setStatusFilters(newFilters);
        localStorage.setItem(STORAGE_KEYS.FILTER_STATUS, JSON.stringify(newFilters));
    }, []);

    const handleShowIgnoredChange = useCallback((value) => {
        setShowIgnored(value);
        localStorage.setItem(STORAGE_KEYS.FILTER_SHOW_IGNORED, String(value));
    }, []);

    const handleShowOnlyMineChange = useCallback((value) => {
        setShowOnlyMine(value);
        localStorage.setItem(STORAGE_KEYS.FILTER_SHOW_ONLY_MINE, String(value));
    }, []);

    const handleShowPlaceholdersChange = useCallback((value) => {
        setShowPlaceholders(value);
        localStorage.setItem(STORAGE_KEYS.FILTER_SHOW_PLACEHOLDERS, String(value));
    }, []);

    const resetFilters = () => {
        setStatusFilters(Object.values(WORKFLOW_STATES));
        setShowIgnored(true);
        setShowOnlyMine(false);
        setShowPlaceholders(true);
        localStorage.removeItem(STORAGE_KEYS.FILTER_STATUS);
        localStorage.removeItem(STORAGE_KEYS.FILTER_SHOW_IGNORED);
        localStorage.removeItem(STORAGE_KEYS.FILTER_SHOW_ONLY_MINE);
        localStorage.removeItem(STORAGE_KEYS.FILTER_SHOW_PLACEHOLDERS);
    };

    /** A felhasználó csapattagságaihoz tartozó contributor mezőnevek */
    const userContributorFields = useMemo(() => {
        const fields = new Set();

        // Csapattagságból
        (user?.teamIds || []).forEach(slug => {
            const field = TEAM_ARTICLE_FIELD[slug];
            if (field) fields.add(field);
        });

        // Label override-ból (a csapatok slug normalizációjával)
        if (user?.labels?.length) {
            for (const [slug, field] of Object.entries(TEAM_ARTICLE_FIELD)) {
                if (labelMatchesSlug(user.labels, slug)) fields.add(field);
            }
        }

        return Array.from(fields);
    }, [user?.teamIds, user?.labels]);

    const filteredArticles = React.useMemo(() => {
        const filtered = articles.filter(article => {
            const statusMatch = statusFilters.includes(article.state || 0);
            const articleMarkers = typeof article.markers === 'number' ? article.markers : 0;
            const markerMatch = showIgnored || (articleMarkers & MARKERS.IGNORE) === 0;
            const ownerMatch = !showOnlyMine || userContributorFields.some(field => article[field] === user?.$id);

            return statusMatch && markerMatch && ownerMatch;
        });

        log(`[Publication] Articles stats: Total fetched: ${articles.length}, Shown: ${filtered.length}. Filtered out: ${articles.length - filtered.length}`);
        return filtered;
    }, [articles, statusFilters, showIgnored, showOnlyMine, userContributorFields, user?.$id]);

    /** Helykitöltő sorok: a kiadvány terjedelmén belüli lefedetlen oldalcsoportok */
    const placeholderRows = useMemo(() => {
        return buildPlaceholderRows(articles, publication);
    }, [articles, publication]);

    /** Táblázat adatai: szűrt cikkek + opcionálisan helykitöltők */
    const tableData = useMemo(() => {
        if (showOnlyMine || !showPlaceholders) return filteredArticles;
        return [...filteredArticles, ...placeholderRows];
    }, [filteredArticles, placeholderRows, showPlaceholders, showOnlyMine]);

    const canOpenPublicationProperties = useMemo(() => {
        return checkElementPermission(PUBLICATION_ELEMENT_PERMISSIONS.publicationProperties, user).allowed;
    }, [user]);

    const handlePublicationDoubleClick = useCallback((e) => {
        e.stopPropagation();
        if (!canOpenPublicationProperties) {
            showToast('Nincs jogosultság', 'error', 'A kiadvány beállításait csak vezető szerkesztők és művészeti vezetők nyithatják meg.');
            return;
        }
        onShowProperties?.(publication, 'publication');
    }, [onShowProperties, publication, canOpenPublicationProperties, showToast]);

    const handleChevronClick = useCallback((e) => {
        e.stopPropagation();
        onToggle?.();
    }, [onToggle]);

    const handleOpenArticle = useCallback(async (article) => {
        try {
            await openArticle(article, user);
        } catch (error) {
            setDialogConfig({
                title: error.message.includes("szerkeszti") ? "Fájl zárolva" : "Hiba a megnyitáskor",
                message: error.message.includes("szerkeszti")
                    ? error.message
                    : `Nem sikerült megnyitni a(z) "${article.name}" fájlt.\n\nRendszerüzenet:\n${error.message}`,
                isAlert: true
            });
            setDialogOpen(true);
        }
    }, [openArticle, user]);

    const handleAddArticleClick = useCallback(async (e) => {
        e.stopPropagation();
        try {
            const fs = require("uxp").storage.localFileSystem;
            const files = await fs.getFileForOpening({
                types: ["indd"],
                allowMultiple: true
            });

            if (!files || files.length === 0) return;

            let skippedFiles = [];
            let errorFiles = [];
            let addedCount = 0;

            for (const file of files) {
                try {
                    const result = await addArticle(file);
                    if (result && result.status === "skipped") {
                        skippedFiles.push(result.fileName);
                    } else if (result && result.status === "success") {
                        addedCount++;
                    }
                } catch (addError) {
                    logError("Error adding file:", file.name, addError);
                    errorFiles.push(`${file.name}: ${addError.message}`);
                }
            }

            if (addedCount > 0) {
                dispatchMaestroEvent(MaestroEvent.articlesAdded, { publicationId: publication.$id });
            }

            if (skippedFiles.length > 0 || errorFiles.length > 0) {
                let message = "";

                if (skippedFiles.length > 0) {
                    message += `A következő fájlok már léteznek a .maestro mappában, ezért nem lettek hozzáadva:\n${skippedFiles.join("\n")}\n\n`;
                }

                if (errorFiles.length > 0) {
                    message += `Hibák történtek a következő fájloknál:\n${errorFiles.join("\n")}`;
                }

                setDialogConfig({
                    title: "Hozzáadás eredménye",
                    message: message.trim(),
                    isAlert: true
                });
                setDialogOpen(true);
            }

            if (!isExpanded) onToggle?.();
        } catch (e) {
            logError("Error selecting files:", e);
            setDialogConfig({
                title: "Hiba",
                message: "Nem sikerült megnyitni a fájlválasztót: " + e.message,
                isAlert: true
            });
            setDialogOpen(true);
        }
    }, [addArticle, isExpanded, onToggle]);

    const deletePublication = useCallback((e) => {
        e.stopPropagation();
        onDelete?.(publication.$id, publication.name);
    }, [onDelete, publication]);

    return (
        <div
            style={{
                display: "flex",
                flexDirection: "column",
                flex: isExpanded ? "1" : "0 0 auto",
                minHeight: "0",
                overflow: "visible",
                position: "relative",
                marginBottom: "12px"
            }}
        >
            {/* Publikáció fejléc sor */}
            <div
                style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    overflow: "hidden",
                    flexShrink: 0,
                    position: "relative"
                }}
                onMouseEnter={() => setIsHovered(true)}
                onMouseLeave={() => setIsHovered(false)}
            >
                <div style={{ display: "flex", alignItems: "center" }}>
                    <div onClick={handleChevronClick} style={{
                        cursor: "pointer", display: "flex", alignItems: "center", marginRight: "8px",
                        color: isDriveAccessible ? "var(--spectrum-global-color-blue-400)" : "var(--spectrum-global-color-red-400)"
                    }}>
                        <sp-body style={{ margin: 0, color: isDriveAccessible ? "var(--spectrum-global-color-blue-400)" : "var(--spectrum-global-color-red-400)" }}>
                            {isExpanded ?
                                <sp-icon-chevron-down size="s" style={{ width: "14px", height: "14px", display: "inline-block", verticalAlign: "middle" }}></sp-icon-chevron-down> :
                                <sp-icon-chevron-right size="s" style={{ width: "14px", height: "14px", display: "inline-block", verticalAlign: "middle" }}></sp-icon-chevron-right>
                            }
                        </sp-body>
                    </div>
                    <sp-heading size="xxs"
                        onDoubleClick={handlePublicationDoubleClick}
                        style={{
                            cursor: canOpenPublicationProperties ? "pointer" : "default",
                            margin: 0,
                            color: isDriveAccessible ? "var(--spectrum-global-color-blue-400)" : "var(--spectrum-global-color-red-400)"
                        }}>
                        {publication.name?.toUpperCase()}
                    </sp-heading>
                </div>

                {(isHovered || isFilterActive) && (
                    <sp-body style={{ margin: 0 }}>
                        <div style={{ display: "flex", alignItems: "center" }}>
                            {isHovered && (
                                <>
                                    <div
                                        onClick={handleAddArticleClick}
                                        title="Cikk hozzáadása"
                                        style={{ cursor: "pointer", display: "flex", alignItems: "center" }}
                                    >
                                        <sp-icon-add
                                            size="s"
                                            style={{ width: "14px", height: "14px", display: "inline-block" }}
                                        ></sp-icon-add>
                                    </div>

                                    <div
                                        onClick={deletePublication}
                                        title="Kiadvány törlése"
                                        style={{ cursor: "pointer", display: "flex", alignItems: "center", marginLeft: "8px" }}
                                    >
                                        <sp-icon-delete
                                            size="s"
                                            style={{ width: "14px", height: "14px", display: "inline-block" }}
                                        ></sp-icon-delete>
                                    </div>
                                </>
                            )}
                            <div
                                onClick={handleFilterClick}
                                title="Szűrés"
                                style={{
                                    display: "flex",
                                    alignItems: "center",
                                    justifyContent: "center",
                                    cursor: "pointer",
                                    marginLeft: "8px",
                                    color: isFilterActive ? "var(--spectrum-global-color-static-blue-600)" : "inherit"
                                }}
                            >
                                <sp-icon-filter
                                    size="s"
                                    style={{ width: "14px", height: "14px", display: "inline-block" }}
                                ></sp-icon-filter>
                            </div>
                        </div>
                    </sp-body>
                )}
            </div>

            {
                isExpanded && !isDriveAccessible && (
                    <div style={{
                        backgroundColor: "var(--spectrum-global-color-red-400)",
                        color: "white",
                        padding: "8px 12px 18px 12px",
                        borderRadius: "4px",
                        marginTop: "8px",
                        marginBottom: "4px",
                        display: "flex",
                        alignItems: "flex-start"
                    }}>
                        <div style={{ flexShrink: 0, marginRight: "8px", marginTop: "1px", display: "flex", alignItems: "center" }}>
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                                <circle cx="12" cy="12" r="10" fill="white" fillOpacity="0.3" />
                                <path d="M12 8v5" stroke="white" strokeWidth="2" strokeLinecap="round" />
                                <circle cx="12" cy="16" r="1.2" fill="white" />
                            </svg>
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: "12px", fontWeight: "bold", marginBottom: "2px" }}>
                                A kiadvány mappája nem érhető el
                            </div>
                            <div style={{ fontSize: "11px", opacity: 0.85 }}>
                                Ellenőrizd, hogy a mappa létezik-e, és a szükséges meghajtó csatlakoztatva van-e. Az ellenőrzés automatikusan fut.
                            </div>
                        </div>
                    </div>
                )
            }

            {/* Inline szűrősáv */}
            {
                filterOpen && isExpanded && (
                    <FilterBar
                        statusFilters={statusFilters}
                        onStatusFiltersChange={handleStatusFiltersChange}
                        showIgnored={showIgnored}
                        onShowIgnoredChange={handleShowIgnoredChange}
                        showOnlyMine={showOnlyMine}
                        onShowOnlyMineChange={handleShowOnlyMineChange}
                        showPlaceholders={showPlaceholders}
                        onShowPlaceholdersChange={handleShowPlaceholdersChange}
                        isFilterActive={isFilterActive}
                        onReset={resetFilters}
                    />
                )
            }

            {
                isExpanded && (
                    <ArticleTable
                        articles={tableData}
                        publication={publication}
                        onOpen={handleOpenArticle}
                        onShowProperties={(article, type) => onShowProperties?.(article, type, publication)}
                    />
                )
            }

            <ConfirmDialog
                isOpen={dialogOpen}
                title={dialogConfig.title}
                message={dialogConfig.message}
                isAlert={dialogConfig.isAlert}
                onConfirm={() => setDialogOpen(false)}
                onCancel={() => setDialogOpen(false)}
            />
        </div >
    );
});
