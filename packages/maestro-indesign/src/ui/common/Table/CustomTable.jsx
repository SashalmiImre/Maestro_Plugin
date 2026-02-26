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
        minWidth: "100%",
        contain: "layout style"
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

// -- MEMOIZED ROW --
/**
 * Egyedi comparator a TableRow-hoz.
 * A columns/columnWidths/callback referenciák minden renderben újak,
 * ezért az item $updatedAt mezőjét + a rowStyle.background-ot hasonlítjuk.
 * Ha az item adata nem változott és a háttérszín sem, kihagyjuk a renderelést.
 *
 * renderVersion: a szülő által kezelt escape-hatch — ha a renderCell closure-ok
 * megváltoztak (pl. új context adat), a szülő ezt a számot lépteti, ami kikényszeríti
 * az újrarenderelést még akkor is, ha az item $updatedAt-ja nem változott.
 */
const areRowPropsEqual = (prev, next) => {
    if (prev.item !== next.item) {
        // Referencia változott — ellenőrizzük az $updatedAt-ot
        if (prev.item.$updatedAt !== next.item.$updatedAt) return false;
        if (prev.item.$id !== next.item.$id) return false;
    }
    // Háttérszín változott? (sürgősség frissítés)
    if (prev.rowStyle?.background !== next.rowStyle?.background) return false;
    // Oszlopszélesség változott? (resize)
    if (prev.columnWidths !== next.columnWidths) return false;
    // renderCell closure-ok megváltoztak? (szülő által jelzett escape-hatch)
    if (prev.renderVersion !== next.renderVersion) return false;
    return true;
};

const TableRow = React.memo(({
    item,
    columns,
    columnWidths,
    rowStyle,
    onRowClick,
    onRowDoubleClick,
    onMouseEnter,
    onMouseLeave,
    renderVersion  // csak az areRowPropsEqual comparator használja // eslint-disable-line no-unused-vars
}) => (
    <div
        role="row"
        style={rowStyle}
        onClick={() => onRowClick && onRowClick(item)}
        onDoubleClick={() => onRowDoubleClick && onRowDoubleClick(item)}
        onMouseEnter={onMouseEnter}
        onMouseLeave={onMouseLeave}
    >
        {columns.map(col => {
            const content = col.renderCell ? col.renderCell(item) : item[col.id];
            const titleVal = (typeof content === 'string' || typeof content === 'number') ? content : "";
            const width = columnWidths[col.id] || col.width;

            return (
                <div
                    key={col.id}
                    role="cell"
                    aria-label={titleVal ? undefined : col.label}
                    style={{
                        ...STYLES.cell,
                        width,
                        justifyContent: col.align === "right" ? "flex-end" : col.align === "center" ? "center" : "flex-start",
                        textAlign: col.align || "left"
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
), areRowPropsEqual);

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
 * @param {Function} [props.getRowStyle] - (item) => style object — egyedi sor stílushoz (pl. sürgősség színkódolás)
 * @param {number|string} [props.renderVersion] - Escape-hatch: a szülő lépteti, ha a renderCell
 *   closure-ok megváltoztak (pl. új context adat), kikényszerítve az összes sor újrarenderelését.
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
    getRowStyle,
    renderVersion,
    style
}) => {
    const { columnWidths, handleResizeStart } = useColumnResize();

    const handleRowMouseEnter = React.useCallback((e) => {
        // backgroundColor a gradient ALÁ kerül — mindkettő látszódik
        e.currentTarget.style.backgroundColor = "rgba(0, 0, 0, 0.06)";
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
                        data.map((item, rowIndex) => {
                            const customRowStyle = getRowStyle ? getRowStyle(item) : undefined;
                            const rowStyle = customRowStyle
                                ? { ...STYLES.row, ...customRowStyle }
                                : STYLES.row;

                            return (
                                <TableRow
                                    key={item.id || item.$id || rowIndex}
                                    item={item}
                                    columns={columns}
                                    columnWidths={columnWidths}
                                    rowStyle={rowStyle}
                                    onRowClick={onRowClick}
                                    onRowDoubleClick={onRowDoubleClick}
                                    onMouseEnter={handleRowMouseEnter}
                                    onMouseLeave={handleRowMouseLeave}
                                    renderVersion={renderVersion}
                                />
                            );
                        })
                    )}
                </div>
            </div>
        </div>
    );
};
