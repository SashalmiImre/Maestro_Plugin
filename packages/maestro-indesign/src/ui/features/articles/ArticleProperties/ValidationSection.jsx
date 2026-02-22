import React, { useState, useMemo, useEffect } from "react";

// Contexts
import { useUser } from "../../../../core/contexts/UserContext.jsx";
import { useToast } from "../../../common/Toast/ToastContext.jsx";

// Hooks
import { useUnifiedValidation } from "../../../../data/hooks/useUnifiedValidation.js";
import { useTeamMembers } from "../../../../data/hooks/useTeamMembers.js";

// Components
import { CollapsibleSection } from "../../../common/CollapsibleSection.jsx";
import { CustomCheckbox } from "../../../common/CustomCheckbox.jsx";
import { CustomDropdown } from "../../../common/CustomDropdown.jsx";

// Utils
import { STORAGE_KEYS } from "../../../../core/utils/constants.js";
import {
    RECIPIENT_TYPES,
    RECIPIENT_TYPE_LABELS,
    VALIDATION_TYPES,
    VALIDATION_TYPE_CONFIG,
    getRecipientName,
    getSenderName,
    formatMessageDate,
    formatExactDate
} from "../../../../core/utils/messageConstants.js";
import { TEAMS } from "../../../../core/config/appwriteConfig.js";

// ── Icons & Styles ───────────────────────────────────────────────────────────

const StatusIcon = ({ type }) => {
    const config = VALIDATION_TYPE_CONFIG[type] || VALIDATION_TYPE_CONFIG.INFO;

    // Simple SVG icons
    const icons = {
        [VALIDATION_TYPES.ERROR]: (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="12" r="10" fill="white" fillOpacity="0.3" />
                <path d="M8 8l8 8M16 8l-8 8" stroke="white" strokeWidth="2" strokeLinecap="round" />
            </svg>
        ),
        [VALIDATION_TYPES.WARNING]: (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="12" r="10" fill="white" fillOpacity="0.3" />
                <path d="M12 8v5" stroke="white" strokeWidth="2" strokeLinecap="round" />
                <circle cx="12" cy="16" r="1.2" fill="white" />
            </svg>
        ),
        [VALIDATION_TYPES.INFO]: (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="12" r="10" fill="white" fillOpacity="0.3" />
                <path d="M12 16v-4" stroke="white" strokeWidth="2" strokeLinecap="round" />
                <circle cx="12" cy="8" r="1.2" fill="white" />
            </svg>
        ),
        [VALIDATION_TYPES.SUCCESS]: (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="12" r="10" fill="white" fillOpacity="0.3" />
                <path d="M8 12l3 3 6-6" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
        )
    };

    return (
        <div style={{ flexShrink: 0, marginRight: "8px", marginTop: "1px", display: "flex", alignItems: "center" }}>
            {icons[type] || icons[VALIDATION_TYPES.INFO]}
        </div>
    );
};

/** Preflight hierarchikus renderelés */
const renderPreflightBlock = (text, index, cardStyle) => {
    const lines = text.split("\n");

    return (
        <div key={`preflight-${index}`} style={cardStyle}>
            <StatusIcon type={VALIDATION_TYPES.ERROR} />
            <div style={{ flex: 1 }}>
                {lines.map((line, i) => {
                    const trimmed = line.trimStart();
                    const indent = line.length - trimmed.length;

                    // Oldalszám (0 behúzás) — félkövér
                    if (indent === 0) {
                        return (
                            <div key={i} style={{ fontSize: "12px", fontWeight: "bold", marginTop: i > 0 ? "4px" : 0 }}>
                                {trimmed}
                            </div>
                        );
                    }

                    // Kategória (4) vagy Típus (8+) — növekvő behúzással
                    const ml = indent <= 4 ? 12 : 24;
                    return (
                        <div key={i} style={{ fontSize: "11px", marginLeft: `${ml}px`, opacity: 0.9 }}>
                            {trimmed}
                        </div>
                    );
                })}
            </div>
        </div>
    );
};

// ── ValidationItem Component ───────────────────────────────────────────────────

const ValidationItem = ({ item, index, teamMembers, onSolve, onDowngrade, isDarkTheme }) => {
    const [isHovered, setIsHovered] = useState(false);
    const config = VALIDATION_TYPE_CONFIG[item.type] || VALIDATION_TYPE_CONFIG.INFO;
    const isResolved = item.isResolved;

    const hexToRgba = (hex, alpha) => {
        let r = 0, g = 0, b = 0;
        if (hex.length === 4) {
            r = parseInt("0x" + hex[1] + hex[1]);
            g = parseInt("0x" + hex[2] + hex[2]);
            b = parseInt("0x" + hex[3] + hex[3]);
        } else if (hex.length === 7) {
            r = parseInt("0x" + hex[1] + hex[2]);
            g = parseInt("0x" + hex[3] + hex[4]);
            b = parseInt("0x" + hex[5] + hex[6]);
        }
        return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    };

    // Style logic:
    // If resolved: base opacity depends on theme (Dark: 0.1, Light: 0.25), hover opacity 1.
    const baseAlpha = isDarkTheme ? 0.1 : 0.25;
    const currentAlpha = isResolved ? (isHovered ? 1 : baseAlpha) : 1;
    const bgColor = isResolved ? hexToRgba(config.color, currentAlpha) : config.color;
    const fgColor = "white";

    // Preflight special render
    if (item.source === 'preflight' && item.message.includes('\n')) {
        return renderPreflightBlock(item.message, index, {
            backgroundColor: config.color, // Preflight is usually active, so opaque. If it could be resolved, we'd apply logic here too.
            color: "white",
            padding: "8px 12px",
            borderRadius: "4px",
            display: "flex",
            alignItems: "flex-start",
            marginBottom: "8px",
            opacity: 1 // Preflight items are rarely 'resolved' in this UI, they disappear.
        });
    }

    return (
        <div
            style={{
                backgroundColor: bgColor,
                color: fgColor,
                padding: "8px 12px",
                borderRadius: "4px",
                border: "none",
                marginBottom: "8px"
            }}
            onMouseEnter={() => setIsHovered(true)}
            onMouseLeave={() => setIsHovered(false)}
        >
            <div style={{ display: "flex", alignItems: "flex-start" }}>
                <StatusIcon type={isResolved ? VALIDATION_TYPES.SUCCESS : item.type} />

                <div style={{ flex: 1 }}>
                    {/* Header: Sender -> Recipient | Date */}
                    <div style={{ fontSize: "11px", marginBottom: "2px", opacity: 0.8, display: "flex", justifyContent: "space-between" }}>
                        <span>
                            {item.isSystem ?
                                (item.source === 'system_override' ? 'Rendszer (Visszaminősítve)' : 'Rendszer') :
                                `${getSenderName(item, teamMembers)} → ${getRecipientName(item, teamMembers)}`
                            }
                        </span>
                        <span>{formatMessageDate(item.createdAt)}</span>
                    </div>

                    {/* Message Body */}
                    <div style={{ fontSize: "12px", fontWeight: "500", whiteSpace: "pre-wrap" }}>
                        {item.description || item.message}
                    </div>

                    {/* Solved Info */}
                    {isResolved && item.resolvedBy && (
                        <div style={{ fontSize: "11px", marginTop: "4px", fontStyle: "italic" }}>
                            Megoldotta: {getSenderName({ createdBy: item.resolvedBy }, teamMembers)}, {formatExactDate(item.resolvedAt)}
                        </div>
                    )}
                </div>

                {/* Actions */}
                <div style={{ marginLeft: "8px" }}>
                    {/* System Error -> Warning (Downgrade) */}
                    {item.isSystem && item.type === VALIDATION_TYPES.ERROR && item.contextId && (
                        <sp-action-button size="s" quiet onClick={() => onDowngrade(item)} title="Hiba visszaminősítése figyelmeztetéssé">
                            <svg slot="icon" viewBox="0 0 18 18"><path d="M9 13.5a.75.75 0 0 1-.75-.75V8.25a.75.75 0 0 1 1.5 0v4.5A.75.75 0 0 1 9 13.5zm0-7.5a.75.75 0 1 1 .75.75A.75.75 0 0 1 9 6zM9 1.5a7.5 7.5 0 1 0 7.5 7.5A7.5 7.5 0 0 0 9 1.5z" /></svg>
                        </sp-action-button>
                    )}

                    {/* User Message -> Solved */}
                    {!item.isSystem && !isResolved && (
                        <sp-button size="s" variant="primary" quiet onClick={() => onSolve(item)} title="Megoldva">
                            ✓
                        </sp-button>
                    )}
                </div>
            </div>
        </div>
    );
};

export const ValidationSection = ({ article, disabled }) => {
    const { user } = useUser();
    const { unifiedList, isLoading, addValidation, resolveValidation, downgradeSystemError } = useUnifiedValidation(article);
    const { showToast } = useToast();

    // Team members for recicipient helpers
    const { members: editors } = useTeamMembers(TEAMS.EDITORS);
    const { members: designers } = useTeamMembers(TEAMS.DESIGNERS);
    const { members: imageEditors } = useTeamMembers(TEAMS.IMAGE_EDITORS);
    const { members: writers } = useTeamMembers(TEAMS.WRITERS);
    const teamMembers = useMemo(() => ({ editors, designers, imageEditors, writers }), [editors, designers, imageEditors, writers]);

    // UI States
    const [newItemType, setNewItemType] = useState(VALIDATION_TYPES.ERROR);
    const [selectedRecipient, setSelectedRecipient] = useState('');
    const [description, setDescription] = useState('');
    const [isSending, setIsSending] = useState(false);

    // Filter state
    const [showSolved, setShowSolved] = useState(() => {
        try {
            return localStorage.getItem(STORAGE_KEYS.SHOW_SOLVED_VALIDATIONS) === 'true';
        } catch { return false; }
    });

    useEffect(() => {
        localStorage.setItem(STORAGE_KEYS.SHOW_SOLVED_VALIDATIONS, String(showSolved));
    }, [showSolved]);

    const filteredList = useMemo(() => {
        return unifiedList.filter(item => showSolved || !item.isResolved);
    }, [unifiedList, showSolved]);

    const hasItems = filteredList.length > 0;


    // Theme detection
    const [isDarkTheme, setIsDarkTheme] = useState(
        window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
    );

    useEffect(() => {
        if (!window.matchMedia) return;

        const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
        const handleChange = (e) => setIsDarkTheme(e.matches);

        // Modern browsers
        if (mediaQuery.addEventListener) {
            mediaQuery.addEventListener('change', handleChange);
        } else {
            // Deprecated fallback
            mediaQuery.addListener(handleChange);
        }

        return () => {
            if (mediaQuery.removeEventListener) {
                mediaQuery.removeEventListener('change', handleChange);
            } else {
                mediaQuery.removeListener(handleChange);
            }
        };
    }, []);

    // ── Handlers ───────────────────────────────────────────────────────────────

    const handleSend = async () => {
        if (!selectedRecipient) {
            showToast('Hiányzó címzett', 'warning');
            return;
        }

        setIsSending(true);
        try {
            const isGroup = Object.keys(RECIPIENT_TYPE_LABELS).includes(selectedRecipient);
            await addValidation({
                recipientType: isGroup ? selectedRecipient : RECIPIENT_TYPES.USER,
                recipientUserId: isGroup ? null : selectedRecipient,
                description: description.trim(),
                type: newItemType,
                createdBy: user.$id
            });

            showToast('Bejegyzés rögzítve', 'success');
            setDescription('');
            // Reset to default
            setNewItemType(VALIDATION_TYPES.ERROR);
        } catch (e) {
            showToast('Hiba a küldéskor', 'error', e.message);
        } finally {
            setIsSending(false);
        }
    };

    const handleSolve = async (item) => {
        await resolveValidation(item.$id, user.$id);
    };

    const handleDowngrade = async (item) => {
        if (!item.contextId) return;
        try {
            await downgradeSystemError(item, user.$id);
            showToast('Hiba visszaminősítve', 'success');
        } catch (e) {
            showToast('Nem sikerült visszaminősíteni', 'error', e.message);
        }
    };

    // ── Render Helpers ─────────────────────────────────────────────────────────

    const recipientOptions = useMemo(() => {
        const groupItems = Object.entries(RECIPIENT_TYPE_LABELS)
            .filter(([key]) => key !== RECIPIENT_TYPES.USER)
            .map(([key, label]) => ({ id: key, name: label }));

        // Deduplicate users
        const allUsers = [
            ...editors.map(m => ({ ...m, role: 'Szerkesztő' })),
            ...designers.map(m => ({ ...m, role: 'Tervező' })),
            ...imageEditors.map(m => ({ ...m, role: 'Képszerkesztő' }))
        ];
        const uniqueUsers = allUsers.filter((u, i, a) => a.findIndex(x => x.userId === u.userId) === i);

        const memberItems = uniqueUsers.map(m => ({
            id: m.userId,
            name: `${m.userName} (${m.role})`
        }));

        return { groups: groupItems, members: memberItems };
    }, [editors, designers, imageEditors]);


    // ── JSX ────────────────────────────────────────────────────────────────────

    return (
        <CollapsibleSection
            title="VALIDÁCIÓ ÉS ÜZENETEK"
            showDivider={true}
            storageKey={STORAGE_KEYS.SECTION_VALIDATION_COLLAPSED}
        >
            <div style={{ display: "flex", flexDirection: "column" }}>

                {/* 1. Új bejegyzés panel */}
                <div style={{ padding: "12px", border: "0.5px solid var(--spectrum-alias-border-color-mid)", borderRadius: "6px", marginBottom: "12px" }}>
                    <div style={{ display: "flex", marginBottom: "8px" }}>
                        {/* Típus választó */}
                        <div style={{ flex: 3, marginRight: "8px", minWidth: 0 }}>
                            <CustomDropdown
                                value={newItemType}
                                onChange={setNewItemType}
                                placeholder="Típus"
                                disabled={disabled || undefined}
                                style={{ width: "100%" }}
                            >
                                <sp-menu slot="options">
                                    <sp-menu-item value={VALIDATION_TYPES.ERROR}>Hiba</sp-menu-item>
                                    <sp-menu-item value={VALIDATION_TYPES.WARNING}>Figyelmeztetés</sp-menu-item>
                                    <sp-menu-item value={VALIDATION_TYPES.INFO}>Infó</sp-menu-item>
                                </sp-menu>
                            </CustomDropdown>
                        </div>

                        {/* Címzett választó */}
                        <div style={{ flex: 5, minWidth: 0 }}>
                            <CustomDropdown
                                value={selectedRecipient}
                                onChange={setSelectedRecipient}
                                placeholder="Címzett..."
                                disabled={disabled || undefined}
                                style={{ width: "100%" }}
                            >
                                <sp-menu slot="options">
                                    {recipientOptions.groups.map(g => <sp-menu-item key={g.id} value={g.id}>{g.name}</sp-menu-item>)}
                                    <sp-menu-divider></sp-menu-divider>
                                    {recipientOptions.members.map(m => <sp-menu-item key={m.id} value={m.id}>{m.name}</sp-menu-item>)}
                                </sp-menu>
                            </CustomDropdown>
                        </div>
                    </div>

                    <div style={{ display: "flex" }}>
                        <sp-textfield
                            placeholder="Írd le a problémát..."
                            value={description}
                            onInput={(e) => setDescription(e.target.value)}
                            disabled={disabled || undefined}
                            style={{ flex: 1, marginRight: "8px" }}
                        ></sp-textfield>

                        <sp-button
                            variant="primary"
                            onClick={handleSend}
                            disabled={disabled || isSending ? true : undefined}
                        >
                            Küldés
                        </sp-button>
                    </div>
                </div>

                {/* 2. Szűrő */}
                <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: "12px" }}>
                    <CustomCheckbox checked={showSolved} onChange={() => setShowSolved(!showSolved)}>
                        Megoldottak megjelenítése
                    </CustomCheckbox>
                </div>

                {/* 3. Lista */}
                <div style={{ display: "flex", flexDirection: "column" }}>
                    {!hasItems && (
                        <div style={{ textAlign: "center", padding: "20px", color: "var(--spectrum-alias-text-color-disabled)" }}>
                            Nincs aktív validációs bejegyzés
                        </div>
                    )}

                    {filteredList.map((item, index) => (
                        <ValidationItem
                            key={item.$id || `sys-${index}`}
                            item={item}
                            index={index}
                            teamMembers={teamMembers}
                            onSolve={handleSolve}
                            onDowngrade={handleDowngrade}
                            isDarkTheme={isDarkTheme}
                        />
                    ))}
                </div>
            </div>
        </CollapsibleSection>
    );
};
