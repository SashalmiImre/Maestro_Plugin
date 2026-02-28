import React, { useState, useEffect } from "react";

// Components
import { CollapsibleSection } from "../../../common/CollapsibleSection.jsx";
import { ValidatedTextField } from "../../../common/ValidatedTextField.jsx";

// Config & Constants
import { STORAGE_KEYS } from "../../../../core/utils/constants.js";

/**
 * GeneralSection Component (Publication)
 *
 * A kiadvány általános tulajdonságait jeleníti meg és kezeli:
 * - Oldalterjedelem (coverageStart, coverageEnd) — szerkeszthető
 * - Név — szerkeszthető (Enter/blur mentés)
 * - Gyökérkönyvtár — csak olvasható
 * - Létrehozás dátuma — csak olvasható
 * - Azonosító — csak olvasható
 *
 * @param {Object} props
 * @param {Object} props.publication - A kiadvány objektum
 * @param {Function} props.onFieldUpdate - Mező frissítés callback: (fieldName, value) => void
 */
export const GeneralSection = ({ publication, onFieldUpdate }) => {
    // Lokális state az Enter/blur mentéshez
    const [localCoverageStart, setLocalCoverageStart] = useState(publication.coverageStart || "");
    const [localCoverageEnd, setLocalCoverageEnd] = useState(publication.coverageEnd || "");
    const [localName, setLocalName] = useState(publication.name || "");

    // Prop szinkronizáció
    useEffect(() => {
        setLocalCoverageStart(publication.coverageStart || "");
        setLocalCoverageEnd(publication.coverageEnd || "");
        setLocalName(publication.name || "");
    }, [publication.coverageStart, publication.coverageEnd, publication.name]);

    /** Coverage mező mentése (Enter/blur). */
    const handleCoverageSave = (field, localValue) => () => {
        if (!onFieldUpdate) return;
        const value = parseInt(localValue, 10);
        onFieldUpdate(field, isNaN(value) ? null : value);
    };

    /** Név mentése (Enter/blur). */
    const handleNameSave = (e) => {
        const value = e?.target?.value ?? localName;
        if (value && value !== publication.name && onFieldUpdate) {
            onFieldUpdate("name", value);
        }
    };

    return (
        <CollapsibleSection
            title="ÁLTALÁNOS"
            showDivider={false}
            storageKey={STORAGE_KEYS.SECTION_PUBLICATION_GENERAL_COLLAPSED}
        >
            <div style={{ display: "flex", flexDirection: "column" }}>
                {/* Terjedelem + Név sor */}
                <div style={{ display: "flex" }}>
                    <div style={{ flex: 1, marginRight: "8px" }}>
                        <sp-label>Kezdő</sp-label>
                        <ValidatedTextField
                            id="pub-coverage-start"
                            type="number"
                            value={localCoverageStart}
                            onInput={(e) => setLocalCoverageStart(e.target.value)}
                            onValidate={handleCoverageSave("coverageStart", localCoverageStart)}
                            style={{ width: "100%" }}
                        />
                    </div>
                    <div style={{ flex: 1, marginRight: "8px" }}>
                        <sp-label>Utolsó</sp-label>
                        <ValidatedTextField
                            id="pub-coverage-end"
                            type="number"
                            value={localCoverageEnd}
                            onInput={(e) => setLocalCoverageEnd(e.target.value)}
                            onValidate={handleCoverageSave("coverageEnd", localCoverageEnd)}
                            style={{ width: "100%" }}
                        />
                    </div>
                    <div style={{ flex: 4 }}>
                        <sp-label>Név</sp-label>
                        <ValidatedTextField
                            id="pub-name-field"
                            type="text"
                            value={localName}
                            onInput={(e) => setLocalName(e.target.value)}
                            onValidate={handleNameSave}
                            style={{ width: "100%" }}
                        />
                    </div>
                </div>

                {/* Gyökérkönyvtár */}
                {publication.rootPath && (
                    <div style={{ marginTop: "12px" }}>
                        <sp-detail style={{ marginBottom: "4px" }}>GYÖKÉRKÖNYVTÁR</sp-detail>
                        <sp-body style={{ wordBreak: "break-all" }}>{publication.rootPath}</sp-body>
                    </div>
                )}
            </div>
        </CollapsibleSection>
    );
};
