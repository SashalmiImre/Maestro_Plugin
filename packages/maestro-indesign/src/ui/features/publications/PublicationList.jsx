// React
import React, { useState, useCallback, useEffect } from "react";

// Components
import { Publication } from "./Publication/Publication.jsx";
import { PublicationListToolbar } from "./PublicationListToolbar.jsx";
import { LockManager } from "../workspace/LockManager.jsx";
import { ConfirmDialog } from "../../common/ConfirmDialog.jsx";

// Custom Hooks
import { usePublications } from "../../../data/hooks/usePublications.js";
import { useOverlapValidation } from "../../../data/hooks/useOverlapValidation.js";
import { useDatabaseIntegrityValidation } from "../../../data/hooks/useDatabaseIntegrityValidation.js";
import { useData } from "../../../core/contexts/DataContext.jsx";

// Utils
import { STORAGE_KEYS } from "../../../core/utils/constants.js";
import { DocumentMonitor } from "../workspace/DocumentMonitor.jsx";


export const PublicationList = ({ onShowProperties, style }) => {
    // Access publication services
    const {
        publications,
        loading,
        error,
        fetchPublications,
        createPublication,
        deletePublication,
        renamePublication
    } = usePublications();


    useOverlapValidation();

    // Adatbázis-integritás validáció (MaestroEvent.documentSaved/documentClosed eseményekre hallgat)
    useDatabaseIntegrityValidation();

    const [deleteDialog, setDeleteDialog] = useState({ isOpen: false, id: null, title: "", message: "" });

    // Initialize expandedId from localStorage
    const [expandedId, setExpandedId] = useState(() => {
        try {
            const saved = localStorage.getItem(STORAGE_KEYS.EXPANDED_PUBLICATION_ID);
            console.log('[PublicationList] Initializing expandedId from localStorage:', { saved, type: typeof saved });
            return saved || null;
        } catch (e) {
            console.warn('[PublicationList] Failed to read expandedId from localStorage:', e);
            return null;
        }
    });

    // Debug: Log expandedId whenever it changes
    useEffect(() => {
        console.log('[PublicationList] expandedId changed to:', expandedId);
    }, [expandedId]);

    // Debug: Log publications and expandedId relationship
    useEffect(() => {
        console.log('[PublicationList] Publications loaded:', {
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
            console.log('[PublicationList] Checking if saved publication exists:', { expandedId, exists });
            if (!exists) {
                console.log('[PublicationList] Saved publication no longer exists, clearing expandedId');
                setExpandedId(null);
                try {
                    localStorage.removeItem(STORAGE_KEYS.EXPANDED_PUBLICATION_ID);
                } catch (e) {
                    console.warn('[PublicationList] Failed to remove expandedId from localStorage:', e);
                }
            }
        }
    }, [expandedId, publications]);

    // Save expandedId to localStorage when it changes
    useEffect(() => {
        try {
            if (expandedId) {
                console.log('[PublicationList] Saving expandedId to localStorage:', expandedId);
                localStorage.setItem(STORAGE_KEYS.EXPANDED_PUBLICATION_ID, expandedId);
            } else {
                console.log('[PublicationList] Removing expandedId from localStorage');
                localStorage.removeItem(STORAGE_KEYS.EXPANDED_PUBLICATION_ID);
            }
        } catch (e) {
            console.warn('[PublicationList] Failed to save expandedId to localStorage:', e);
        }
    }, [expandedId]);

    // Access DataContext to control active publication
    const { setActivePublicationId } = useData();

    const toggleExpansion = useCallback((id) => {
        setExpandedId(prev => {
            const newId = prev === id ? null : id;
            if (newId) {
                // Set as active to trigger data fetch
                setActivePublicationId(newId);
                console.log('[PublicationList] Expanded & Set Active:', newId);
            }
            // Optional: clear active if collapsed? 
            // If we clear it, the list empties immediately. 
            // Maybe better to keep it until another is selected?
            // But if we collapse, maybe we don't want to listen to realtime anymore?
            // Let's keep it simple: Expand -> Set Active. Collapse -> Do nothing (or maybe clear if it was the active one).
            return newId;
        });
    }, [setActivePublicationId]);

    // Sync initial expanded state from localStorage with DataContext
    useEffect(() => {
        if (expandedId) {
            setActivePublicationId(expandedId);
            console.log('[PublicationList] Restored Active form LocalStorage:', expandedId);
        }
    }, []); // Run once on mount

    const confirmDeletePublication = useCallback((id, name) => {
        setDeleteDialog({
            isOpen: true,
            id,
            title: "Kiadvány törlése",
            message: `Biztosan törölni szeretnéd a(z) "${name}" nevű kiadványt?\n\nFigyelem: A törléssel a kiadványhoz tartozó összes adat véglegesen törlődik. Ez a művelet nem vonható vissza.`,
            verificationExpected: name
        });
    }, []);

    const handleConfirmDelete = async () => {
        const { id } = deleteDialog;
        setDeleteDialog({ ...deleteDialog, isOpen: false });
        try {
            await deletePublication(id);
        } catch (e) {
            console.error("Error deleting:", e);
        }
    };

    return (
        <>
            <PublicationListToolbar
                createPublication={createPublication}
                fetchPublications={fetchPublications}
            />

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

                {publications.map((pub, index) => (
                    <Publication
                        style={{ paddingBottom: "32px" }}
                        key={pub.$id}
                        publication={pub}
                        onDelete={confirmDeletePublication}
                        onRename={renamePublication}

                        onShowProperties={onShowProperties}
                        isExpanded={expandedId === pub.$id}
                        onToggle={() => toggleExpansion(pub.$id)}
                    />
                ))}
            </div>

            <ConfirmDialog
                isOpen={deleteDialog.isOpen}
                title={deleteDialog.title}
                message={deleteDialog.message}
                onConfirm={handleConfirmDelete}
                onCancel={() => setDeleteDialog({ ...deleteDialog, isOpen: false })}
                isAlert={false}
                verificationExpected={deleteDialog.verificationExpected}
            />

            <ConfirmDialog
                isOpen={!!error}
                title="Hálózati Hiba"
                message={`Nem sikerült kapcsolódni a szerverhez. (${error}) A rendszer automatikusan újrapróbálkozik...`}
                isAlert={true}
                onConfirm={() => fetchPublications(false)}
                confirmLabel="Újrapróbálkozás"
            />

            <LockManager />
            <DocumentMonitor />
        </>
    );
};