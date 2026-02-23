// React
import React, { useEffect } from "react";

// Custom Hooks
import { useTeamMembers, invalidateTeamMembersCache } from "../../../../data/hooks/useTeamMembers.js";
import { TEAMS } from "../../../../core/config/appwriteConfig.js";

// Components
import { CollapsibleSection } from "../../../common/CollapsibleSection.jsx";
import { CustomDropdown } from "../../../common/CustomDropdown.jsx";

// Utils
import { STORAGE_KEYS } from "../../../../core/utils/constants.js";

/**
 * ContributorsSection Component
 * 
 * Displays and manages team member assignments for article roles.
 * Each role is represented by a dropdown that allows selecting a team member
 * from the appropriate team. The component fetches team member lists using
 * the useTeamMembers hook for each role.
 * 
 * Támogatott szerepkörök:
 * - **Szerző (Writer)**: Tartalomkészítő a Writers csapatból
 * - **Szerkesztő (Editor)**: Tartalomellenőr az Editors csapatból
 * - **Képszerkesztő (Image Editor)**: Képfeldolgozó az Image Editors csapatból
 * - **Tervező (Designer)**: Tördelő a Designers csapatból
 * - **Korrektor (Proofwriter)**: Korrektúrázó a Proofwriters csapatból
 * - **Művészeti vezető (Art Director)**: Vizuális jóváhagyó az Art Directors csapatból
 * - **Vezetőszerkesztő (Managing Editor)**: Szerkesztőségi jóváhagyó a Managing Editors csapatból
 *
 * @param {Object} props - Component props
 * @param {Object} props.article - The article object containing contributor assignments
 * @param {string} [props.article.writerId] - ID of the assigned writer
 * @param {string} [props.article.editorId] - ID of the assigned editor
 * @param {string} [props.article.imageEditorId] - ID of the assigned image editor
 * @param {string} [props.article.designerId] - ID of the assigned designer
 * @param {string} [props.article.proofwriterId] - ID of the assigned proofwriter
 * @param {string} [props.article.artDirectorId] - ID of the assigned art director
 * @param {string} [props.article.managingEditorId] - ID of the assigned managing editor
 * @param {Function} props.onFieldUpdate - Callback to update article field: (fieldName, userId) => void
 * @returns {JSX.Element} The ContributorsSection component
 */
export const ContributorsSection = ({ article, onFieldUpdate, disabled }) => {
    // Mount-kor a cache invalidálása, hogy friss csapattaglistát kérjünk
    useEffect(() => {
        invalidateTeamMembersCache();
    }, []);

    // Fetch team members for each role
    const { members: editors } = useTeamMembers(TEAMS.EDITORS);
    const { members: designers } = useTeamMembers(TEAMS.DESIGNERS);
    const { members: writers } = useTeamMembers(TEAMS.WRITERS);
    const { members: imageEditors } = useTeamMembers(TEAMS.IMAGE_EDITORS);
    const { members: artDirectors } = useTeamMembers(TEAMS.ART_DIRECTORS);
    const { members: managingEditors } = useTeamMembers(TEAMS.MANAGING_EDITORS);
    const { members: proofwriters } = useTeamMembers(TEAMS.PROOFWRITERS);


    return (
        <CollapsibleSection
            title="MUNKATÁRSAK"
            showDivider={true}
            storageKey={STORAGE_KEYS.SECTION_CONTRIBUTORS_COLLAPSED}
        >
            <div style={{ display: "flex", flexDirection: "column" }}>

                {/* Writer & Editor Row */}
                <div style={{ display: "flex", marginBottom: "12px" }}>
                    <div style={{ flex: 1, marginRight: "12px" }}>
                        <sp-label>Szerző</sp-label>
                        <CustomDropdown
                            id="writer-dropdown"
                            value={article.writerId}
                            onChange={(val) => onFieldUpdate('writerId', val)}
                            disabled={disabled || undefined}
                            style={{ width: "100%" }}
                        >
                            <sp-menu slot="options" size="m">
                                {writers.map(m => (
                                    <sp-menu-item key={m.userId} value={m.userId}>
                                        {m.userName || m.userEmail}
                                    </sp-menu-item>
                                ))}
                            </sp-menu>
                        </CustomDropdown>
                    </div>
                    <div style={{ flex: 1 }}>
                        <sp-label>Szerkesztő</sp-label>
                        <CustomDropdown
                            id="editor-dropdown"
                            value={article.editorId}
                            onChange={(val) => onFieldUpdate('editorId', val)}
                            disabled={disabled || undefined}
                            style={{ width: "100%" }}
                        >
                            <sp-menu slot="options" size="m">
                                {editors.map(m => (
                                    <sp-menu-item key={m.userId} value={m.userId}>
                                        {m.userName || m.userEmail}
                                    </sp-menu-item>
                                ))}
                            </sp-menu>
                        </CustomDropdown>
                    </div>
                </div>

                {/* Image Editor & Designer Row */}
                <div style={{ display: "flex", marginBottom: "12px" }}>
                    <div style={{ flex: 1, marginRight: "12px" }}>
                        <sp-label>Képszerkesztő</sp-label>
                        <CustomDropdown
                            id="image-editor-dropdown"
                            value={article.imageEditorId}
                            onChange={(val) => onFieldUpdate('imageEditorId', val)}
                            disabled={disabled || undefined}
                            style={{ width: "100%" }}
                        >
                            <sp-menu slot="options" size="m">
                                {imageEditors.map(m => (
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
                            id="designer-dropdown"
                            value={article.designerId}
                            onChange={(val) => onFieldUpdate('designerId', val)}
                            disabled={disabled || undefined}
                            style={{ width: "100%" }}
                        >
                            <sp-menu slot="options" size="m">
                                {designers.map(m => (
                                    <sp-menu-item key={m.userId} value={m.userId}>
                                        {m.userName || m.userEmail}
                                    </sp-menu-item>
                                ))}
                            </sp-menu>
                        </CustomDropdown>
                    </div>
                </div>

                {/* Proofwriter & Art Director Row */}
                <div style={{ display: "flex", marginBottom: "12px" }}>
                    <div style={{ flex: 1, marginRight: "12px" }}>
                        <sp-label>Korrektor</sp-label>
                        <CustomDropdown
                            id="proofwriter-dropdown"
                            value={article.proofwriterId}
                            onChange={(val) => onFieldUpdate('proofwriterId', val)}
                            disabled={disabled || undefined}
                            style={{ width: "100%" }}
                        >
                            <sp-menu slot="options" size="m">
                                {proofwriters.map(m => (
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
                            id="art-director-dropdown"
                            value={article.artDirectorId}
                            onChange={(val) => onFieldUpdate('artDirectorId', val)}
                            disabled={disabled || undefined}
                            style={{ width: "100%" }}
                        >
                            <sp-menu slot="options" size="m">
                                {artDirectors.map(m => (
                                    <sp-menu-item key={m.userId} value={m.userId}>
                                        {m.userName || m.userEmail}
                                    </sp-menu-item>
                                ))}
                            </sp-menu>
                        </CustomDropdown>
                    </div>
                </div>

                {/* Managing Editor Row */}
                <div style={{ display: "flex" }}>
                    <div style={{ flex: 1, marginRight: "12px" }}>
                        <sp-label>Vezetőszerkesztő</sp-label>
                        <CustomDropdown
                            id="managing-editor-dropdown"
                            value={article.managingEditorId}
                            onChange={(val) => onFieldUpdate('managingEditorId', val)}
                            disabled={disabled || undefined}
                            style={{ width: "100%" }}
                        >
                            <sp-menu slot="options" size="m">
                                {managingEditors.map(m => (
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
        </CollapsibleSection>
    );
};
