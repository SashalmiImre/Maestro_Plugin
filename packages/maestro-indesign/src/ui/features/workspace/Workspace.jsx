/**
 * @file Workspace.jsx
 * @description A Maestro Plugin fő munkaterülete.
 * 
 * Ez a modul felel a két fő nézet (Lista és Tulajdonságok) közötti váltásért,
 * valamint a kiválasztott elemek (cikkek, kiadványok) állapotának kezeléséért.
 * 
 * ## Szinkronizáció és Cache Busting
 * 
 * A komponens egyik legkritikusabb feladata az adatok frissítése,
 * különösen "Alvás" (Sleep) után. Mivel a hálózati réteg (proxy/CDN) hajlamos
 * gyorsítótárazni a kéréseket, speciális "Cache Busting" technikát alkalmazunk:
 * 
 * `Query.notEqual("$id", "egyedi-időbélyeg")`
 * 
 * Ez garantálja, hogy minden frissítési kérés egyedi URL-t kapjon,
 * így kényszerítve a szervert a legfrissebb adatok küldésére.
 */

// React
import React, { useState, useCallback, useMemo, useEffect } from "react";

// Components
import { PublicationList } from "../publications/PublicationList.jsx";
import { PropertiesPanel } from "./PropertiesPanel/PropertiesPanel.jsx";

// Contexts & Custom Hooks
import { useToast } from "../../common/Toast/ToastContext.jsx";
import { useUser } from "../../../core/contexts/UserContext.jsx";
import { usePublications } from "../../../data/hooks/usePublications.js";
import { useData } from "../../../core/contexts/DataContext.jsx";
import { useWorkflowValidation } from "../../../data/hooks/useWorkflowValidation.js";

// Utils
import { resolvePlatformPath } from "../../../core/utils/pathUtils.js";
import { generateOpenDocumentScript } from "../../../core/utils/indesign/index.js";
import { log, logError } from "../../../core/utils/logger.js";
import { MaestroEvent, dispatchMaestroEvent } from "../../../core/config/maestroEvents.js";
import { SCRIPT_LANGUAGE_JAVASCRIPT } from "../../../core/utils/constants.js";

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
    const { user } = useUser();
    const { showToast } = useToast();
    const { updatePublication, publications } = usePublications();
    const { runAndPersistPreflight } = useWorkflowValidation();

    // Központi adatok elérése a DataContext-ből
    // Az articles lista automatikusan frissül a Realtime események alapján
    const { articles, setActivePublicationId, activePublicationId } = useData();

    // Navigációs állapot: 'list' (lista) vagy 'properties' (tulajdonságok)
    const [currentView, setCurrentView] = useState('list');

    // Kiválasztott elem típusa és ID-ja
    // Az adatokat a DataContext-ből származtatjuk, nem tárolunk teljes objektumot
    const [selectedItemId, setSelectedItemId] = useState(null);
    const [selectedType, setSelectedType] = useState(null);
    const [selectedPublication, setSelectedPublication] = useState(null);

    // Aktív publikáció szinkronizálás a DataContext-tel — csak properties nézetben.
    // Lista nézetben a PublicationList kezeli az activePublicationId-t (toggleExpansion).
    useEffect(() => {
        if (currentView !== 'properties') return;
        if (selectedPublication?.$id) {
            setActivePublicationId(selectedPublication.$id);
        } else if (selectedType === 'publication' && selectedItemId) {
            setActivePublicationId(selectedItemId);
        }
    }, [currentView, selectedPublication, selectedItemId, selectedType, setActivePublicationId]);

    /**
     * Kiválasztott cikk származtatása a DataContext-ből.
     * A useMemo automatikusan újraszámolja, ha az articles tömb vagy az ID változik.
     * Ez biztosítja, hogy a Realtime frissítések azonnal megjelenjenek.
     */
    const selectedArticle = useMemo(() => {
        if (!selectedItemId || selectedType !== 'article') return null;
        return articles.find(a => a.$id === selectedItemId) || null;
    }, [articles, selectedItemId, selectedType]);

    /**
     * Kiválasztott kiadvány származtatása a DataContext-ből.
     */
    const selectedPublicationData = useMemo(() => {
        if (!selectedItemId || selectedType !== 'publication') return null;
        return publications.find(p => p.$id === selectedItemId) || null;
    }, [publications, selectedItemId, selectedType]);

    /**
     * A kiválasztott elem (cikk vagy kiadvány) - típustól függően
     */
    const selectedItem = selectedType === 'article' ? selectedArticle : selectedPublicationData;

    /**
     * Navigálás a tulajdonságok nézetre (jobb oldali panel)
     * 
     * @param {Object} item - A kiválasztott kiadvány vagy cikk objektum
     * @param {string} type - A kiválasztott elem típusa ('publication' vagy 'article')
     * @param {Object} [publication] - A szülő kiadvány (cikkek esetén)
     */
    const handleShowProperties = (item, type, publication = null) => {
        setSelectedItemId(item.$id);
        setSelectedType(type);
        setSelectedPublication(publication);
        setCurrentView('properties');

        // Ha cikket nyitunk meg, a szülő publikáció lesz az aktív.
        // Ha kiadványt, akkor az maga.
        if (type === 'article' && publication) {
            setActivePublicationId(publication.$id);
        } else if (type === 'publication') {
            setActivePublicationId(item.$id);
        }
    };

    /**
     * Visszanavigálás a lista nézetre
     * Megőrzi a PublicationList állapotát (pl. mely kiadványok vannak lenyitva)
     */
    const handleBackToList = useCallback(() => {
        setCurrentView('list');
        setSelectedItemId(null);
        setSelectedType(null);
        setSelectedPublication(null);
    }, []);


    /**
     * Kiadvány mező frissítése (pl. coverage)
     * A DataContext automatikusan frissíti az adatokat.
     * @param {string} field - A mező neve
     * @param {*} value - Az új érték
     */
    const handlePublicationUpdate = useCallback(async (field, value) => {
        if (!selectedItem || selectedType !== 'publication') return;

        try {
            await updatePublication(selectedItem.$id, { [field]: value });
            showToast('Módosítás mentve', 'success');

            // Coverage változás esetén újravalidáljuk az összes cikket
            if (field === 'coverageStart' || field === 'coverageEnd') {
                dispatchMaestroEvent(MaestroEvent.publicationCoverageChanged, {
                    publication: { ...selectedItem, [field]: value }
                });
            }
        } catch (error) {
            logError('[Workspace] Publication update failed:', error);
            showToast('A kiadvány mentése sikertelen', 'error', error.message || 'Ismeretlen hiba történt a frissítés közben.');
        }
    }, [selectedItem, selectedType, updatePublication, showToast]);

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
                showToast('A dokumentum zárolva van', 'warning', 'Ezt a fájlt jelenleg más felhasználó szerkeszti. Próbáld meg később.');
                return;
            }

            const app = require("indesign").app;

            if (!article.filePath) {
                console.error("No file path for article:", article.name);
                showToast(NO_FILE_PATH_ERROR.title, 'error', NO_FILE_PATH_ERROR.description);
                return;
            }

            const mappedPath = resolvePlatformPath(article.filePath);

            if (mappedPath) {
                try {
                    await app.open(mappedPath);
                    showToast(`${article.name} megnyitva`, 'success');
                } catch (openError) {
                    console.warn("Standard app.open failed, trying ExtendScript fallback...", openError);

                    const script = generateOpenDocumentScript(mappedPath);
                    const result = app.doScript(script, SCRIPT_LANGUAGE_JAVASCRIPT, []);
                    if (result !== "success") {
                        throw new Error("ExtendScript open failed: " + result);
                    }
                    showToast(`${article.name} megnyitva`, 'success');
                }
            } else {
                console.error("No file path for article");
                showToast(NO_FILE_PATH_ERROR.title, 'error', NO_FILE_PATH_ERROR.description);
            }
        } catch (e) {
            console.error("Failed to open article:", e);
            showToast('A dokumentum megnyitása sikertelen', 'error', e.message || 'Ismeretlen hiba történt.');
        }
    }, [user, showToast]);

    // A Realtime frissítéseket mostantól a DataContext kezeli központilag.
    // A selectedArticle automatikusan frissül az articles tömb változásakor (useMemo).

    /**
     * Távoli törlés kezelése.
     * Ha a tulajdonságok nézetben vagyunk, de a kiválasztott elem már nem létezik
     * (pl. valaki más törölte), akkor értesítjük a felhasználót és visszanavigálunk.
     */
    useEffect(() => {
        if (currentView === 'properties' && selectedItemId && !selectedItem) {
            showToast('Az elem már nem létezik', 'warning', 'A kiválasztott elemet időközben valaki más törölhette.');
            handleBackToList();
        }
    }, [currentView, selectedItemId, selectedItem, showToast, handleBackToList]);

    return (
        <div style={{ position: 'relative', height: '100%', display: 'flex', flexDirection: 'column' }}>
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
                />
            </div>

            {currentView === 'properties' && selectedItem && (
                <PropertiesPanel
                    selectedItem={selectedItem}
                    type={selectedType}
                    publication={selectedPublication}
                    onPublicationUpdate={handlePublicationUpdate}
                    onBack={handleBackToList}
                    onOpen={handleOpenArticle}
                    runAndPersistPreflight={runAndPersistPreflight}
                />
            )}
        </div>
    );
};
