import React from "react";

// -- CONSTANTS --
const MIN_COLUMN_WIDTH = 50;
const EMPTY_MESSAGE = "Nincsenek adatok";

// -- STYLES --
const STYLES = {
    container: {
        display: "flex",
        flexDirection: "column",
        height: "100%",
        width: "100%",
        overflow: "hidden"
    },
    headerRow: {
        display: "flex",
        zIndex: 10,
        minWidth: "100%",
        flex: "0 0 auto",
        position: "relative",
        borderBottom: "1px solid rgba(128, 128, 128, 0.3)"
    },
    headerCell: {
        padding: "8px 8px",
        textTransform: "uppercase",
        letterSpacing: "0.05em",
        display: "flex",
        alignItems: "center",
        cursor: "pointer",
        userSelect: "none",
        boxSizing: "border-box",
        flexShrink: 0,
        overflow: "hidden"
    },
    headerContent: {
        display: "flex",
        alignItems: "center",
        width: "100%",
        height: "100%",
        justifyContent: "inherit",
        position: "relative"
    },
    headerLabel: {
        marginRight: "4px",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap"
    },
    sortIcon: {
        fontSize: "10px",
        color: "var(--spectrum-alias-icon-color, var(--spectrum-global-color-gray-600))"
    },
    resizeHandle: {
        position: "absolute",
        right: "-4px",
        top: 0,
        bottom: 0,
        width: "10px",
        cursor: "col-resize",
        zIndex: 10
    },
    bodyContainer: {
        flex: "1",
        overflowY: "auto",
        overflowX: "hidden",
        width: "100%",
        position: "relative"
    },
    bodyContent: {
        display: "flex",
        flexDirection: "column"
    },
    row: {
        display: "flex",
        alignItems: "center",
        borderBottom: "1px solid rgba(128, 128, 128, 0.2)",
        cursor: "default",
        minWidth: "100%"
    },
    emptyRow: {
        justifyContent: "center",
        padding: "24px"
    },
    emptyMessage: {
        color: "var(--spectrum-global-color-gray-600)"
    },
    cell: {
        padding: "4px 8px",
        display: "flex",
        alignItems: "center",
        boxSizing: "border-box",
        overflow: "hidden",
        whiteSpace: "nowrap",
        textOverflow: "ellipsis",
        flexShrink: 0,
        position: "relative"
    },
    cellContent: {
        flex: 1,
        minWidth: 0
    },
    cellBody: {
        display: "flex",
        alignItems: "center",
        width: "100%",
        justifyContent: "inherit",
        boxSizing: "border-box",
        margin: 0
    },
    divider: {
        position: "absolute",
        right: 0,
        top: "20%",
        bottom: "20%",
        width: "1px",
        backgroundColor: "rgba(128, 128, 128, 0.4)"
    }
};

// -- HELPER FUNCTIONS --
const getAlignmentStyle = (align) => ({
    justifyContent: align === "right" ? "flex-end" : align === "center" ? "center" : "flex-start",
    textAlign: align || "left"
});

// -- CUSTOM HOOK --
const useColumnResize = () => {
    const [columnWidths, setColumnWidths] = React.useState({});
    const resizingRef = React.useRef({ isResizing: false, handleMouseMove: null, handleMouseUp: null });

    React.useEffect(() => {
        return () => {
            if (resizingRef.current.isResizing) {
                document.removeEventListener("mousemove", resizingRef.current.handleMouseMove);
                document.removeEventListener("mouseup", resizingRef.current.handleMouseUp);
                document.body.style.cursor = "";
            }
        };
    }, []);

    const handleResizeStart = React.useCallback((e, columnId, startWidth) => {
        e.preventDefault();
        e.stopPropagation();

        const startX = e.pageX;

        const handleMouseMove = (moveEvent) => {
            const deltaX = moveEvent.pageX - startX;
            const newWidth = Math.max(MIN_COLUMN_WIDTH, startWidth + deltaX);
            setColumnWidths(prev => ({ ...prev, [columnId]: `${newWidth}px` }));
        };

        const handleMouseUp = () => {
            document.removeEventListener("mousemove", handleMouseMove);
            document.removeEventListener("mouseup", handleMouseUp);
            document.body.style.cursor = "";
            resizingRef.current = { isResizing: false, handleMouseMove: null, handleMouseUp: null };
        };

        resizingRef.current = { isResizing: true, handleMouseMove, handleMouseUp };
        document.addEventListener("mousemove", handleMouseMove);
        document.addEventListener("mouseup", handleMouseUp);
        document.body.style.cursor = "col-resize";
    }, []);

    return { columnWidths, handleResizeStart };
};

/**
 * CustomTable component
 * Replaces sp-table to avoid UXP rendering issues and provide better control.
 *
 * @param {Object} props
 * @param {Array} props.columns - Array of column definitions: { id, label, width, sortable, renderHeader, renderCell, align }
 * @param {Array} props.data - Array of data objects
 * @param {string} props.sortColumn - Current sort column ID
 * @param {string} props.sortDirection - "asc" or "desc"
 * @param {Function} props.onSort - (columnId) => void
 * @param {Function} props.onRowClick - (item) => void
 * @param {Function} props.onRowDoubleClick - (item) => void
 * @param {object} props.style - Container style overrides
 */
export const CustomTable = ({
    columns,
    data,
    sortColumn,
    sortDirection,
    onSort,
    onRowClick,
    onRowDoubleClick,
    style
}) => {
    const { columnWidths, handleResizeStart } = useColumnResize();

    const handleRowMouseEnter = React.useCallback((e) => {
        e.currentTarget.style.backgroundColor = "var(--spectrum-alias-highlight-hover)";
    }, []);

    const handleRowMouseLeave = React.useCallback((e) => {
        e.currentTarget.style.backgroundColor = "transparent";
    }, []);

    const handleResizeMouseEnter = React.useCallback((e) => {
        e.currentTarget.style.backgroundColor = "rgba(128,128,128,0.2)";
    }, []);

    const handleResizeMouseLeave = React.useCallback((e) => {
        e.currentTarget.style.backgroundColor = "transparent";
    }, []);

    return (
        <div role="table" style={{ ...STYLES.container, ...style }}>
            {/* FIXED HEADER */}
            <div role="rowgroup" style={STYLES.headerRow}>
                <div role="row" style={{ display: "contents" }}>
                    {columns.map(col => {
                        const isSorted = sortColumn === col.id;
                        const currentWidth = columnWidths[col.id] || col.width;
                        const alignmentStyle = getAlignmentStyle(col.align);

                        return (
                            <div
                                key={col.id}
                                role="columnheader"
                                aria-sort={isSorted ? (sortDirection === "asc" ? "ascending" : "descending") : undefined}
                                data-column-id={col.id}
                                style={{ ...STYLES.headerCell, width: currentWidth, ...alignmentStyle }}
                                onClick={() => col.sortable && onSort && onSort(col.id)}
                                title={col.title || col.label}
                            >
                                <div style={STYLES.headerContent}>
                                    <sp-detail style={STYLES.headerLabel}>
                                        {col.renderHeader ? col.renderHeader() : col.label}
                                    </sp-detail>

                                    {isSorted && (
                                        <span style={STYLES.sortIcon}>
                                            {sortDirection === "asc" ? "▲" : "▼"}
                                        </span>
                                    )}

                                    {/* Resize Handle */}
                                    <div
                                        style={STYLES.resizeHandle}
                                        onClick={(e) => e.stopPropagation()}
                                        onMouseDown={(e) => {
                                            const headerCell = e.currentTarget.closest('[data-column-id]');
                                            const rect = headerCell.getBoundingClientRect();
                                            handleResizeStart(e, col.id, rect.width);
                                        }}
                                        onMouseEnter={handleResizeMouseEnter}
                                        onMouseLeave={handleResizeMouseLeave}
                                    />
                                </div>
                            </div>
                        );
                    })}
                </div>
            </div>

            {/* SCROLLABLE BODY */}
            <div role="rowgroup" style={STYLES.bodyContainer}>
                <div style={STYLES.bodyContent}>
                    {data.length === 0 ? (
                        <div role="row" style={{ ...STYLES.row, ...STYLES.emptyRow }}>
                            <div role="cell" style={STYLES.emptyMessage} aria-colspan={columns.length}>{EMPTY_MESSAGE}</div>
                        </div>
                    ) : (
                        data.map((item, rowIndex) => (
                            <div
                                key={item.id || item.$id || rowIndex}
                                role="row"
                                style={STYLES.row}
                                onClick={() => onRowClick && onRowClick(item)}
                                onDoubleClick={() => onRowDoubleClick && onRowDoubleClick(item)}
                                onMouseEnter={handleRowMouseEnter}
                                onMouseLeave={handleRowMouseLeave}
                            >
                                {columns.map(col => {
                                    const content = col.renderCell ? col.renderCell(item) : item[col.id];
                                    const titleVal = (typeof content === 'string' || typeof content === 'number') ? content : "";
                                    const alignmentStyle = getAlignmentStyle(col.align);

                                    return (
                                        <div
                                            key={`${item.id || rowIndex}-${col.id}`}
                                            role="cell"
                                            aria-label={titleVal ? undefined : col.label}
                                            style={{
                                                ...STYLES.cell,
                                                width: columnWidths[col.id] || col.width,
                                                ...alignmentStyle
                                            }}
                                            title={titleVal}
                                        >
                                            <div style={STYLES.cellContent}>
                                                <sp-body style={STYLES.cellBody}>{content}</sp-body>
                                            </div>
                                            {col.divider && <div style={STYLES.divider} />}
                                        </div>
                                    );
                                })}
                            </div>
                        ))
                    )}
                </div>
            </div>
        </div>
    );
};
