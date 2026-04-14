// React
import React, { useState, useCallback, useEffect, useRef } from "react";

// Components
import { Publication } from "./Publication/Publication.jsx";
import { PublicationListToolbar } from "./PublicationListToolbar.jsx";
import { LockManager } from "../workspace/LockManager.jsx";

// Custom Hooks
import { useOverlapValidation } from "../../../data/hooks/useOverlapValidation.js";
import { useDatabaseIntegrityValidation } from "../../../data/hooks/useDatabaseIntegrityValidation.js";
import { useData } from "../../../core/contexts/DataContext.jsx";
import { useDriveAccessibility } from "../../../data/hooks/useDriveAccessibility.js";

// Utils
import { STORAGE_KEYS } from "../../../core/utils/constants.js";
import { logDebug, logWarn } from "../../../core/utils/logger.js";
import { DocumentMonitor } from "../workspace/DocumentMonitor.jsx";


export const PublicationList = ({ onShowProperties, onOpenInDashboard, filterState }) => {
    // A publikációk és a betöltés állapota közvetlenül a DataContext-ből — a plugin nem ír
    // publikációkba (Fázis 9), ezért nincs külön hook-wrapper.
    const { publications, isLoading: loading, setActivePublicationId } = useData();

    // Központi mappa-elérhetőség figyelés (minden kiadványra, 2s polling)
    const accessibilityMap = useDriveAccessibility(publications);

    useOverlapValidation();

    // Adatbázis-integritás validáció (MaestroEvent.documentSaved/documentClosed eseményekre hallgat)
    useDatabaseIntegrityValidation();

    // Initialize expandedId from localStorage
    const [expandedId, setExpandedId] = useState(() => {
        try {
            const saved = localStorage.getItem(STORAGE_KEYS.EXPANDED_PUBLICATION_ID);
            logDebug('[PublicationList] Initializing expandedId from localStorage:', { saved, type: typeof saved });
            return saved || null;
        } catch (e) {
            logWarn('[PublicationList] Failed to read expandedId from localStorage:', e);
            return null;
        }
    });

    // Debug: Log expandedId whenever it changes
    useEffect(() => {
        logDebug('[PublicationList] expandedId changed to:', expandedId);
    }, [expandedId]);

    // Debug: Log publications and expandedId relationship
    useEffect(() => {
        logDebug('[PublicationList] Publications loaded:', {
            count: publications.length,
            ids: publications.map(p => p.$id),
            expandedId,
            matches: publications.map(p => ({ id: p.$id, isMatch: p.$id === expandedId }))
        });
    }, [publications, expandedId]);

    // Clear expandedId if the saved publication no longer exists
    useEffect(() => {
        if (expandedId && publications.length > 0) {
            const exists = publications.some(pub => pub.$id === expandedId);
            logDebug('[PublicationList] Checking if saved publication exists:', { expandedId, exists });
            if (!exists) {
                logDebug('[PublicationList] Saved publication no longer exists, clearing expandedId');
                setExpandedId(null);
                try {
                    localStorage.removeItem(STORAGE_KEYS.EXPANDED_PUBLICATION_ID);
                } catch (e) {
                    logWarn('[PublicationList] Failed to remove expandedId from localStorage:', e);
                }
            }
        }
    }, [expandedId, publications]);

    // Save expandedId to localStorage when it changes
    useEffect(() => {
        try {
            if (expandedId) {
                logDebug('[PublicationList] Saving expandedId to localStorage:', expandedId);
                localStorage.setItem(STORAGE_KEYS.EXPANDED_PUBLICATION_ID, expandedId);
            } else {
                logDebug('[PublicationList] Removing expandedId from localStorage');
                localStorage.removeItem(STORAGE_KEYS.EXPANDED_PUBLICATION_ID);
            }
        } catch (e) {
            logWarn('[PublicationList] Failed to save expandedId to localStorage:', e);
        }
    }, [expandedId]);

    const toggleExpansion = useCallback((id) => {
        setExpandedId(prev => {
            const newId = prev === id ? null : id;
            if (newId) {
                // Set as active to trigger data fetch
                setActivePublicationId(newId);
                logDebug('[PublicationList] Expanded & Set Active:', newId);
            }
            // Optional: clear active if collapsed? 
            // If we clear it, the list empties immediately. 
            // Maybe better to keep it until another is selected?
            // But if we collapse, maybe we don't want to listen to realtime anymore?
            // Let's keep it simple: Expand -> Set Active. Collapse -> Do nothing (or maybe clear if it was the active one).
            return newId;
        });
    }, [setActivePublicationId]);

    // Sync initial expanded state from localStorage with DataContext — csak AKKOR,
    // ha a publications már betöltődött ÉS az expandedId valóban létező publikációra
    // mutat. Korábban a mount effect vakon dispatch-elt `setActivePublicationId`-t,
    // akár törölt/deaktivált publikáció ID-jára is — a fetch utána üres listát kapott.
    // A `didRestoreRef` biztosítja, hogy a restore pontosan egyszer fusson le.
    const didRestoreRef = useRef(false);
    useEffect(() => {
        if (didRestoreRef.current) return;
        if (publications.length === 0) return;
        if (expandedId && publications.some(p => p.$id === expandedId)) {
            setActivePublicationId(expandedId);
            logDebug('[PublicationList] Restored Active from LocalStorage:', expandedId);
        }
        didRestoreRef.current = true;
    }, [publications, expandedId, setActivePublicationId]);

    return (
        <>
            <PublicationListToolbar />

            <div style={{
                display: "flex",
                flexDirection: "column",
                flex: "1",
                minHeight: "0",
                overflow: "hidden" // Revert to hidden to force child (Publication) to handle scroll
            }}>
                {/* Show simple loading indicator if empty and loading */}
                {loading && publications.length === 0 && (
                    <sp-body style={{ padding: "20px", textAlign: "center" }}>Betöltés...</sp-body>
                )}

                {/* Üres állapot: nincs aktivált kiadvány ebben a szerkesztőségben.
                    A Plugin Fázis 9 óta nem hoz létre kiadványt — a Dashboardra irányítjuk a felhasználót. */}
                {!loading && publications.length === 0 && (
                    <div style={{ padding: "24px 20px", textAlign: "center" }}>
                        <sp-body style={{ display: "block", marginBottom: "8px", fontWeight: "bold" }}>
                            Nincs aktivált kiadvány
                        </sp-body>
                        <sp-body size="s" style={{ display: "block", opacity: 0.75 }}>
                            Ebben a szerkesztőségben még nincs aktivált kiadvány. A kiadványok létrehozása és aktiválása a Dashboardon történik — nyisd meg a Dashboardot a fenti „DASHBOARD" linkkel.
                        </sp-body>
                    </div>
                )}

                {publications.map((pub) => (
                    <Publication
                        style={{ paddingBottom: "32px" }}
                        key={pub.$id}
                        publication={pub}
                        onShowProperties={onShowProperties}
                        onOpenInDashboard={onOpenInDashboard}
                        isExpanded={expandedId === pub.$id}
                        onToggle={() => toggleExpansion(pub.$id)}
                        isDriveAccessible={accessibilityMap.get(pub.$id) ?? true}
                        filterState={filterState}
                    />
                ))}
            </div>

            <LockManager />
            <DocumentMonitor />
        </>
    );
};