// React
import React, { useState, useCallback } from "react";

// Contexts & Custom Hooks
import { useContributorGroups } from "../../../../data/hooks/useContributorGroups.js";
import { useData } from "../../../../core/contexts/DataContext.jsx";
import { useToast } from "../../../common/Toast/ToastContext.jsx";

// Components
import { CollapsibleSection } from "../../../common/CollapsibleSection.jsx";
import { CustomDropdown } from "../../../common/CustomDropdown.jsx";
import { ConfirmDialog } from "../../../common/ConfirmDialog.jsx";

// Utils
import { STORAGE_KEYS } from "../../../../core/utils/constants.js";
import { logError } from "../../../../core/utils/logger.js";
import { getContributor, setContributor } from "maestro-shared/contributorHelpers.js";

/**
 * ContributorsSection Component (Publication)
 *
 * A kiadvány alapértelmezett munkatársainak kezelése.
 * Az itt beállított személyek lesznek az alapértelmezettek az újonnan létrehozott cikkeknél.
 * Ha a kiadványnak már vannak cikkjei, és az adott szerepkör a cikken nincs kitöltve (null),
 * a rendszer felajánlja, hogy a meglévő cikkeket is frissíti.
 *
 * @param {Object} props
 * @param {Object} props.publication - A kiadvány objektum (benne: defaultContributors JSON string)
 * @param {Function} props.onFieldUpdate - Mező frissítés callback: (fieldName, value) => void
 * @param {boolean} props.disabled - Az összes dropdown tiltva
 * @param {string} [props.permissionReason] - Tooltip szöveg, ha disabled
 */
export const ContributorsSection = ({ publication, onFieldUpdate, disabled, permissionReason }) => {
    const { groups, membersBySlug } = useContributorGroups();
    const { articles, updateArticle } = useData();
    const { showToast } = useToast();

    // Megerősítő dialógus állapota
    const [confirmState, setConfirmState] = useState({
        isOpen: false,
        slug: null,          // a csoport slug-ja
        groupName: null,     // megjelenítési név a dialógusban
        selectedUserId: null,
        affectedCount: 0
    });

    /**
     * Dropdown változás kezelése.
     * Ha nem null értéket választ és vannak érintett cikkek, megerősítést kér.
     */
    const handleDropdownChange = useCallback((slug, groupName, val) => {
        const userId = val || null;

        // Mindig mentjük a kiadvány default mezőt
        const newJson = setContributor(publication.defaultContributors, slug, userId);
        onFieldUpdate('defaultContributors', newJson);

        // Ha null-ra állítja (törlés), nem kérdezünk rá
        if (!userId) return;

        // Megnézzük, hány cikkben null az adott szerepkör
        const pubArticles = articles.filter(a => a.publicationId === publication.$id);
        const nullArticles = pubArticles.filter(a => !getContributor(a.contributors, slug));

        if (nullArticles.length === 0) return;

        setConfirmState({
            isOpen: true,
            slug,
            groupName,
            selectedUserId: userId,
            affectedCount: nullArticles.length
        });
    }, [articles, publication.$id, publication.defaultContributors, onFieldUpdate]);

    /**
     * Megerősítés: a null értékű cikkek frissítése az új alapértelmezettvel.
     */
    const handleConfirm = useCallback(async () => {
        const { slug, selectedUserId } = confirmState;
        const pubArticles = articles.filter(a => a.publicationId === publication.$id);
        const nullArticles = pubArticles.filter(a => !getContributor(a.contributors, slug));

        setConfirmState(prev => ({ ...prev, isOpen: false }));

        let successCount = 0;
        for (const article of nullArticles) {
            try {
                const newJson = setContributor(article.contributors, slug, selectedUserId);
                await updateArticle(article.$id, { contributors: newJson });
                successCount++;
            } catch (error) {
                logError(`[ContributorsSection] Cikk frissítése sikertelen (${article.name}):`, error);
            }
        }

        if (successCount > 0) {
            showToast(
                `${successCount} cikk frissítve`,
                'success',
                `A(z) ${confirmState.groupName} szerepkör beállítva ${successCount} cikkben.`
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

    // Csoportokat párokba rendezzük a 2 oszlopos elrendezéshez
    const pairs = [];
    for (let i = 0; i < groups.length; i += 2) {
        pairs.push(groups.slice(i, i + 2));
    }

    return (
        <CollapsibleSection
            title="ALAPÉRTELMEZETT MUNKATÁRSAK"
            showDivider={true}
            storageKey={STORAGE_KEYS.SECTION_PUBLICATION_CONTRIBUTORS_COLLAPSED}
        >
            <div style={{ display: "flex", flexDirection: "column" }}>
                {pairs.map((pair, pairIndex) => (
                    <div
                        key={pair.map(g => g.slug).join('-')}
                        style={{
                            display: "flex",
                            marginBottom: pairIndex < pairs.length - 1 ? "12px" : undefined
                        }}
                    >
                        {pair.map((group, colIndex) => (
                            <div
                                key={group.slug}
                                style={{
                                    flex: 1,
                                    marginRight: colIndex === 0 && pair.length > 1 ? "12px" : undefined
                                }}
                            >
                                <sp-label>{group.name}</sp-label>
                                <CustomDropdown
                                    id={`pub-default-${group.slug}-dropdown`}
                                    emptyLabel="Nincs hozzárendelve"
                                    value={getContributor(publication.defaultContributors, group.slug)}
                                    onChange={(val) => handleDropdownChange(group.slug, group.name, val)}
                                    disabled={disabled || undefined}
                                    title={disabled ? permissionReason : undefined}
                                    style={{ width: "100%" }}
                                >
                                    <sp-menu slot="options" size="m">
                                        <sp-menu-item value="">Nincs hozzárendelve</sp-menu-item>
                                        {(membersBySlug[group.slug] || []).map(m => (
                                            <sp-menu-item key={m.userId} value={m.userId}>
                                                {m.userName || m.userEmail}
                                            </sp-menu-item>
                                        ))}
                                    </sp-menu>
                                </CustomDropdown>
                            </div>
                        ))}
                        {/* Üres placeholder ha páratlan az utolsó sor */}
                        {pair.length === 1 && <div style={{ flex: 1 }} />}
                    </div>
                ))}
            </div>

            {/* Megerősítő dialógus: meglévő cikkek frissítése */}
            <ConfirmDialog
                isOpen={confirmState.isOpen}
                title="Meglévő cikkek frissítése"
                message={confirmState.slug
                    ? `A kiadvány ${confirmState.affectedCount} cikkében nincs még ${confirmState.groupName} hozzárendelve. Szeretnéd ezeket is beállítani az új alapértelmezett személyre?`
                    : ''
                }
                confirmLabel="Frissítés"
                onConfirm={handleConfirm}
                onCancel={handleCancel}
            />
        </CollapsibleSection>
    );
};
