
import { VALIDATOR_TYPES } from "../validationConstants.js";

/**
 * Munkafolyamat állapotok enumerációja.
 * Ezek az értékek kerülnek mentésre az adatbázisban a cikkek `state` mezőjében.
 * 
 * @enum {number}
 */
export const WORKFLOW_STATES = {
    DESIGNING: 0,           // Tervezés alatt
    DESIGN_APPROVAL: 1,     // Elrendezés jóváhagyása
    WAITING_FOR_START: 2,   // Elindításra vár
    EDITORIAL_APPROVAL: 3,  // Szerkesztői jóváhagyás
    CONTENT_REVISION: 4,    // Tartalmi javítás (Korrektúra & Képcsere)
    FINAL_APPROVAL: 5,      // Végleges jóváhagyás
    PRINTABLE: 6,           // Nyomdakész
    ARCHIVABLE: 7           // Archiválható
};

/**
 * Jelölő (Marker) bitmaszkok a cikkek státuszának további finomítására.
 * Bitmaszk alapú, így egy cikkhez több jelölő is tartozhat egyszerre.
 * 
 * Használat:
 * - Beállítás: `markers |= MARKERS.IGNORE`
 * - Törlés: `markers &= ~MARKERS.IGNORE`
 * - Ellenőrzés: `(markers & MARKERS.IGNORE) !== 0`
 * 
 * @enum {number}
 */
export const MARKERS = {
    NONE: 0,
    IGNORE: 1          // Kimarad — a cikk ideiglenesen ki van hagyva a kiadványból
};

/**
 * Munkafolyamat átmenet típusok enum.
 * Meghatározza, hogy az állapotváltás előre vagy hátra történik.
 *
 * @enum {string}
 */
export const TRANSITION_TYPES = {
    FORWARD: 'forward',   // Előre haladás a munkafolyamatban
    BACKWARD: 'backward'  // Visszalépés korábbi állapotba
};

/**
 * A munkafolyamat teljes konfigurációs objektuma.
 * Ez az objektum definiálja az egyes állapotokhoz tartozó:
 * - Megjelenítési beállításokat (címke, szín, ikon)
 * - Lehetséges állapotátmeneteket (target, label, type)
 * - Validációs szabályokat (belépéskor/kilépéskor)
 * - Elérhető parancsokat
 * 
 * @type {Object.<number, {
 *   config: {label: string, color: string, icon: string},
 *   transitions: Array<{target: number, label: string, type: 'forward'|'backward'}>,
 *   validations: {
 *     onEntry: Array, // Auto-run validációk az állapotba lépéskor (NEM blokkoló, csak futtat)
 *     requiredToEnter: Array<string|Object>, // Feltételek az állapotba lépéshez (BLOKKOLÓ - kötelező megfelelni)
 *     requiredToExit: Array<string|Object> // Feltételek az állapot elhagyásához (BLOKKOLÓ - kötelező teljesíteni)
 *   },
 *   commands: Array<{id: string, label: string}>
 * }>}
 */
export const WORKFLOW_CONFIG = {
    [WORKFLOW_STATES.DESIGNING]: {
        config: { label: "Tervezés", color: "var(--status-designing)", icon: "" },
        transitions: [
            { target: WORKFLOW_STATES.DESIGN_APPROVAL, label: "Tördelve", type: TRANSITION_TYPES.FORWARD }
        ],
        validations: {
            onEntry: [],
            requiredToEnter: [VALIDATOR_TYPES.FILE_ACCESSIBLE],
            requiredToExit: []
        },
        commands: []
    },
    [WORKFLOW_STATES.DESIGN_APPROVAL]: {
        config: { label: "Terv ellenőrzés", color: "var(--status-design-approval)", icon: "" },
        transitions: [
            { target: WORKFLOW_STATES.WAITING_FOR_START, label: "Jóváhagyás", type: TRANSITION_TYPES.FORWARD },
            { target: WORKFLOW_STATES.DESIGNING, label: "Tervezéshez", type: TRANSITION_TYPES.BACKWARD }
        ],
        validations: {
            onEntry: [],
            requiredToEnter: [VALIDATOR_TYPES.FILE_ACCESSIBLE, VALIDATOR_TYPES.PAGE_NUMBER_CHECK, VALIDATOR_TYPES.FILENAME_VERIFICATION],
            requiredToExit: []
        },
        commands: [
            { id: 'export_pdf', label: 'PDF írás' }
        ]
    },
    [WORKFLOW_STATES.WAITING_FOR_START]: {
        config: { label: "Elindításra vár", color: "var(--status-waiting-for-start)", icon: "" },
        transitions: [
            { target: WORKFLOW_STATES.EDITORIAL_APPROVAL, label: "Indítás", type: TRANSITION_TYPES.FORWARD },
            { target: WORKFLOW_STATES.DESIGN_APPROVAL, label: "Jóváhagyáshoz", type: TRANSITION_TYPES.BACKWARD }
        ],
        validations: {
            onEntry: [],
            requiredToEnter: [VALIDATOR_TYPES.FILE_ACCESSIBLE, VALIDATOR_TYPES.PAGE_NUMBER_CHECK, VALIDATOR_TYPES.FILENAME_VERIFICATION],
            requiredToExit: []
        },
        commands: [
            { id: 'export_pdf', label: 'PDF írás' },
            { id: 'collect_images', label: 'Képek összegyűjtése' }
        ]
    },
    [WORKFLOW_STATES.EDITORIAL_APPROVAL]: {
        config: { label: "Szerkesztői ellenőrzés", color: "var(--status-editorial-approval)", icon: "" },
        transitions: [
            { target: WORKFLOW_STATES.CONTENT_REVISION, label: "Jóváhagyás", type: TRANSITION_TYPES.FORWARD },
            { target: WORKFLOW_STATES.DESIGNING, label: "Tervezéshez", type: TRANSITION_TYPES.BACKWARD }
        ],
        validations: {
            onEntry: [],
            requiredToEnter: [VALIDATOR_TYPES.FILE_ACCESSIBLE, VALIDATOR_TYPES.PAGE_NUMBER_CHECK, VALIDATOR_TYPES.FILENAME_VERIFICATION],
            requiredToExit: []
        },
        commands: [
            { id: 'export_pdf', label: 'PDF írás' },
            { id: 'collect_images', label: 'Képek összegyűjtése' }
        ]
    },
    [WORKFLOW_STATES.CONTENT_REVISION]: {
        config: { label: "Korrektúrázás", color: "var(--status-content-revision)", icon: "" },
        transitions: [
            { target: WORKFLOW_STATES.FINAL_APPROVAL, label: "Korrektúrázva", type: TRANSITION_TYPES.FORWARD },
            { target: WORKFLOW_STATES.EDITORIAL_APPROVAL, label: "Szerkesztőhöz", type: TRANSITION_TYPES.BACKWARD }
        ],
        validations: {
            onEntry: [],
            requiredToEnter: [VALIDATOR_TYPES.FILE_ACCESSIBLE, VALIDATOR_TYPES.PAGE_NUMBER_CHECK, VALIDATOR_TYPES.FILENAME_VERIFICATION],
            requiredToExit: []
        },
        commands: [
            { id: 'export_pdf', label: 'PDF írás' },
            { id: 'collect_images', label: 'Képek összegyűjtése' }
        ]
    },
    [WORKFLOW_STATES.FINAL_APPROVAL]: {
        config: { label: "Végső ellenőrzés", color: "var(--status-final-approval)", icon: "" },
        transitions: [
            { target: WORKFLOW_STATES.PRINTABLE, label: "Jóváhagyás", type: TRANSITION_TYPES.FORWARD },
            { target: WORKFLOW_STATES.DESIGN_APPROVAL, label: "Terv ellenőrzés", type: TRANSITION_TYPES.BACKWARD }
        ],
        validations: {
            onEntry: [
                 { validator: VALIDATOR_TYPES.PREFLIGHT_CHECK, options: { profile: "Levil", profileFile: "Levil.idpp" } }
            ],
            requiredToEnter: [VALIDATOR_TYPES.FILE_ACCESSIBLE],
            requiredToExit: []
        },
        commands: [
            { id: 'export_final_pdf', label: 'Végleges PDF írás' },
            { id: 'preflight_check', label: 'Preflight' }
        ]
    },
    [WORKFLOW_STATES.PRINTABLE]: {
        config: { label: "Nyomdakész", color: "var(--status-printable)", icon: "" },
        transitions: [
            { target: WORKFLOW_STATES.ARCHIVABLE, label: "Levilágítás", type: TRANSITION_TYPES.FORWARD },
            { target: WORKFLOW_STATES.FINAL_APPROVAL, label: "Végső ellenőrzés", type: TRANSITION_TYPES.BACKWARD }
        ],
        validations: {
            onEntry: [
                 { validator: VALIDATOR_TYPES.PREFLIGHT_CHECK, options: { profile: "Levil", profileFile: "Levil.idpp" } }
            ],
            requiredToEnter: [
                "file_accessible",
                { validator: VALIDATOR_TYPES.PREFLIGHT_CHECK, options: { profile: "Levil", profileFile: "Levil.idpp" } }
            ],
            requiredToExit: [
                { validator: VALIDATOR_TYPES.PREFLIGHT_CHECK, options: { profile: "Levil", profileFile: "Levil.idpp" } }
            ]
        },
        commands: [
            { id: 'preflight_check', label: 'Preflight' }
        ]
    },
    [WORKFLOW_STATES.ARCHIVABLE]: {
        config: { label: "Archiválható", color: "var(--status-archivable)", icon: "" },
        transitions: [],
        validations: {
            onEntry: [],
            requiredToEnter: [VALIDATOR_TYPES.FILE_ACCESSIBLE],
            requiredToExit: []
        },
        commands: [
             { id: 'archive', label: 'Archiválás' },
             { id: 'print_output', label: 'Levilágítás' }
        ]
    }
};

/**
 * Az egyes munkafolyamat állapotok becsült időtartama.
 * A sürgősség-számítás ezeket használja annak meghatározásához,
 * hogy a hátralévő munka belefér-e a lapzártáig.
 *
 * Minden állapothoz két összetevő tartozik:
 * - `perPage`: egy emberre, egy oldalra vetített átlagos idő percben
 * - `fixed`: oldalszámtól független fix ráfordítás percben
 *
 * Formula: állapot idő = perPage × oldalszám + fixed
 *
 * Az ARCHIVABLE állapot nem szerepel, mert az a leadás utáni munka.
 *
 * @type {Object.<number, { perPage: number, fixed: number }>}
 */
export const STATE_DURATIONS = {
    [WORKFLOW_STATES.DESIGNING]:           { perPage: 60, fixed: 0 },
    [WORKFLOW_STATES.DESIGN_APPROVAL]:     { perPage: 30,  fixed: 15 },
    [WORKFLOW_STATES.WAITING_FOR_START]:   { perPage: 10,  fixed: 15 },
    [WORKFLOW_STATES.EDITORIAL_APPROVAL]:  { perPage: 30, fixed: 15 },
    [WORKFLOW_STATES.CONTENT_REVISION]:    { perPage: 30, fixed: 10 },
    [WORKFLOW_STATES.FINAL_APPROVAL]:      { perPage: 10,  fixed: 15 },
    [WORKFLOW_STATES.PRINTABLE]:           { perPage: 10,  fixed: 5 }
};

/**
 * Állapot-jogosultsági leképezés.
 * Meghatározza, mely csapatok mozgathatják a cikkeket az adott állapotBÓL
 * (előre és hátra egyaránt).
 *
 * Ha az adott állapothoz nincs bejegyzés (pl. ARCHIVABLE), az állapotváltás
 * nem jogosultságfüggő (végállapot, transitions sincs definiálva).
 *
 * @type {Object.<number, string[]>}
 */
export const STATE_PERMISSIONS = {
    [WORKFLOW_STATES.DESIGNING]:           ["designers", "artDirectors"],
    [WORKFLOW_STATES.DESIGN_APPROVAL]:     ["artDirectors"],
    [WORKFLOW_STATES.WAITING_FOR_START]:   ["designers", "artDirectors"],
    [WORKFLOW_STATES.EDITORIAL_APPROVAL]:  ["editors", "managingEditors"],
    [WORKFLOW_STATES.CONTENT_REVISION]:    ["proofwriters"],
    [WORKFLOW_STATES.FINAL_APPROVAL]:      ["editors", "managingEditors"],
    [WORKFLOW_STATES.PRINTABLE]:           ["designers", "artDirectors"]
};

/**
 * Csapat → cikkmező leképezés.
 * Meghatározza, melyik csapat slug melyik cikk-mezőhöz van kötve
 * a jogosultsági ellenőrzésben (a hozzárendelt felhasználó userId-ja).
 *
 * @type {Object.<string, string>}
 */
export const TEAM_ARTICLE_FIELD = {
    "designers":        "designerId",
    "artDirectors":     "artDirectorId",
    "editors":          "editorId",
    "managingEditors":  "managingEditorId",
    "proofwriters":     "proofwriterId",
    "writers":          "writerId",
    "imageEditors":     "imageEditorId"
};
