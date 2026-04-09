// React
import React, { useEffect, useState, useCallback } from "react";

// Contexts & Custom Hooks
import { useGroupMembers, invalidateGroupMembersCache } from "../../../../data/hooks/useGroupMembers.js";
import { useData } from "../../../../core/contexts/DataContext.jsx";
import { useToast } from "../../../common/Toast/ToastContext.jsx";

// Components
import { CollapsibleSection } from "../../../common/CollapsibleSection.jsx";
import { CustomDropdown } from "../../../common/CustomDropdown.jsx";
import { ConfirmDialog } from "../../../common/ConfirmDialog.jsx";

// Utils
import { STORAGE_KEYS } from "../../../../core/utils/constants.js";
import { logError } from "../../../../core/utils/logger.js";

/**
 * Leképezés: kiadvány default mező → cikk mező.
 * Pl. defaultWriterId → writerId
 */
const DEFAULT_TO_ARTICLE_FIELD = {
    defaultWriterId: 'writerId',
    defaultEditorId: 'editorId',
    defaultImageEditorId: 'imageEditorId',
    defaultDesignerId: 'designerId',
    defaultProofwriterId: 'proofwriterId',
    defaultArtDirectorId: 'artDirectorId',
    defaultManagingEditorId: 'managingEditorId'
};

/**
 * Szerepkör nevek a megerősítő dialógushoz.
 */
const ROLE_LABELS = {
    defaultWriterId: 'Szerző',
    defaultEditorId: 'Szerkesztő',
    defaultImageEditorId: 'Képszerkesztő',
    defaultDesignerId: 'Tervező',
    defaultProofwriterId: 'Korrektor',
    defaultArtDirectorId: 'Művészeti vezető',
    defaultManagingEditorId: 'Vezetőszerkesztő'
};

/**
 * ContributorsSection Component (Publication)
 *
 * A kiadvány alapértelmezett munkatársainak kezelése.
 * Az itt beállított személyek lesznek az alapértelmezettek az újonnan létrehozott cikkeknél.
 * Ha a kiadványnak már vannak cikkjei, és az adott szerepkör a cikken nincs kitöltve (null),
 * a rendszer felajánlja, hogy a meglévő cikkeket is frissíti.
 *
 * @param {Object} props
 * @param {Object} props.publication - A kiadvány objektum
 * @param {Function} props.onFieldUpdate - Mező frissítés callback: (fieldName, value) => void
 */
export const ContributorsSection = ({ publication, onFieldUpdate, disabled, permissionReason }) => {
    // Mount-kor a cache invalidálása, hogy friss csoporttaglistát kérjünk
    useEffect(() => {
        invalidateGroupMembersCache();
    }, []);

    const { articles, updateArticle } = useData();
    const { showToast } = useToast();

    // Megerősítő dialógus állapota
    const [confirmState, setConfirmState] = useState({
        isOpen: false,
        defaultField: null,     // pl. 'defaultWriterId'
        selectedUserId: null,   // az új userId
        affectedCount: 0        // érintett cikkek száma
    });

    /**
     * Dropdown változás kezelése.
     * Ha nem null értéket választ és vannak érintett cikkek, megerősítést kér.
     */
    const handleDropdownChange = useCallback((defaultField, val) => {
        const userId = val || null;

        // Mindig mentjük a kiadvány default mezőt
        onFieldUpdate(defaultField, userId);

        // Ha null-ra állítja (törlés), nem kérdezünk rá
        if (!userId) return;

        // Megnézzük, hány cikkben null az adott szerepkör
        const articleField = DEFAULT_TO_ARTICLE_FIELD[defaultField];
        const pubArticles = articles.filter(a => a.publicationId === publication.$id);
        const nullArticles = pubArticles.filter(a => !a[articleField]);

        if (nullArticles.length === 0) return;

        setConfirmState({
            isOpen: true,
            defaultField,
            selectedUserId: userId,
            affectedCount: nullArticles.length
        });
    }, [articles, publication.$id, onFieldUpdate]);

    /**
     * Megerősítés: a null értékű cikkek frissítése az új alapértelmezettvel.
     */
    const handleConfirm = useCallback(async () => {
        const { defaultField, selectedUserId } = confirmState;
        const articleField = DEFAULT_TO_ARTICLE_FIELD[defaultField];
        const pubArticles = articles.filter(a => a.publicationId === publication.$id);
        const nullArticles = pubArticles.filter(a => !a[articleField]);

        setConfirmState(prev => ({ ...prev, isOpen: false }));

        let successCount = 0;
        for (const article of nullArticles) {
            try {
                await updateArticle(article.$id, { [articleField]: selectedUserId });
                successCount++;
            } catch (error) {
                logError(`[ContributorsSection] Cikk frissítése sikertelen (${article.name}):`, error);
            }
        }

        if (successCount > 0) {
            showToast(
                `${successCount} cikk frissítve`,
                'success',
                `A(z) ${ROLE_LABELS[defaultField]} szerepkör beállítva ${successCount} cikkben.`
            );
        }
        if (successCount < nullArticles.length) {
            showToast(
                'Néhány cikk frissítése sikertelen',
                'warning',
                `${nullArticles.length - successCount} cikk frissítése nem sikerült.`
            );
        }
    }, [confirmState, articles, publication.$id, updateArticle, showToast]);

    const handleCancel = useCallback(() => {
        setConfirmState(prev => ({ ...prev, isOpen: false }));
    }, []);

    // Csoporttagok lekérése szerepkörönként
    const { members: editors } = useGroupMembers('editors');
    const { members: designers } = useGroupMembers('designers');
    const { members: writers } = useGroupMembers('writers');
    const { members: imageEditors } = useGroupMembers('image_editors');
    const { members: artDirectors } = useGroupMembers('art_directors');
    const { members: managingEditors } = useGroupMembers('managing_editors');
    const { members: proofwriters } = useGroupMembers('proofwriters');

    return (
        <CollapsibleSection
            title="ALAPÉRTELMEZETT MUNKATÁRSAK"
            showDivider={true}
            storageKey={STORAGE_KEYS.SECTION_PUBLICATION_CONTRIBUTORS_COLLAPSED}
        >
            <div style={{ display: "flex", flexDirection: "column" }}>

                {/* Szerző & Képszerkesztő */}
                <div style={{ display: "flex", marginBottom: "12px" }}>
                    <div style={{ flex: 1, marginRight: "12px" }}>
                        <sp-label>Szerző</sp-label>
                        <CustomDropdown
                            id="pub-default-writer-dropdown"
                            emptyLabel="Nincs hozzárendelve"
                            value={publication.defaultWriterId}
                            onChange={(val) => handleDropdownChange('defaultWriterId', val)}
                            disabled={disabled || undefined}
                            title={disabled ? permissionReason : undefined}
                            style={{ width: "100%" }}
                        >
                            <sp-menu slot="options" size="m">
                                <sp-menu-item value="">Nincs hozzárendelve</sp-menu-item>
                                {writers.map(m => (
                                    <sp-menu-item key={m.userId} value={m.userId}>
                                        {m.userName || m.userEmail}
                                    </sp-menu-item>
                                ))}
                            </sp-menu>
                        </CustomDropdown>
                    </div>
                    <div style={{ flex: 1 }}>
                        <sp-label>Képszerkesztő</sp-label>
                        <CustomDropdown
                            id="pub-default-image-editor-dropdown"
                            emptyLabel="Nincs hozzárendelve"
                            value={publication.defaultImageEditorId}
                            onChange={(val) => handleDropdownChange('defaultImageEditorId', val)}
                            disabled={disabled || undefined}
                            title={disabled ? permissionReason : undefined}
                            style={{ width: "100%" }}
                        >
                            <sp-menu slot="options" size="m">
                                <sp-menu-item value="">Nincs hozzárendelve</sp-menu-item>
                                {imageEditors.map(m => (
                                    <sp-menu-item key={m.userId} value={m.userId}>
                                        {m.userName || m.userEmail}
                                    </sp-menu-item>
                                ))}
                            </sp-menu>
                        </CustomDropdown>
                    </div>
                </div>

                {/* Szerkesztő & Tervező */}
                <div style={{ display: "flex", marginBottom: "12px" }}>
                    <div style={{ flex: 1, marginRight: "12px" }}>
                        <sp-label>Szerkesztő</sp-label>
                        <CustomDropdown
                            id="pub-default-editor-dropdown"
                            emptyLabel="Nincs hozzárendelve"
                            value={publication.defaultEditorId}
                            onChange={(val) => handleDropdownChange('defaultEditorId', val)}
                            disabled={disabled || undefined}
                            title={disabled ? permissionReason : undefined}
                            style={{ width: "100%" }}
                        >
                            <sp-menu slot="options" size="m">
                                <sp-menu-item value="">Nincs hozzárendelve</sp-menu-item>
                                {editors.map(m => (
                                    <sp-menu-item key={m.userId} value={m.userId}>
                                        {m.userName || m.userEmail}
                                    </sp-menu-item>
                                ))}
                            </sp-menu>
                        </CustomDropdown>
                    </div>
                    <div style={{ flex: 1 }}>
                        <sp-label>Tervező</sp-label>
                        <CustomDropdown
                            id="pub-default-designer-dropdown"
                            emptyLabel="Nincs hozzárendelve"
                            value={publication.defaultDesignerId}
                            onChange={(val) => handleDropdownChange('defaultDesignerId', val)}
                            disabled={disabled || undefined}
                            title={disabled ? permissionReason : undefined}
                            style={{ width: "100%" }}
                        >
                            <sp-menu slot="options" size="m">
                                <sp-menu-item value="">Nincs hozzárendelve</sp-menu-item>
                                {designers.map(m => (
                                    <sp-menu-item key={m.userId} value={m.userId}>
                                        {m.userName || m.userEmail}
                                    </sp-menu-item>
                                ))}
                            </sp-menu>
                        </CustomDropdown>
                    </div>
                </div>

                {/* Vezetőszerkesztő & Művészeti vezető */}
                <div style={{ display: "flex", marginBottom: "12px" }}>
                    <div style={{ flex: 1, marginRight: "12px" }}>
                        <sp-label>Vezetőszerkesztő</sp-label>
                        <CustomDropdown
                            id="pub-default-managing-editor-dropdown"
                            emptyLabel="Nincs hozzárendelve"
                            value={publication.defaultManagingEditorId}
                            onChange={(val) => handleDropdownChange('defaultManagingEditorId', val)}
                            disabled={disabled || undefined}
                            title={disabled ? permissionReason : undefined}
                            style={{ width: "100%" }}
                        >
                            <sp-menu slot="options" size="m">
                                <sp-menu-item value="">Nincs hozzárendelve</sp-menu-item>
                                {managingEditors.map(m => (
                                    <sp-menu-item key={m.userId} value={m.userId}>
                                        {m.userName || m.userEmail}
                                    </sp-menu-item>
                                ))}
                            </sp-menu>
                        </CustomDropdown>
                    </div>
                    <div style={{ flex: 1 }}>
                        <sp-label>Művészeti vezető</sp-label>
                        <CustomDropdown
                            id="pub-default-art-director-dropdown"
                            emptyLabel="Nincs hozzárendelve"
                            value={publication.defaultArtDirectorId}
                            onChange={(val) => handleDropdownChange('defaultArtDirectorId', val)}
                            disabled={disabled || undefined}
                            title={disabled ? permissionReason : undefined}
                            style={{ width: "100%" }}
                        >
                            <sp-menu slot="options" size="m">
                                <sp-menu-item value="">Nincs hozzárendelve</sp-menu-item>
                                {artDirectors.map(m => (
                                    <sp-menu-item key={m.userId} value={m.userId}>
                                        {m.userName || m.userEmail}
                                    </sp-menu-item>
                                ))}
                            </sp-menu>
                        </CustomDropdown>
                    </div>
                </div>

                {/* Korrektor */}
                <div style={{ display: "flex" }}>
                    <div style={{ flex: 1, marginRight: "12px" }}>
                        <sp-label>Korrektor</sp-label>
                        <CustomDropdown
                            id="pub-default-proofwriter-dropdown"
                            emptyLabel="Nincs hozzárendelve"
                            value={publication.defaultProofwriterId}
                            onChange={(val) => handleDropdownChange('defaultProofwriterId', val)}
                            disabled={disabled || undefined}
                            title={disabled ? permissionReason : undefined}
                            style={{ width: "100%" }}
                        >
                            <sp-menu slot="options" size="m">
                                <sp-menu-item value="">Nincs hozzárendelve</sp-menu-item>
                                {proofwriters.map(m => (
                                    <sp-menu-item key={m.userId} value={m.userId}>
                                        {m.userName || m.userEmail}
                                    </sp-menu-item>
                                ))}
                            </sp-menu>
                        </CustomDropdown>
                    </div>
                    <div style={{ flex: 1 }}>
                        {/* Üres placeholder a szimmetrikus elrendezéshez */}
                    </div>
                </div>
            </div>

            {/* Megerősítő dialógus: meglévő cikkek frissítése */}
            <ConfirmDialog
                isOpen={confirmState.isOpen}
                title="Meglévő cikkek frissítése"
                message={confirmState.defaultField
                    ? `A kiadvány ${confirmState.affectedCount} cikkében nincs még ${ROLE_LABELS[confirmState.defaultField]} hozzárendelve. Szeretnéd ezeket is beállítani az új alapértelmezett személyre?`
                    : ''
                }
                confirmLabel="Frissítés"
                onConfirm={handleConfirm}
                onCancel={handleCancel}
            />
        </CollapsibleSection>
    );
};
