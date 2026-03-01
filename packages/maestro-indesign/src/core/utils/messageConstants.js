/**
 * @fileoverview Üzenetkezelő rendszer konstansai és segédfüggvényei.
 * Definiálja a címzett típusokat és formázó függvényeket az üzenetekhez.
 * 
 * @module utils/messageConstants
 */

// Címzett típusok
export const RECIPIENT_TYPES = {
    USER: 'user', // Egy konkrét felhasználó
    ALL_DESIGNERS: 'all_designers', // Minden tervező
    ALL_EDITORS: 'all_editors', // Minden szerkesztő
    ALL_IMAGE_EDITORS: 'all_image_editors' // Minden képszerkesztő
};

// Címzett típusok megnevezései (Magyarul)
export const RECIPIENT_TYPE_LABELS = {
    [RECIPIENT_TYPES.USER]: 'Egyéni címzett',
    [RECIPIENT_TYPES.ALL_DESIGNERS]: 'Összes tervező',
    [RECIPIENT_TYPES.ALL_EDITORS]: 'Összes szerkesztő',
    [RECIPIENT_TYPES.ALL_IMAGE_EDITORS]: 'Összes képszerkesztő'
};

// Validáció / Üzenet típusok
export const VALIDATION_TYPES = {
    ERROR: 'error',
    WARNING: 'warning',
    INFO: 'info',
    SUCCESS: 'success' // pl. "Megoldva" állapothoz
};

// Validáció / Üzenet típusok megjelenítése (címke, szín)
export const VALIDATION_TYPE_CONFIG = {
    [VALIDATION_TYPES.ERROR]: { label: 'Hiba', color: '#d7373f', icon: 'Alert' },
    [VALIDATION_TYPES.WARNING]: { label: 'Figyelmeztetés', color: '#e68619', icon: 'Alert' },
    [VALIDATION_TYPES.INFO]: { label: 'Információ', color: '#2680eb', icon: 'Info' },
    [VALIDATION_TYPES.SUCCESS]: { label: 'Megoldva', color: '#2d9d78', icon: 'Checkmark' }
};

/**
 * Visszaadja a címzett megjelenítendő nevét.
 * Ha konkrét felhasználó a címzett, megkeresi a nevét a csapatlistában.
 * Ha csoportnak szól (pl. Minden szerkesztő), akkor a csoport nevét adja vissza.
 * 
 * @param {object} message - Az üzenet objektum.
 * @param {object} teamMembers - Objektum a csapattagokkal { editors, designers, imageEditors, writers }.
 * @returns {string} - A címzett megjelenítendő neve.
 */
export function getRecipientName(message, teamMembers = {}) {
    if (message.recipientType === RECIPIENT_TYPES.USER && message.recipientUserId) {
        // Felhasználó keresése az összes csapatban
        const allMembers = [
            ...(teamMembers.editors || []),
            ...(teamMembers.designers || []),
            ...(teamMembers.imageEditors || []),
            ...(teamMembers.writers || [])
        ];
        
        const user = allMembers.find(m => m.userId === message.recipientUserId);
        return user?.userName || user?.userEmail || 'Ismeretlen felhasználó';
    }
    
    return RECIPIENT_TYPE_LABELS[message.recipientType] || 'Ismeretlen';
}

/**
 * Visszaadja a feladó megjelenítendő nevét.
 * Megkeresi a feladó nevét a csapatlistában az üzenet `createdBy` ID-ja alapján.
 * 
 * @param {object} message - Az üzenet objektum.
 * @param {object} teamMembers - Objektum a csapattagokkal { editors, designers, imageEditors, writers }.
 * @returns {string} - A feladó megjelenítendő neve.
 */
export function getSenderName(message, teamMembers = {}) {
    const allMembers = [
        ...(teamMembers.editors || []),
        ...(teamMembers.designers || []),
        ...(teamMembers.imageEditors || []),
        ...(teamMembers.writers || [])
    ];
    
    const user = allMembers.find(m => m.userId === message.createdBy);
    return user?.userName || user?.userEmail || 'Ismeretlen feladó';
}

/**
 * Dátum formázása relatív módon megjelenítéshez (pl. "2 órája", "Most").
 * Ha 7 napnál régebbi, akkor a pontos dátumot adja vissza rövid formátumban.
 * 
 * @param {string} dateString - ISO dátum string (pl. "2023-01-01T12:00:00.000Z").
 * @returns {string} - Formázott dátum string.
 */
export function formatMessageDate(dateString) {
    if (!dateString) return '';
    
    const date = new Date(dateString);
    if (isNaN(date.getTime())) return '';
    
    const now = new Date();
    const diffMs = now - date;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);
    
    if (diffMins < 1) return 'Most';
    if (diffMins < 60) return `${diffMins} perce`;
    if (diffHours < 24) return `${diffHours} órája`;
    if (diffDays < 7) return `${diffDays} napja`;
    
    return date.toLocaleDateString('hu-HU', {
        year: 'numeric',
        month: 'short',
        day: 'numeric'
    });
}

/**
 * Pontos dátum és idő formázása (pl. tooltiphez).
 * 
 * @param {string} dateString - ISO dátum string.
 * @returns {string} - Formázott dátum és idő (pl. "2023. január 1. 12:30").
 */
export function formatExactDate(dateString) {
    if (!dateString) return '';
    
    const date = new Date(dateString);
    if (isNaN(date.getTime())) return '';

    return date.toLocaleString('hu-HU', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });
}
