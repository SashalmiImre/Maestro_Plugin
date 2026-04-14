// React
import React, { useState, useCallback, useMemo, useRef, useEffect } from "react";

// Components
import { ArticleTable } from "../../articles/ArticleTable.jsx";
import { ConfirmDialog } from "../../../common/ConfirmDialog.jsx";

// Custom Hooks
import { useArticles } from "../../../../data/hooks/useArticles.js";
import { useUser } from "../../../../core/contexts/UserContext.jsx";
import { useData } from "../../../../core/contexts/DataContext.jsx";

// Utils
import { MARKERS } from "maestro-shared/constants.js";
import { logDebug, logError } from "../../../../core/utils/logger.js";
import { MaestroEvent, dispatchMaestroEvent } from "../../../../core/config/maestroEvents.js";
import { buildPlaceholderRows } from "../../../../core/utils/pageGapUtils.js";
import { isContributor } from "maestro-shared/contributorHelpers.js";

export const Publication = React.memo(({ publication, onShowProperties, onOpenInDashboard, isExpanded, onToggle, isDriveAccessible, filterState }) => {
    const { user } = useUser();
    const { workflow } = useData();
    const {
        articles,
        addArticle,
        openArticle
    } = useArticles(publication.$id, publication.rootPath);

    const [isHovered, setIsHovered] = useState(false);
    const [isFocused, setIsFocused] = useState(false);

    // Dialog state
    const [dialogOpen, setDialogOpen] = useState(false);
    const [dialogConfig, setDialogConfig] = useState({ title: "", message: "", isAlert: false });

    // Szűrő állapot a központi filterState prop-ból
    const { statusFilters, showIgnored, showOnlyMine, showPlaceholders } = filterState;

    const userGroupSlugs = user?.groupSlugs || [];

    const filteredArticles = React.useMemo(() => {
        const filtered = articles.filter(article => {
            const statusMatch = statusFilters.includes(article.state || "");
            const articleMarkers = typeof article.markers === 'number' ? article.markers : 0;
            const markerMatch = showIgnored || (articleMarkers & MARKERS.IGNORE) === 0;
            const ownerMatch = !showOnlyMine || isContributor(article.contributors, user?.$id, userGroupSlugs);

            return statusMatch && markerMatch && ownerMatch;
        });

        logDebug(`[Publication] Articles stats: Total fetched: ${articles.length}, Shown: ${filtered.length}. Filtered out: ${articles.length - filtered.length}`);
        return filtered;
    }, [articles, statusFilters, showIgnored, showOnlyMine, userGroupSlugs, user?.$id]);

    /** Helykitöltő sorok: a kiadvány terjedelmén belüli lefedetlen oldalcsoportok */
    const placeholderRows = useMemo(() => {
        return buildPlaceholderRows(articles, publication, workflow);
    }, [articles, publication, workflow]);

    /** Táblázat adatai: szűrt cikkek + opcionálisan helykitöltők */
    const tableData = useMemo(() => {
        if (showOnlyMine || !showPlaceholders) return filteredArticles;
        return [...filteredArticles, ...placeholderRows];
    }, [filteredArticles, placeholderRows, showPlaceholders, showOnlyMine]);

    // Dupla Dashboard open guard: fejléc dupla kattintás + hover ikon gyors egymás utáni
    // triggerelése két JWT lekérést és két tab-nyitást eredményezne. 1s-os ref-alapú zár
    // (ref, nem state — nincs render impact) egyetlen hívásra szűkíti.
    const isOpeningDashboardRef = useRef(false);
    const openDashboardTimerRef = useRef(null);

    useEffect(() => {
        return () => {
            if (openDashboardTimerRef.current) {
                clearTimeout(openDashboardTimerRef.current);
                openDashboardTimerRef.current = null;
            }
        };
    }, []);

    const triggerOpenInDashboard = useCallback(() => {
        if (isOpeningDashboardRef.current) return;
        isOpeningDashboardRef.current = true;
        onOpenInDashboard?.(publication.$id);
        openDashboardTimerRef.current = setTimeout(() => {
            isOpeningDashboardRef.current = false;
            openDashboardTimerRef.current = null;
        }, 1000);
    }, [onOpenInDashboard, publication.$id]);

    const handlePublicationDoubleClick = useCallback((e) => {
        e.stopPropagation();
        triggerOpenInDashboard();
    }, [triggerOpenInDashboard]);

    const handleOpenInDashboardClick = useCallback((e) => {
        e.stopPropagation();
        triggerOpenInDashboard();
    }, [triggerOpenInDashboard]);

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
        e?.stopPropagation?.();
        // Védelmi guard: ha a mappa nem elérhető, a fájl-írás (saveACopy) elbukna —
        // a UI-n a gomb disabled, de a billentyűzet-handler is ide fut, ezért itt is szűrünk.
        if (!isDriveAccessible) return;
        try {
            const fs = require("uxp").storage.localFileSystem;
            const files = await fs.getFileForOpening({
                types: ["indd"],
                allowMultiple: true
            });

            if (!files || files.length === 0) return;

            let skippedFiles = [];
            let errorFiles = [];
            let addedArticles = [];

            for (const file of files) {
                try {
                    const result = await addArticle(file);
                    if (result && result.status === "skipped") {
                        skippedFiles.push(result.fileName);
                    } else if (result && result.status === "success") {
                        if (result.article) addedArticles.push(result.article);
                    }
                } catch (addError) {
                    logError("Error adding file:", file.name, addError);
                    errorFiles.push(`${file.name}: ${addError.message}`);
                }
            }

            if (addedArticles.length > 0) {
                dispatchMaestroEvent(MaestroEvent.articlesAdded, {
                    publicationId: publication.$id,
                    articles: addedArticles
                });
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
        } catch (err) {
            logError("Error selecting files:", err);
            setDialogConfig({
                title: "Hiba",
                message: "Nem sikerült megnyitni a fájlválasztót: " + err.message,
                isAlert: true
            });
            setDialogOpen(true);
        }
    }, [addArticle, isExpanded, onToggle, isDriveAccessible, publication.$id]);

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
            {/* Publikáció fejléc sor — a toolbar hover VAGY focus-within állapotra jelenik meg,
                hogy billentyűzettel navigáló felhasználók is elérjék a műveleteket. */}
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
                onFocus={() => setIsFocused(true)}
                onBlur={(e) => {
                    // Csak akkor rejtjük el, ha a fókusz a fejléc sor doboza ELHAGYJA (nem belső mozgás)
                    if (!e.currentTarget.contains(e.relatedTarget)) setIsFocused(false);
                }}
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
                        title="Dupla kattintás: megnyitás a Dashboardon"
                        style={{
                            cursor: "pointer",
                            margin: 0,
                            color: isDriveAccessible ? "var(--spectrum-global-color-blue-400)" : "var(--spectrum-global-color-red-400)"
                        }}>
                        {publication.name?.toUpperCase()}
                    </sp-heading>
                </div>

                {(isHovered || isFocused) && (
                    <div style={{ display: "flex", alignItems: "center" }}>
                        <div
                            role="button"
                            tabIndex={isDriveAccessible ? 0 : -1}
                            aria-disabled={!isDriveAccessible}
                            onClick={isDriveAccessible ? handleAddArticleClick : undefined}
                            onKeyDown={(e) => {
                                if (!isDriveAccessible) return;
                                if (e.key === "Enter" || e.key === " ") {
                                    e.preventDefault();
                                    handleAddArticleClick();
                                }
                            }}
                            aria-label="Cikk hozzáadása"
                            title={isDriveAccessible ? "Cikk hozzáadása" : "A kiadvány mappája nem elérhető — a cikkfelvétel most nem lehetséges"}
                            style={{
                                cursor: isDriveAccessible ? "pointer" : "not-allowed",
                                display: "flex",
                                alignItems: "center",
                                padding: "2px",
                                opacity: isDriveAccessible ? 1 : 0.4,
                                color: "var(--spectrum-global-color-blue-400)"
                            }}
                        >
                            <sp-icon-add size="s" style={{ width: "14px", height: "14px", display: "inline-block", verticalAlign: "middle" }}></sp-icon-add>
                        </div>

                        <div
                            role="button"
                            tabIndex={0}
                            onClick={handleOpenInDashboardClick}
                            onKeyDown={(e) => {
                                if (e.key === "Enter" || e.key === " ") {
                                    e.preventDefault();
                                    handleOpenInDashboardClick();
                                }
                            }}
                            aria-label="Megnyitás a Dashboardon"
                            title="Megnyitás a Dashboardon"
                            style={{
                                cursor: "pointer",
                                display: "flex",
                                alignItems: "center",
                                padding: "2px",
                                marginLeft: "4px",
                                color: "var(--spectrum-global-color-blue-400)"
                            }}
                        >
                            <sp-icon-link-out size="s" style={{ width: "14px", height: "14px", display: "inline-block", verticalAlign: "middle" }}></sp-icon-link-out>
                        </div>
                    </div>
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

            {
                isExpanded && (
                    <ArticleTable
                        articles={tableData}
                        publication={publication}
                        onOpen={handleOpenArticle}
                        onShowProperties={(article) => onShowProperties?.(article, publication)}
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
