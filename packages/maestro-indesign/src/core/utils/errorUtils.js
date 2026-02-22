/**
 * @fileoverview Hibakezelő segédfüggvények.
 * 
 * Segít megkülönböztetni a hálózati hibákat az API hibáktól,
 * és felhasználóbarát hibaüzeneteket generál.
 * 
 * @module utils/errorUtils
 */

/**
 * Eldönti egy hibáról, hogy hálózati/kapcsolati hiba-e, vagy API/szerver válasz.
 * 
 * - A hálózati hibáknál teljes képernyős overlay-t és újrapróbálkozást érdemes megjeleníteni.
 * - Az API hibáknál (pl. 404, 403) toast üzenetet kell mutatni a részletekkel.
 * 
 * @param {Error|Object} error - A vizsgálandó hiba objektum.
 * @returns {boolean} Igaz, ha hálózati hiba történt.
 */
export const isServerError = (error) => {
    if (!error) return false;

    if (error.code === 502 || error.code === 503 || error.code === 504) return true;

    const msg = typeof error.message === 'string' ? error.message.toLowerCase() : '';
    
    if (msg.includes('bad gateway')) return true;
    if (msg.includes('service unavailable')) return true;
    if (msg.includes('gateway timeout')) return true;
    
    // HTML válasz esetén (pl. Cloudflare hibaoldal 502-nél JSON helyett)
    if (msg.trim().startsWith('<!doctype html>')) return true;

    return false;
};

/**
 * Eldönti egy hibáról, hogy hitelesítési (authentication) hiba-e.
 *
 * A 401-es hibakód azt jelenti, hogy a munkamenet (session) lejárt vagy érvénytelen,
 * és a felhasználónak újra be kell jelentkeznie.
 *
 * @param {Error|Object} error - A vizsgálandó hiba objektum.
 * @returns {boolean} Igaz, ha hitelesítési hiba történt.
 */
export const isAuthError = (error) => {
    if (!error) return false;

    // Appwrite strukturált hibakód
    if (error.code === 401) return true;

    // Üzenet alapú detektálás (fallback)
    const msg = typeof error.message === 'string' ? error.message.toLowerCase() : '';
    if (msg.includes('unauthorized')) return true;
    if (msg.includes('user (role: guests) missing scope')) return true;
    if (msg.includes('session not found')) return true;

    return false;
};

export const isNetworkError = (error) => {
    if (!error) return false;

    // Timeout hibák a withTimeout segédfüggvényből
    if (error.message?.includes('timeout')) return true;
    if (error.message?.includes('timed out')) return true; // Angol timeout
    if (error.message?.includes('időtúllépés')) return true; // Magyar timeout
    
    // Böngésző fetch hibák
    if (error.message?.includes('Failed to fetch')) return true;
    if (error.message?.includes('Network request failed')) return true;
    if (error.message?.includes('NetworkError')) return true;
    
    // Node.js hálózati hibakódok (whitelist)
    const networkCodes = ['ENOTFOUND', 'ECONNREFUSED', 'ETIMEDOUT', 'ENETUNREACH', 'ECONNRESET', 'EAI_AGAIN'];
    if (networkCodes.includes(error.code)) return true;
    
    // Szerver oldali hibák (502, 503, 504) - ezeket is hálózati hibaként kezeljük az újrapróbálkozás miatt
    if (isServerError(error)) return true;

    return false;
};

/**
 * Eldönti, hogy egy hiba Appwrite „hiányzó index" hiba-e.
 * Először stabil, strukturált property-ket vizsgál (code, type),
 * majd fallback-ként az üzenet szövegét ellenőrzi.
 *
 * @param {Error|Object} error - A vizsgálandó hiba objektum.
 * @returns {boolean} Igaz, ha hiányzó index hiba.
 */
export const isIndexNotFoundError = (error) => {
    if (!error) return false;

    // Appwrite strukturált hibakód (ha elérhető)
    if (error.type === 'index_not_found') return true;
    if (error.code === 404 && error.type?.includes('index')) return true;

    // Fallback: üzenet mintaillesztés
    const msg = typeof error.message === 'string' ? error.message : '';
    return msg.includes('Index not found');
};

/**
 * Felhasználóbarát hibaüzenetet generál API hibákhoz.
 * 
 * @param {Error|Object} error - A hiba objektum.
 * @param {string} [operation='művelet'] - A művelet neve (pl. 'Mentés', 'Betöltés'), ami bekerül az üzenetbe.
 * @returns {string} A megjeleníthető hibaüzenet.
 */
export const getAPIErrorMessage = (error, operation = 'művelet') => {
    if (!error) return `A ${operation} sikertelen volt.`;

    // Appwrite hiba részletek kinyerése
    let message;
    if (error.message) {
        message = error.message;
    } else if (typeof error === 'object' && error !== null) {
        try {
            message = JSON.stringify(error);
            if (message === '{}') {
                try {
                    message = error.toString();
                } catch (e) {
                    message = "[Error object]";
                }
            }
        } catch (e) {
            try {
                message = error.toString();
            } catch (e2) {
                message = "[Error object]";
            }
        }
    } else {
        message = String(error);
    }
    
    const code = error.code;
    
    // Gyakori Appwrite hibakódok kezelése
    switch (code) {
        case 401:
            return `Hitelesítési hiba: Jelentkezz be újra.`;
        case 403:
            return `Engedély megtagadva: Nincs jogosultságod ehhez a művelethez.`;
        case 404:
            return `Nem található: A keresett elem nem létezik.`;
        case 409:
            return `Ütközés: Ez az elem már létezik.`;
        case 413:
            return `Túl nagy fájl: A fájl mérete meghaladja a megengedett limitet.`;
        case 429:
            return `Túl sok kérés: Várj egy kicsit, majd próbáld újra.`;
        default:
            if (code >= 500) {
                return `Szerver hiba: A szerver jelenleg nem elérhető. Próbáld újra később.`;
            }
            // Visszaadjuk az eredeti üzenetet, ha nincs specifikus fordítás
            return `${operation} sikertelen: ${message}`;
    }
};
