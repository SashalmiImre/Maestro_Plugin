import React, { useState, useMemo, useRef, useCallback, useEffect } from "react";
import { WorkflowStatus } from "../publications/Publication/WorkflowStatus.jsx";
import { useTeamMembers } from "../../../data/hooks/useTeamMembers.js";
import { useUrgency } from "../../../data/hooks/useUrgency.js";
import { TEAMS } from "../../../core/config/appwriteConfig.js";
import { useUser } from "../../../core/contexts/UserContext.jsx";
import { CustomTable } from "../../common/Table/CustomTable.jsx";
import { useValidation } from "../../../core/contexts/ValidationContext.jsx";
import { useData } from "../../../core/contexts/DataContext.jsx";

export const ArticleTable = ({ articles, publication, onOpen, onShowProperties }) => {
    const { user: currentUser } = useUser();
    const { validationResults } = useValidation();
    const { validations, deadlines } = useData();
    const urgencyMap = useUrgency(articles, deadlines, publication);
    const [sortColumn, setSortColumn] = useState("startPage");
    const [sortDirection, setSortDirection] = useState("asc");
    const clickTimerRef = useRef(null);

    useEffect(() => {
        return () => {
            if (clickTimerRef.current) {
                clearTimeout(clickTimerRef.current);
                clickTimerRef.current = null;
            }
        };
    }, []);

    const { members: editors } = useTeamMembers(TEAMS.EDITORS);
    const { members: designers } = useTeamMembers(TEAMS.DESIGNERS);
    const { members: writers } = useTeamMembers(TEAMS.WRITERS);
    const { members: imageEditors } = useTeamMembers(TEAMS.IMAGE_EDITORS);

    const combinedMembers = useMemo(() => {
        return [...editors, ...designers, ...writers, ...imageEditors];
    }, [editors, designers, writers, imageEditors]);

    const getUserName = useCallback((userId) => {
        if (!userId) return null;
        const found = combinedMembers.find(m => m.userId === userId);
        return found ? found.userName : "Más";
    }, [combinedMembers]);

    const getLockLabel = useCallback((article) => {
        if (!article.lockOwnerId) return null;
        if (article.lockType === "system") return "Maestro";
        if (article.lockOwnerId === currentUser?.$id) return "Én";
        return getUserName(article.lockOwnerId);
    }, [currentUser, getUserName]);

    /**
     * Összegyűjti egy cikk összes aktív (nem megoldott) validációs elemét
     * mindkét forrásból: rendszer (ValidationContext) + felhasználói (DataContext).
     */
    const getAllActiveItems = useCallback((articleId) => {
        const systemItems = validationResults.get(articleId) || [];

        const userItems = validations
            .filter(v => v.articleId === articleId && !v.isResolved)
            .map(v => ({
                type: v.type || 'info',
                message: v.description || v.message || '',
                source: v.source || 'user',
                createdAt: v.createdAt || v.$createdAt
            }));

        return [...systemItems, ...userItems].filter(i => !i.isResolved);
    }, [validationResults, validations]);

    /**
     * Visszaadja a cikk validációs súlyát a rendezéshez.
     * 2 = error, 1 = warning, 0 = ok
     */
    const getValidationSeverity = useCallback((article) => {
        const activeItems = getAllActiveItems(article.$id);
        if (activeItems.some(i => i.type === 'error')) return 2;
        if (activeItems.some(i => i.type === 'warning')) return 1;
        return 0;
    }, [getAllActiveItems]);

    const formatPageRange = useCallback((start, end) => {
        if (!start) return "";
        const maxPage = publication?.coverageEnd || 999;
        const padding = String(maxPage).length;
        const pad = (n) => String(n).padStart(padding, '0');
        const startStr = pad(start);
        if (end && end !== start) {
            return `${startStr}–${pad(end)} `;
        }
        return startStr;
    }, [publication]);

    const columns = useMemo(() => [
        {
            id: "range",
            label: "Terj.",
            width: "12%",
            sortable: true,
            divider: true,
            renderCell: (article) => (
                <span style={{ fontSize: "11px", fontWeight: "bold", display: "block", fontFamily: 'Consolas, "Andale Mono", "Lucida Console", "Courier New", monospace' }}>
                    {formatPageRange(article.startPage, article.endPage)}
                </span>
            )
        },
        {
            id: "name",
            label: "Cikknév",
            width: "40%",
            sortable: true,
            renderCell: (article) => (article.name || <span style={{ fontStyle: "italic", color: "red" }}>Névtelen</span>)
        },
        {
            id: "lock",
            label: "Zárolta",
            width: "20%",
            sortable: true,
            renderCell: (article) => {
                const lockLabel = getLockLabel(article);
                return lockLabel && (
                    <span style={{ fontSize: "10px", fontWeight: "bold", textTransform: "uppercase", display: "block" }}>
                        {lockLabel.toUpperCase()}
                    </span>
                );
            }
        },
        {
            id: "state",
            label: "Státusz",
            width: "15%",
            sortable: true,
            renderCell: (article) => <WorkflowStatus article={article} />
        },
        {
            id: "validator",
            label: <span title="Validátor eredmények">⚠</span>,
            width: "10%",
            sortable: true,
            align: "center",
            renderCell: (article) => {
                const activeItems = getAllActiveItems(article.$id);
                if (activeItems.length === 0) return null;

                const hasErrors = activeItems.some(i => i.type === 'error');
                const hasWarnings = activeItems.some(i => i.type === 'warning');

                const tooltip = activeItems.map(i => {
                    const prefix = i.type === 'error' ? (i.source === 'user' ? '[Gond]' : '[Hiba]') : (i.source === 'user' ? '[Infó]' : '[Figy.]');
                    return `${prefix} ${i.message}`;
                }).join('\n');

                return (
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "4px" }} title={tooltip}>
                        {hasErrors && (
                            <svg width="14" height="14" viewBox="0 0 14 14" style={{ cursor: "default", flexShrink: 0 }}>
                                <circle cx="7" cy="7" r="6" fill="var(--spectrum-global-color-red-600)" />
                                <path d="M4.5 4.5l5 5M9.5 4.5l-5 5" stroke="white" strokeWidth="1.5" strokeLinecap="round" />
                            </svg>
                        )}
                        {hasWarnings && (
                            <svg width="14" height="14" viewBox="0 0 14 14" style={{ cursor: "default", flexShrink: 0 }}>
                                <path d="M7 1L13 13H1L7 1Z" fill="var(--spectrum-global-color-orange-600)" />
                                <path d="M7 5.5v3" stroke="white" strokeWidth="1.5" strokeLinecap="round" />
                                <circle cx="7" cy="10.5" r="0.8" fill="white" />
                            </svg>
                        )}
                    </div>
                );
            }
        }
    ], [formatPageRange, getLockLabel, getAllActiveItems]);

    const sortedArticles = useMemo(() => {
        const sorted = [...articles];
        sorted.sort((a, b) => {
            let valA, valB;

            switch (sortColumn) {
                case "range":
                    valA = a.startPage || 999999;
                    valB = b.startPage || 999999;
                    break;
                case "name":
                    valA = a.name ? a.name.toLowerCase() : "";
                    valB = b.name ? b.name.toLowerCase() : "";
                    break;
                case "lock":
                    valA = getLockLabel(a) || "";
                    valB = getLockLabel(b) || "";
                    break;
                case "state":
                    valA = a.state || 0;
                    valB = b.state || 0;
                    break;
                case "validator":
                    valA = getValidationSeverity(a);
                    valB = getValidationSeverity(b);
                    break;
                default:
                    valA = a[sortColumn];
                    valB = b[sortColumn];
            }

            if (valA < valB) return sortDirection === "asc" ? -1 : 1;
            if (valA > valB) return sortDirection === "asc" ? 1 : -1;

            if (sortColumn !== "name") {
                const nameA = a.name ? a.name.toLowerCase() : "";
                const nameB = b.name ? b.name.toLowerCase() : "";
                if (nameA < nameB) return -1;
                if (nameA > nameB) return 1;
            }

            return 0;
        });

        return sorted;
    }, [articles, sortColumn, sortDirection, getLockLabel, getValidationSeverity]);

    const handleSort = (column) => {
        if (sortColumn === column) {
            setSortDirection(prev => prev === "asc" ? "desc" : "asc");
        } else {
            setSortColumn(column);
            setSortDirection("asc");
        }
    };

    const handleRowClick = (article) => {
        if (clickTimerRef.current) {
            clearTimeout(clickTimerRef.current);
        }
        clickTimerRef.current = setTimeout(() => {
            onShowProperties?.(article, 'article');
            clickTimerRef.current = null;
        }, 250);
    };

    /** Sürgősség alapú sor háttér (progresszív gradient) */
    const getRowStyle = useCallback((article) => {
        const urgency = urgencyMap.get(article.$id);
        if (!urgency?.background) return undefined;
        return { background: urgency.background };
    }, [urgencyMap]);

    const handleRowDoubleClick = (article) => {
        if (clickTimerRef.current) {
            clearTimeout(clickTimerRef.current);
            clickTimerRef.current = null;
        }
        onOpen?.(article);
    };

    return (
        <CustomTable
            columns={columns}
            data={sortedArticles}
            sortColumn={sortColumn}
            sortDirection={sortDirection}
            onSort={handleSort}
            onRowClick={handleRowClick}
            onRowDoubleClick={handleRowDoubleClick}
            getRowStyle={getRowStyle}
        />
    );
};
