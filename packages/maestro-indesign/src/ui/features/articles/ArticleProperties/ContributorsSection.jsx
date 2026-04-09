// React
import React from "react";

// Custom Hooks
import { useContributorGroups } from "../../../../data/hooks/useContributorGroups.js";

// Components
import { CollapsibleSection } from "../../../common/CollapsibleSection.jsx";
import { CustomDropdown } from "../../../common/CustomDropdown.jsx";

// Utils
import { STORAGE_KEYS } from "../../../../core/utils/constants.js";
import { getContributor, setContributor } from "maestro-shared/contributorHelpers.js";

/**
 * ContributorsSection Component
 *
 * Dinamikusan rendereli a contributor dropdown-okat a szerkesztőség csoportjai alapján.
 * Minden csoport egy dropdown-t kap, ahol a csoport tagjai közül választható ki a contributor.
 *
 * A contributors JSON string formátumban tárolt: '{"designers":"userId","editors":"userId"}'
 *
 * @param {Object} props
 * @param {Object} props.article - A cikk objektum (benne: contributors JSON string)
 * @param {Function} props.onFieldUpdate - Callback: (fieldName, value) => void
 * @param {boolean} props.disabled - Az összes dropdown tiltva
 * @param {Object} props.contributorPermissions - {slug: {allowed, reason}} jogosultsági map
 */
export const ContributorsSection = ({ article, onFieldUpdate, disabled, contributorPermissions = {} }) => {
    const { groups, membersBySlug } = useContributorGroups();

    /** Meghatározza, hogy az adott contributor dropdown disabled-e. */
    const isDropdownDisabled = (slug) => {
        if (disabled) return true;
        const perm = contributorPermissions[slug];
        return perm ? !perm.allowed : false;
    };

    /** Visszaadja a tooltip reason-t az adott dropdown-hoz. */
    const getDropdownReason = (slug) => {
        if (disabled) return undefined;
        return contributorPermissions[slug]?.reason;
    };

    /** Contributor változás kezelése. */
    const handleChange = (slug, val) => {
        const newJson = setContributor(article.contributors, slug, val || null);
        onFieldUpdate('contributors', newJson);
    };

    // Csoportokat párokba rendezzük a 2 oszlopos elrendezéshez
    const pairs = [];
    for (let i = 0; i < groups.length; i += 2) {
        pairs.push(groups.slice(i, i + 2));
    }

    return (
        <CollapsibleSection
            title="MUNKATÁRSAK"
            showDivider={true}
            storageKey={STORAGE_KEYS.SECTION_ARTICLE_CONTRIBUTORS_COLLAPSED}
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
                                    id={`contributor-${group.slug}-dropdown`}
                                    emptyLabel="Nincs hozzárendelve"
                                    value={getContributor(article.contributors, group.slug)}
                                    onChange={(val) => handleChange(group.slug, val)}
                                    disabled={isDropdownDisabled(group.slug) || undefined}
                                    title={getDropdownReason(group.slug)}
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
        </CollapsibleSection>
    );
};
