// React
import React from "react";

// Custom Hooks
import { useTeamMembers } from "../../../../data/hooks/useTeamMembers.js";
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
 * Supported roles:
 * - **Writer (Szerző)**: Content creator from the Writers team
 * - **Editor (Szerkesztő)**: Content reviewer from the Editors team
 * - **Image Editor (Képszerkesztő)**: Image processor from the Image Editors team
 * - **Designer (Tervező)**: Layout designer from the Designers team
 * 
 * @param {Object} props - Component props
 * @param {Object} props.article - The article object containing contributor assignments
 * @param {string} [props.article.writerId] - ID of the assigned writer
 * @param {string} [props.article.editorId] - ID of the assigned editor
 * @param {string} [props.article.imageEditorId] - ID of the assigned image editor
 * @param {string} [props.article.designerId] - ID of the assigned designer
 * @param {Function} props.onFieldUpdate - Callback to update article field: (fieldName, userId) => void
 * @returns {JSX.Element} The ContributorsSection component
 */
export const ContributorsSection = ({ article, onFieldUpdate, disabled }) => {
    // Access team members service via unified database hook

    // Fetch team members for each role
    const { members: editors } = useTeamMembers(TEAMS.EDITORS);
    const { members: designers } = useTeamMembers(TEAMS.DESIGNERS);
    const { members: writers } = useTeamMembers(TEAMS.WRITERS);
    const { members: imageEditors } = useTeamMembers(TEAMS.IMAGE_EDITORS);


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
                <div style={{ display: "flex" }}>
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
            </div>
        </CollapsibleSection>
    );
};
