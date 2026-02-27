/**
 * @file maestroEvents.js
 * @description Maestro Plugin eseményrendszer — központi konstansok és segédfüggvények.
 *
 * Minden egyedi esemény a `maestro:` prefixet használja és kebab-case formátumú.
 * Az események **bekövetkezett tényeket** jeleznek (occurrence), nem parancsokat —
 * a fogadó kód dönti el, hogyan reagál rájuk.
 *
 * Használat:
 *   import { MaestroEvent, dispatchMaestroEvent } from '../config/maestroEvents.js';
 *
 *   // Esemény kiváltása
 *   dispatchMaestroEvent(MaestroEvent.documentSaved, { article, filePath });
 *
 *   // Esemény figyelése
 *   window.addEventListener(MaestroEvent.documentSaved, handler);
 */

// ---------------------------------------------------------------------------
// Esemény nevek
// ---------------------------------------------------------------------------

export const MaestroEvent = Object.freeze({

    // --- Dokumentum életciklus ---
    /** Dokumentum elmentve (afterSave). Detail: { article, filePath } */
    documentSaved: 'maestro:document-saved',

    /** Dokumentum bezárva (lock feloldódott). Detail: { article, filePath, registerTask } */
    documentClosed: 'maestro:document-closed',

    // --- Workflow ---
    /** Cikk állapota megváltozott. Detail: { article, previousState, newState } */
    stateChanged: 'maestro:state-changed',

    // --- Struktúra / Overlap ---
    /** Cikk oldalszámai megváltoztak. Detail: { article } */
    pageRangesChanged: 'maestro:page-ranges-changed',

    /** Cikk layoutja megváltozott. Detail: { article } vagy { articles, publicationId } (tömeges) */
    layoutChanged: 'maestro:layout-changed',

    /** Kiadvány lefedettségi tartománya megváltozott. Detail: { publication } */
    publicationCoverageChanged: 'maestro:publication-coverage-changed',

    /** Cikkek hozzáadva a kiadványhoz. Detail: { publicationId } */
    articlesAdded: 'maestro:articles-added',

    // --- Auth ---
    /** Munkamenet lejárt (401-es hiba detektálva). Nincs detail. */
    sessionExpired: 'maestro:session-expired',

    /** Felhasználó bejelentkezett vagy kijelentkezett. Detail: { isLoggedIn } */
    authStateChanged: 'maestro:auth-state-changed',

    // --- Adat / Frissítés ---
    /** Adatfrissítés szükséges (pl. alvásból ébredés, realtime reconnect). Nincs detail. */
    dataRefreshRequested: 'maestro:data-refresh-requested',

    /** Panel megjelent (pl. app aktiválás, sleep/wake). Nincs detail. */
    panelShown: 'maestro:panel-shown',

    // --- Lock koordináció ---
    /** Lock ellenőrzés szükséges (pl. programozott dokumentumnyitás után). Nincs detail. */
    lockCheckRequested: 'maestro:lock-check-requested',

    /** Verifikáció elindult — lockkezelés szüneteltetése. Nincs detail. */
    verificationStarted: 'maestro:verification-started',

    /** Verifikáció befejeződött — lockkezelés folytatása. Nincs detail. */
    verificationEnded: 'maestro:verification-ended',

    // --- Infrastruktúra ---
    /** Proxy endpoint váltás történt. Detail: { isPrimary, endpoint } */
    endpointSwitched: 'maestro:endpoint-switched',
});

// ---------------------------------------------------------------------------
// Segédfüggvények
// ---------------------------------------------------------------------------

/**
 * Maestro esemény kiváltása a `window` objektumon.
 *
 * @param {string} eventName - `MaestroEvent` konstans (pl. `MaestroEvent.documentSaved`)
 * @param {Object} [detail] - Opcionális adat az eseményhez
 */
export const dispatchMaestroEvent = (eventName, detail) => {
    if (detail !== undefined) {
        window.dispatchEvent(new CustomEvent(eventName, { detail }));
    } else {
        window.dispatchEvent(new Event(eventName));
    }
};
