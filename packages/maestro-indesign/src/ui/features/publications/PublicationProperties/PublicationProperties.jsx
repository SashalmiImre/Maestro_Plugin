import React, { useState } from "react";

// Feature Components
import { GeneralSection } from "./GeneralSection.jsx";
import { ContributorsSection } from "./ContributorsSection.jsx";
import { LayoutsSection } from "./LayoutsSection.jsx";
import { DeadlinesSection } from "./DeadlinesSection.jsx";

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
                />

                <LayoutsSection
                    publication={publication}
                />

                <DeadlinesSection
                    publication={publication}
                    onValidationChange={onValidationChange}
                />

                <ContributorsSection
                    publication={publication}
                    onFieldUpdate={onFieldUpdate}
                />
            </div>
        </div>
    );
};
