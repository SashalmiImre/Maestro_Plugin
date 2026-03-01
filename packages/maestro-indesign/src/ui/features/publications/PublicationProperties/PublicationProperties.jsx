import React from "react";

// Feature Components
import { GeneralSection } from "./GeneralSection.jsx";
import { ContributorsSection } from "./ContributorsSection.jsx";
import { LayoutsSection } from "./LayoutsSection.jsx";
import { DeadlinesSection } from "./DeadlinesSection.jsx";

// Hooks
import { useElementPermissions } from "../../../../data/hooks/useElementPermission.js";

/**
 * PublicationProperties Component
 *
 * A kiadvány részletes tulajdonságainak kezelése, három szekcióban:
 * 1. Általános — terjedelem, név, gyökérkönyvtár, metaadatok
 * 2. Elrendezések — dinamikus layout lista (CRUD)
 * 3. Határidők — nyomdai határidők oldaltartományokkal
 *
 * @param {Object} props
 * @param {Object} props.publication - A kiadvány objektum
 * @param {Function} [props.onFieldUpdate] - Mező frissítés callback: (fieldName, value) => void
 * @param {Function} [props.onValidationChange] - Validáció állapot callback: (hasErrors: boolean) => void
 */
export const PublicationProperties = ({ publication, onFieldUpdate, onValidationChange }) => {
    // Kiadvány-szintű elem jogosultságok
    const perm = useElementPermissions([
        'publicationGeneral', 'publicationLayouts',
        'publicationDeadlines', 'publicationContributors'
    ]);

    return (
        <div style={{
            padding: "16px",
            position: "relative",
            zIndex: 1,
            height: "100%",
            display: "flex",
            flexDirection: "column",
            boxSizing: "border-box"
        }}>
            <div style={{
                display: "flex",
                flexDirection: "column",
                flex: "1 1 auto",
                overflowY: "auto",
                minHeight: 0,
                paddingBottom: "16px",
                paddingRight: "8px"
            }}>
                <GeneralSection
                    publication={publication}
                    onFieldUpdate={onFieldUpdate}
                    disabled={!perm.publicationGeneral.allowed}
                    permissionReason={perm.publicationGeneral.reason}
                />

                <LayoutsSection
                    publication={publication}
                    disabled={!perm.publicationLayouts.allowed}
                    permissionReason={perm.publicationLayouts.reason}
                />

                <DeadlinesSection
                    publication={publication}
                    onFieldUpdate={onFieldUpdate}
                    onValidationChange={onValidationChange}
                    disabled={!perm.publicationDeadlines.allowed}
                    permissionReason={perm.publicationDeadlines.reason}
                />

                <ContributorsSection
                    publication={publication}
                    onFieldUpdate={onFieldUpdate}
                    disabled={!perm.publicationContributors.allowed}
                    permissionReason={perm.publicationContributors.reason}
                />
            </div>
        </div>
    );
};
