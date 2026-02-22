// React
import React, { useState, useCallback, useEffect } from "react";

// Components
import { ArticleTable } from "../../articles/ArticleTable.jsx";
import { ConfirmDialog } from "../../../common/ConfirmDialog.jsx";
import { FilterBar } from "./FilterBar.jsx";

// Custom Hooks
import { useArticles } from "../../../../data/hooks/useArticles.js";
import { useUser } from "../../../../core/contexts/UserContext.jsx";

// Utils
import { WORKFLOW_STATES, MARKERS } from "../../../../core/utils/workflow/workflowConstants.js";
import { log } from "../../../../core/utils/logger.js";
import { checkPathAccessible, resolvePlatformPath } from "../../../../core/utils/pathUtils.js";
import { MaestroEvent, dispatchMaestroEvent } from "../../../../core/config/maestroEvents.js";

export const Publication = React.memo(({ publication, onDelete, onRename, onShowProperties, isExpanded, onToggle }) => {
    const { user } = useUser();

    const {
        articles,
        fetchArticles,
        addArticle,
        openArticle
    } = useArticles(publication.$id, publication.rootPath);

    const [isHovered, setIsHovered] = useState(false);

    // Meghajtó elérhetőség ellenőrzése (rootPath)
    const [isDriveAccessible, setIsDriveAccessible] = useState(true);

    useEffect(() => {
        if (!isExpanded) return;

        let mounted = true;
        let isChecking = false;

        const checkAccess = async () => {
            if (isChecking) return;
            isChecking = true;
            try {
                const accessible = await checkPathAccessible(
                    resolvePlatformPath(publication.rootPath)
                );
                if (mounted) setIsDriveAccessible(accessible);
            } finally {
                isChecking = false;
            }
        };

        checkAccess();

        const handleFocus = () => checkAccess();
        window.addEventListener('focus', handleFocus);
        window.addEventListener(MaestroEvent.panelShown, handleFocus);
        window.addEventListener(MaestroEvent.dataRefreshRequested, handleFocus);
        return () => {
            mounted = false;
            window.removeEventListener('focus', handleFocus);
            window.removeEventListener(MaestroEvent.panelShown, handleFocus);
            window.removeEventListener(MaestroEvent.dataRefreshRequested, handleFocus);
        };
    }, [isExpanded, publication.rootPath]);

    // Dialog state
    const [dialogOpen, setDialogOpen] = useState(false);
    const [dialogConfig, setDialogConfig] = useState({ title: "", message: "", isAlert: false });

    // Filter state
    const [filterOpen, setFilterOpen] = useState(false);
    const [statusFilters, setStatusFilters] = useState(Object.values(WORKFLOW_STATES));
    const [showIgnored, setShowIgnored] = useState(true);

    const allStatuses = Object.values(WORKFLOW_STATES);
    const isFilterActive = statusFilters.length !== allStatuses.length || !showIgnored;

    const handleFilterClick = (e) => {
        e.stopPropagation();
        setFilterOpen(!filterOpen);
    };

    const resetFilters = () => {
        setStatusFilters(Object.values(WORKFLOW_STATES));
        setShowIgnored(true);
    };

    const filteredArticles = React.useMemo(() => {
        const filtered = articles.filter(article => {
            const statusMatch = statusFilters.includes(article.state || 0);
            const articleMarkers = typeof article.markers === 'number' ? article.markers : 0;
            const markerMatch = showIgnored || (articleMarkers & MARKERS.IGNORE) === 0;

            return statusMatch && markerMatch;
        });

        log(`[Publication] Articles stats: Total fetched: ${articles.length}, Shown: ${filtered.length}. Filtered out: ${articles.length - filtered.length}`);
        return filtered;
    }, [articles, statusFilters, showIgnored]);

    const handlePublicationDoubleClick = useCallback((e) => {
        e.stopPropagation();
        onShowProperties?.(publication, 'publication');
    }, [onShowProperties, publication]);

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
                    console.error("Error adding file:", file.name, addError);
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
            console.error("Error selecting files:", e);
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
                    <div onClick={handleChevronClick} style={{ cursor: "pointer", display: "flex", alignItems: "center", marginRight: "8px" }}>
                        <sp-body style={{ margin: 0 }}>
                            {isExpanded ?
                                <sp-icon-chevron-down size="s" style={{ width: "14px", height: "14px", display: "inline-block", verticalAlign: "middle" }}></sp-icon-chevron-down> :
                                <sp-icon-chevron-right size="s" style={{ width: "14px", height: "14px", display: "inline-block", verticalAlign: "middle" }}></sp-icon-chevron-right>
                            }
                        </sp-body>
                    </div>
                    <sp-body
                        onDoubleClick={handlePublicationDoubleClick}
                        style={{ cursor: "pointer", margin: 0 }}>
                        {publication.name?.toUpperCase()}
                    </sp-body>
                </div>

                {(isHovered || isFilterActive) && (
                    <sp-body style={{ margin: 0 }}>
                        <div style={{ display: "flex", alignItems: "center" }}>
                            <div
                                onClick={handleFilterClick}
                                title="Szűrés"
                                style={{
                                    display: "flex",
                                    alignItems: "center",
                                    justifyContent: "center",
                                    cursor: "pointer",
                                    color: isFilterActive ? "var(--spectrum-global-color-static-blue-600)" : "inherit"
                                }}
                            >
                                <sp-icon-filter
                                    size="s"
                                    style={{ width: "14px", height: "14px", display: "inline-block" }}
                                ></sp-icon-filter>
                            </div>
                            {isHovered && (
                                <>
                                    <div
                                        onClick={handleAddArticleClick}
                                        title="Cikk hozzáadása"
                                        style={{ cursor: "pointer", display: "flex", alignItems: "center", marginLeft: "8px" }}
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
                        </div>
                    </sp-body>
                )}
            </div>

            {/* Inline szűrősáv */}
            {
                filterOpen && isExpanded && (
                    <FilterBar
                        statusFilters={statusFilters}
                        onStatusFiltersChange={setStatusFilters}
                        showIgnored={showIgnored}
                        onShowIgnoredChange={setShowIgnored}
                        isFilterActive={isFilterActive}
                        onReset={resetFilters}
                    />
                )
            }

            {
                isExpanded && !isDriveAccessible && (
                    <div style={{
                        backgroundColor: "var(--spectrum-global-color-red-400)",
                        color: "white",
                        padding: "8px 12px",
                        borderRadius: "4px",
                        margin: "8px",
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
                        <div style={{ flex: 1 }}>
                            <div style={{ fontSize: "12px", fontWeight: "bold", marginBottom: "2px" }}>
                                A kiadvány mappája nem érhető el
                            </div>
                            <div style={{ fontSize: "11px", opacity: 0.9, marginBottom: "4px" }}>
                                {publication.rootPath}
                            </div>
                            <div style={{ fontSize: "11px", opacity: 0.85 }}>
                                Csatlakoztasd a szükséges meghajtót. Az ellenőrzés automatikusan újraindul, ha visszaváltasz erre az ablakra.
                            </div>
                        </div>
                    </div>
                )
            }

            {
                isExpanded && isDriveAccessible && (
                    <ArticleTable
                        articles={filteredArticles}
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
