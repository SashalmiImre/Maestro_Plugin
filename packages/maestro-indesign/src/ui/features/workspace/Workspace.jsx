/**
 * @file Workspace.jsx
 * @description A Maestro Plugin fő munkaterülete.
 *
 * Ez a modul felel a két fő nézet (lista és cikk tulajdonságok) közötti váltásért,
 * valamint a kiválasztott cikk állapotának kezeléséért. Publikáció-szintű szerkesztés
 * a Dashboard hatáskörébe tartozik (Fázis 9) — a plugin csak a „Megnyitás Dashboardon"
 * deeplinket biztosítja publikációkra.
 */

// React
import React, { useState, useCallback, useMemo, useEffect } from "react";

// Components
import { PublicationList } from "../publications/PublicationList.jsx";
import { PropertiesPanel } from "./PropertiesPanel/PropertiesPanel.jsx";
import { FilterBar } from "./FilterBar.jsx";
import { WorkspaceHeader } from "./WorkspaceHeader.jsx";
import { ConfirmDialog } from "../../common/ConfirmDialog.jsx";

// Contexts & Custom Hooks
import { useToast } from "../../common/Toast/ToastContext.jsx";
import { useUser } from "../../../core/contexts/UserContext.jsx";
import { useScope } from "../../../core/contexts/ScopeContext.jsx";
import { useData } from "../../../core/contexts/DataContext.jsx";
import { useWorkflowValidation } from "../../../data/hooks/useWorkflowValidation.js";
import { useThumbnails } from "../../../data/hooks/useThumbnails.js";
import { useFilters } from "../../../data/hooks/useFilters.js";
import { usePublicationArchive } from "../../../data/hooks/usePublicationArchive.js";

// Konfiguráció & Konstansok
import { account, DASHBOARD_URL } from "../../../core/config/appwriteConfig.js";

// Utils
import { toAbsoluteArticlePath, toNativePath } from "../../../core/utils/pathUtils.js";
import { generateOpenDocumentScript } from "../../../core/utils/indesign/index.js";
import { logWarn, logError } from "../../../core/utils/logger.js";
import { SCRIPT_LANGUAGE_JAVASCRIPT, TOAST_TYPES } from "../../../core/utils/constants.js";

/** Hibaüzenet: a cikkhez nem tartozik fájl útvonal */
const NO_FILE_PATH_ERROR = {
    title: 'A dokumentum nem nyitható meg',
    description: 'A cikkhez nem tartozik fájl útvonal. Ellenőrizd a cikk beállításait.'
};

/**
 * Workspace (Munkaterület) Komponens
 * 
 * Ez a fő komponens kezeli a navigációt a lista és a tulajdonságok nézet között.
 * Kezeli a cikk/kiadvány kiválasztást és biztosítja a valós idejű (realtime)
 * frissítéseket a kiválasztott elemekhez.
 * 
 * @returns {JSX.Element} A fő munkaterület komponens
 */
export const Workspace = () => {
    const { user, organizations, editorialOffices } = useUser();
    const { activeOrganizationId, activeEditorialOfficeId, setActiveOrganization, setActiveOffice } = useScope();
    const { showToast } = useToast();
    const { runAndPersistPreflight } = useWorkflowValidation();
    useThumbnails();
    const { canArchivePublication, isArchiving, archiveProgress, archivePublication } = usePublicationArchive();
    const [archiveDialogOpen, setArchiveDialogOpen] = useState(false);
    const handleOpenArchiveDialog = useCallback(() => setArchiveDialogOpen(true), []);

    // Scope dropdown adatok — az aktív orghoz tartozó szerkesztőségek
    const scopedOffices = useMemo(
        () => (editorialOffices || []).filter(o => o.organizationId === activeOrganizationId),
        [editorialOffices, activeOrganizationId]
    );


    // Központi szűrő állapot (minden kiadványra egységesen alkalmazva)
    const {
        filterOpen, toggleFilterOpen,
        statusFilters, showIgnored, showOnlyMine, showPlaceholders,
        isFilterActive,
        handleStatusFiltersChange, handleShowIgnoredChange,
        handleShowOnlyMineChange, handleShowPlaceholdersChange,
        resetFilters
    } = useFilters();

    /** Memoizált filterState prop — Publication React.memo invalidáció elkerülése */
    const filterState = useMemo(() => ({
        statusFilters, showIgnored, showOnlyMine, showPlaceholders, isFilterActive
    }), [statusFilters, showIgnored, showOnlyMine, showPlaceholders, isFilterActive]);

    // Központi adatok elérése a DataContext-ből
    // Az articles lista automatikusan frissül a Realtime események alapján
    const { publications, articles, setActivePublicationId, activePublicationId } = useData();

    // Navigációs állapot: 'list' (lista) vagy 'properties' (tulajdonságok)
    const [currentView, setCurrentView] = useState('list');

    // Kiválasztott cikk ID-ja — a cikk objektumot a DataContext-ből származtatjuk.
    // A plugin csak cikkeket jelenít meg Properties nézetben (Fázis 9 — a publikáció
    // szerkesztés a Dashboard hatáskörébe került).
    const [selectedItemId, setSelectedItemId] = useState(null);
    const [selectedParentPublicationId, setSelectedParentPublicationId] = useState(null);

    /**
     * Kiválasztott cikk származtatása a DataContext-ből.
     * A useMemo automatikusan újraszámolja, ha az articles tömb vagy az ID változik.
     * Ez biztosítja, hogy a Realtime frissítések azonnal megjelenjenek.
     */
    const selectedItem = useMemo(() => {
        if (!selectedItemId) return null;
        return articles.find(a => a.$id === selectedItemId) || null;
    }, [articles, selectedItemId]);

    const selectedParentPublication = useMemo(() => {
        if (!selectedParentPublicationId) return null;
        return publications.find(p => p.$id === selectedParentPublicationId) || null;
    }, [publications, selectedParentPublicationId]);

    /**
     * Navigálás a tulajdonságok nézetre (jobb oldali cikk panel).
     *
     * @param {Object} article - A kiválasztott cikk objektum
     * @param {Object} publication - A cikk szülő publikációja (aktív publikációnak állítódik)
     */
    const handleShowProperties = (article, publication) => {
        setSelectedItemId(article.$id);
        setSelectedParentPublicationId(publication?.$id || null);
        setCurrentView('properties');
        if (publication?.$id) {
            setActivePublicationId(publication.$id);
        }
    };

    /**
     * Visszanavigálás a lista nézetre
     * Megőrzi a PublicationList állapotát (pl. mely kiadványok vannak lenyitva)
     */
    const handleBackToList = useCallback(() => {
        setCurrentView('list');
        setSelectedItemId(null);
        setSelectedParentPublicationId(null);
    }, []);

    /**
     * Dashboard megnyitása böngészőben JWT auto-login-nal.
     * Létrehoz egy 15 perces JWT tokent, majd a böngészőben megnyitja a dashboard URL-t
     * a `?pub=<id>` query paraméterrel és a JWT-vel fragment-ben.
     *
     * @param {string} [pubId] - Opcionális publikáció ID; ha hiányzik, az aktív publikációra nyit.
     */
    const handleOpenDashboard = useCallback(async (pubId) => {
        const targetPubId = pubId || activePublicationId || '';
        const buildUrl = (jwt) => {
            let url = DASHBOARD_URL;
            if (targetPubId) {
                url += `?pub=${encodeURIComponent(targetPubId)}`;
            }
            if (jwt) {
                // JWT fragment-ben (#) utazik, nem query paraméterben — így nem kerül szerver logba
                url += `#jwt=${encodeURIComponent(jwt)}`;
            }
            return url;
        };

        try {
            const { jwt } = await account.createJWT();
            require('uxp').shell.openExternal(buildUrl(jwt));
        } catch (error) {
            logError('[Workspace] Dashboard megnyitás sikertelen:', error);
            // Fallback: JWT nélkül is megnyitjuk a dashboardot
            try {
                require('uxp').shell.openExternal(buildUrl(null));
            } catch (fallbackError) {
                logError('[Workspace] Böngésző megnyitása sikertelen:', fallbackError);
                showToast('A böngésző nem nyitható meg', TOAST_TYPES.ERROR);
            }
        }
    }, [showToast, activePublicationId]);

    /**
     * Cikk fájl megnyitása InDesign-ban
     * 
     * Ellenőrzi a zárolási státuszt megnyitás előtt.
     * Megpróbálja először a szabványos `app.open`-t, de ha az nem sikerül,
     * vagy speciális beállítások kellenek (pl. warningok elnyomása),
     * akkor ExtendScript fallback-et használ.
     * 
     * @param {Object} article - A megnyitandó cikk objektum
     */
    const handleOpenArticle = useCallback(async (article) => {
        try {
            // Zárolás ellenőrzése
            if (article.lockOwnerId && article.lockOwnerId !== user.$id) {
                showToast('A dokumentum zárolva van', TOAST_TYPES.WARNING, 'Ezt a fájlt jelenleg más felhasználó szerkeszti. Próbáld meg később.');
                return;
            }

            const app = require("indesign").app;

            if (!article.filePath) {
                logError("No file path for article:", article.name);
                showToast(NO_FILE_PATH_ERROR.title, TOAST_TYPES.ERROR, NO_FILE_PATH_ERROR.description);
                return;
            }

            // Relatív filePath → abszolút natív útvonal (a kiadvány rootPath-ja alapján)
            const pub = publications.find(p => p.$id === article.publicationId);
            const mappedPath = pub ? toAbsoluteArticlePath(article.filePath, pub.rootPath) : toNativePath(article.filePath);

            if (mappedPath) {
                try {
                    await app.open(mappedPath);
                    showToast(`${article.name} megnyitva`, TOAST_TYPES.SUCCESS);
                } catch (openError) {
                    logWarn("Standard app.open failed, trying ExtendScript fallback...", openError);

                    const script = generateOpenDocumentScript(mappedPath);
                    const result = app.doScript(script, SCRIPT_LANGUAGE_JAVASCRIPT, []);
                    if (result !== "success") {
                        throw new Error("ExtendScript open failed: " + result);
                    }
                    showToast(`${article.name} megnyitva`, TOAST_TYPES.SUCCESS);
                }
            } else {
                logError("No file path for article");
                showToast(NO_FILE_PATH_ERROR.title, TOAST_TYPES.ERROR, NO_FILE_PATH_ERROR.description);
            }
        } catch (e) {
            logError("Failed to open article:", e);
            showToast('A dokumentum megnyitása sikertelen', TOAST_TYPES.ERROR, e.message || 'Ismeretlen hiba történt.');
        }
    }, [user, publications, showToast]);

    // A Realtime frissítéseket mostantól a DataContext kezeli központilag.
    // A selectedArticle automatikusan frissül az articles tömb változásakor (useMemo).

    /**
     * Távoli törlés kezelése.
     * Ha a tulajdonságok nézetben vagyunk, de a kiválasztott elem már nem létezik
     * (pl. valaki más törölte), akkor értesítjük a felhasználót és visszanavigálunk.
     */
    useEffect(() => {
        if (currentView === 'properties' && selectedItemId && !selectedItem) {
            showToast('Az elem már nem létezik', TOAST_TYPES.WARNING, 'A kiválasztott elemet időközben valaki más törölhette.');
            handleBackToList();
        }
    }, [currentView, selectedItemId, selectedItem, showToast, handleBackToList]);

    return (
        <div style={{ position: 'relative', height: '100%', display: 'flex', flexDirection: 'column' }}>
            <WorkspaceHeader
                user={user}
                isFilterActive={isFilterActive}
                onToggleFilter={toggleFilterOpen}
                onOpenDashboard={handleOpenDashboard}
                isPropertiesView={currentView === 'properties'}
                canArchivePublication={canArchivePublication}
                isArchiving={isArchiving}
                archiveProgress={archiveProgress}
                onArchivePublication={handleOpenArchiveDialog}
                organizations={organizations}
                activeOrganizationId={activeOrganizationId}
                onOrganizationChange={setActiveOrganization}
                scopedOffices={scopedOffices}
                activeEditorialOfficeId={activeEditorialOfficeId}
                onOfficeChange={setActiveOffice}
            />

            {/* Központi szűrősáv — a fejléc alatt, minden kiadványra érvényes */}
            {filterOpen && currentView === 'list' && (
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
            )}

            {/* PublicationList - always rendered, hidden with visibility when viewing properties
                (display:none reseteli a scrollTop-ot, visibility:hidden megőrzi) */}
            <div style={{
                display: 'flex',
                flexDirection: 'column',
                height: '100%',
                ...(currentView !== 'list' && {
                    visibility: 'hidden',
                    position: 'absolute',
                    left: '-9999px',
                    top: 0,
                    width: '100%',
                    height: '100%'
                })
            }}>
                <PublicationList
                    onShowProperties={handleShowProperties}
                    onOpenInDashboard={handleOpenDashboard}
                    filterState={filterState}
                />
            </div>

            {currentView === 'properties' && selectedItem && (
                <PropertiesPanel
                    selectedItem={selectedItem}
                    publication={selectedParentPublication}
                    onBack={handleBackToList}
                    onOpen={handleOpenArticle}
                    runAndPersistPreflight={runAndPersistPreflight}
                />
            )}

            <ConfirmDialog
                isOpen={archiveDialogOpen}
                title="Teljes kiadvány archiválása"
                message="Az összes cikk archiválásra kerül (szövegkinyerés, INDD másolás, PDF export). Ez a művelet nem vonható vissza. Biztosan folytatod?"
                onConfirm={() => { setArchiveDialogOpen(false); archivePublication(); }}
                onCancel={() => setArchiveDialogOpen(false)}
            />
        </div>
    );
};
