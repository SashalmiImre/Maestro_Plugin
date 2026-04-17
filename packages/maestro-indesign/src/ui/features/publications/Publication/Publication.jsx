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
import { toCanonicalPath, isUnderMountPrefix, currentMountPrefix } from "../../../../core/utils/pathUtils.js";
import { callSetPublicationRootPathCF } from "../../../../core/utils/updatePublicationClient.js";
import { PermissionDeniedError, isNetworkError } from "../../../../core/utils/errorUtils.js";

export const Publication = React.memo(({ publication, onShowProperties, onOpenInDashboard, isExpanded, onToggle, isConfigured, isDriveAccessible, filterState }) => {
    // Két blokkoló ok egyesítve a fejléc színezéshez és a cikk-művelet tiltáshoz.
    // Szemantikailag különbözőek — a banner-ek külön ágon jelennek meg:
    //   - !isConfigured  → narancs „Konfiguráció szükséges" (rootPath még nincs beállítva, #33)
    //   - !isDriveAccessible → piros „mappa nem érhető el" (rootPath be van állítva, de nem elérhető)
    const isBlocked = !isConfigured || !isDriveAccessible;
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

    // rootPath beállítás flow — külön confirm dialog a véglegesítéshez.
    // `pendingRootPath` null, ha nincs nyitott confirm; { nativePath, canonical }, ha van.
    const [pendingRootPath, setPendingRootPath] = useState(null);
    const [isSavingRootPath, setIsSavingRootPath] = useState(false);
    const isSavingRootPathRef = useRef(false);
    const [isRootPathButtonFocused, setIsRootPathButtonFocused] = useState(false);

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

    /** Helykitöltő sorok: a kiadvány terjedelmén belüli lefedetlen oldalcsoportok.
     *  Unconfigured pub-nál üres — a „Konfiguráció szükséges" banner mellé egy teljes
     *  flatplan-placeholder tábla ellentmondana. */
    const placeholderRows = useMemo(() => {
        if (!isConfigured) return [];
        return buildPlaceholderRows(articles, publication, workflow);
    }, [articles, publication, workflow, isConfigured]);

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
        // Védelmi guard: blokkolt állapotban (nincs rootPath VAGY mappa nem elérhető) az
        // openArticle `toAbsoluteArticlePath(filePath, null)` hívása hibás útvonalat adna,
        // az `app.open()` elbukna. A + gomb disabled, de legacy cikkek dupla kattintása
        // ide fut — ezért explicit dialog a valódi okkal.
        if (isBlocked) {
            setDialogConfig({
                title: !isConfigured ? "Konfiguráció szükséges" : "A mappa nem érhető el",
                message: !isConfigured
                    ? "A kiadvány gyökérmappája még nincs beállítva — a cikk nem nyitható meg."
                    : "A kiadvány mappája nem érhető el. Ellenőrizd a meghajtó csatlakoztatását.",
                isAlert: true
            });
            setDialogOpen(true);
            return;
        }
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
    }, [openArticle, user, isBlocked, isConfigured]);

    const handleAddArticleClick = useCallback(async (e) => {
        e?.stopPropagation?.();
        // Védelmi guard: ha a kiadvány blokkolt (nincs rootPath VAGY mappa nem elérhető),
        // a fájl-írás (saveACopy) elbukna — a UI-n a gomb disabled, de a billentyűzet-handler
        // is ide fut, ezért itt is szűrünk.
        if (isBlocked) return;
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
    }, [addArticle, isExpanded, onToggle, isBlocked, publication.$id]);

    // rootPath beállítás trigger (narancs bannerből): folder picker → mount-prefix check → confirm dialog.
    // A tényleges CF hívás a `confirmSetRootPath`-ban fut.
    const handleSetRootPathClick = useCallback(async () => {
        if (isSavingRootPathRef.current) return;
        try {
            const fs = require("uxp").storage.localFileSystem;
            const folder = await fs.getFolder();
            if (!folder) return; // user cancel

            const nativePath = folder.nativePath;
            if (!nativePath) {
                setDialogConfig({
                    title: "Érvénytelen mappa",
                    message: "A kiválasztott mappa útvonala nem olvasható.",
                    isAlert: true
                });
                setDialogOpen(true);
                return;
            }

            if (!isUnderMountPrefix(nativePath)) {
                const prefix = currentMountPrefix();
                setDialogConfig({
                    title: "Nem megosztott meghajtó",
                    message: `A gyökérmappának megosztott meghajtón kell lennie (${prefix}/... alatt). Kérd az IT-t a megosztás beállítására, vagy válassz másik mappát.`,
                    isAlert: true
                });
                setDialogOpen(true);
                return;
            }

            const canonical = toCanonicalPath(nativePath);
            setPendingRootPath({ nativePath, canonical });
        } catch (err) {
            logError("[Publication] rootPath folder pick error:", err);
            setDialogConfig({
                title: "Hiba",
                message: "Nem sikerült megnyitni a mappa-választót: " + err.message,
                isAlert: true
            });
            setDialogOpen(true);
        }
    }, []);

    const cancelSetRootPath = useCallback(() => {
        if (isSavingRootPathRef.current) return; // ne engedjük bezárni CF közben
        setPendingRootPath(null);
    }, []);

    const confirmSetRootPath = useCallback(async () => {
        if (isSavingRootPathRef.current) return;
        if (!pendingRootPath) return;

        isSavingRootPathRef.current = true;
        setIsSavingRootPath(true);
        try {
            await callSetPublicationRootPathCF(publication.$id, pendingRootPath.canonical);
            // Siker — Realtime hozza a publication.rootPath frissítést, a banner (és benne a gomb) automatikusan eltűnik.
            // Ha a Realtime késik vagy megszakadt, a dupla-klikk védelem úgyis a szerver CF-be ütközik
            // (`root_path_already_set` → barátságos dialog), nem hagyjuk a usert permanensen disabled gombbal.
            setPendingRootPath(null);
        } catch (err) {
            logError("[Publication] set-publication-root-path CF error:", err);
            setPendingRootPath(null);

            let title = "Hiba";
            let message = "";
            if (err instanceof PermissionDeniedError) {
                title = "Nincs jogosultság";
                message = "Nincs jogosultságod a gyökérmappa beállításához. Szólj a szerkesztőség adminjának vagy a szervezet tulajdonosának.";
            } else if (err.cfReason === 'root_path_already_set') {
                title = "Már beállítva";
                message = "Ezt a gyökérmappát már beállították (valószínűleg egy másik felhasználó). Az oldal automatikusan frissül.";
            } else if (err.cfReason === 'invalid_root_path') {
                title = "Érvénytelen útvonal";
                message = "A kiválasztott útvonal nem elfogadható. Válassz másik mappát.";
            } else if (err.cfReason === 'publication_not_found') {
                title = "Kiadvány nem található";
                message = "A kiadvány időközben törölve lett.";
            } else if (isNetworkError(err)) {
                title = "Hálózati hiba";
                message = "A beállítás nem mentődött el — próbáld újra.";
            } else {
                message = "Váratlan hiba: " + (err.message || "ismeretlen");
            }
            setDialogConfig({ title, message, isAlert: true });
            setDialogOpen(true);
        } finally {
            // Minden terminal ágon engedjük el a zárat. Ha Realtime még nem konvergált, a gomb
            // még látszik egy pillanatig — dupla-klikk esetén a szerver `root_path_already_set`
            // dialoggal tér vissza, ami barátságosabb, mint permanensen disabled állapot.
            isSavingRootPathRef.current = false;
            setIsSavingRootPath(false);
        }
    }, [pendingRootPath, publication.$id]);

    // Fejléc szín: kék (OK), narancs (konfiguráció szükséges), piros (mappa nem elérhető).
    // Egy helyen dől el — alább három JSX pontnál ugyanezt az értéket használjuk.
    const headerColor = !isBlocked
        ? "var(--spectrum-global-color-blue-400)"
        : (!isConfigured
            ? "var(--spectrum-global-color-orange-500)"
            : "var(--spectrum-global-color-red-400)");

    const addArticleTooltip = !isConfigured
        ? "A kiadvány gyökérmappája még nincs beállítva — cikkfelvétel jelenleg nem lehetséges"
        : (!isDriveAccessible
            ? "A kiadvány mappája nem elérhető — a cikkfelvétel most nem lehetséges"
            : "Cikk hozzáadása");

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
                        color: headerColor
                    }}>
                        <sp-body style={{ margin: 0, color: headerColor }}>
                            {isExpanded ?
                                <sp-icon-chevron-down size="s" style={{ width: "14px", height: "14px", display: "inline-block", verticalAlign: "middle" }}></sp-icon-chevron-down> :
                                <sp-icon-chevron-right size="s" style={{ width: "14px", height: "14px", display: "inline-block", verticalAlign: "middle" }}></sp-icon-chevron-right>
                            }
                        </sp-body>
                    </div>
                    <sp-heading size="xxs"
                        onDoubleClick={handlePublicationDoubleClick}
                        title="Dupla kattintás: megnyitás a Dashboardon"
                        style={{ cursor: "pointer", margin: 0, color: headerColor }}>
                        {publication.name?.toUpperCase()}
                    </sp-heading>
                </div>

                {(isHovered || isFocused) && (
                    <div style={{ display: "flex", alignItems: "center" }}>
                        <div
                            role="button"
                            tabIndex={isBlocked ? -1 : 0}
                            aria-disabled={isBlocked}
                            onClick={isBlocked ? undefined : handleAddArticleClick}
                            onKeyDown={(e) => {
                                if (isBlocked) return;
                                if (e.key === "Enter" || e.key === " ") {
                                    e.preventDefault();
                                    handleAddArticleClick();
                                }
                            }}
                            aria-label="Cikk hozzáadása"
                            title={addArticleTooltip}
                            style={{
                                cursor: isBlocked ? "not-allowed" : "pointer",
                                display: "flex",
                                alignItems: "center",
                                padding: "2px",
                                opacity: isBlocked ? 0.4 : 1,
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
                isExpanded && !isConfigured && (
                    <div style={{
                        backgroundColor: "var(--spectrum-global-color-orange-500)",
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
                                Konfiguráció szükséges
                            </div>
                            <div style={{ fontSize: "11px", opacity: 0.85, marginBottom: "8px" }}>
                                A kiadvány gyökérmappája még nincs beállítva. A beállításig cikkfelvétel és -megnyitás nem lehetséges.
                            </div>
                            <button
                                type="button"
                                onClick={handleSetRootPathClick}
                                disabled={isSavingRootPath}
                                onFocus={() => setIsRootPathButtonFocused(true)}
                                onBlur={() => setIsRootPathButtonFocused(false)}
                                style={{
                                    background: "white",
                                    color: "var(--spectrum-global-color-orange-600)",
                                    border: "none",
                                    borderRadius: "3px",
                                    padding: "4px 12px",
                                    fontSize: "11px",
                                    fontWeight: "bold",
                                    cursor: isSavingRootPath ? "default" : "pointer",
                                    opacity: isSavingRootPath ? 0.6 : 1,
                                    outline: isRootPathButtonFocused ? "2px solid white" : "none",
                                    outlineOffset: isRootPathButtonFocused ? "2px" : "0"
                                }}
                            >
                                {isSavingRootPath ? "Mentés…" : "Gyökérmappa beállítása"}
                            </button>
                        </div>
                    </div>
                )
            }

            {
                isExpanded && isConfigured && !isDriveAccessible && (
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

            <ConfirmDialog
                isOpen={!!pendingRootPath}
                title="Gyökérmappa beállítása"
                message={pendingRootPath ? (
                    `A(z) „${publication.name}" kiadvány gyökérmappája:\n\n` +
                    `Kiválasztott: ${pendingRootPath.nativePath}\n` +
                    `Kanonikus:    ${pendingRootPath.canonical}\n\n` +
                    `FIGYELEM: a beállítás után a gyökérmappa nem módosítható. Csak akkor erősítsd meg, ha biztos vagy benne.`
                ) : ""}
                confirmLabel={isSavingRootPath ? "Mentés…" : "Beállítás"}
                onConfirm={confirmSetRootPath}
                onCancel={cancelSetRootPath}
            />
        </div >
    );
});
