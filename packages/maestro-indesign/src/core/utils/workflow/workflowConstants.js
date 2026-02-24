

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

export const MARKER_CONFIG = {
    [1]: { label: "Kimarad", color: "var(--spectrum-global-color-gray-500)" }
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
            { target: WORKFLOW_STATES.DESIGN_APPROVAL, label: "Tördelve", type: "forward" }
        ],
        validations: {
            onEntry: [],
            requiredToEnter: ["file_accessible"],
            requiredToExit: []
        },
        commands: []
    },
    [WORKFLOW_STATES.DESIGN_APPROVAL]: {
        config: { label: "Terv ellenőrzés", color: "var(--status-design-approval)", icon: "" },
        transitions: [
            { target: WORKFLOW_STATES.WAITING_FOR_START, label: "Jóváhagyás", type: "forward" },
            { target: WORKFLOW_STATES.DESIGNING, label: "Tervezéshez", type: "backward" }
        ],
        validations: {
            onEntry: [],
            requiredToEnter: ["file_accessible", "page_number_check", "filename_verification"],
            requiredToExit: []
        },
        commands: [
            { id: 'export_pdf', label: 'PDF írás' }
        ]
    },
    [WORKFLOW_STATES.WAITING_FOR_START]: {
        config: { label: "Elindításra vár", color: "var(--status-waiting-for-start)", icon: "" },
        transitions: [
            { target: WORKFLOW_STATES.EDITORIAL_APPROVAL, label: "Indítás", type: "forward" },
            { target: WORKFLOW_STATES.DESIGN_APPROVAL, label: "Jóváhagyáshoz", type: "backward" }
        ],
        validations: {
            onEntry: [],
            requiredToEnter: ["file_accessible", "page_number_check", "filename_verification"],
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
            { target: WORKFLOW_STATES.CONTENT_REVISION, label: "Jóváhagyás", type: "forward" },
            { target: WORKFLOW_STATES.DESIGNING, label: "Tervezéshez", type: "backward" }
        ],
        validations: {
            onEntry: [],
            requiredToEnter: ["file_accessible", "page_number_check", "filename_verification"],
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
            { target: WORKFLOW_STATES.FINAL_APPROVAL, label: "Korrektúrázva", type: "forward" },
            { target: WORKFLOW_STATES.EDITORIAL_APPROVAL, label: "Szerkesztőhöz", type: "backward" }
        ],
        validations: {
            onEntry: [],
            requiredToEnter: ["file_accessible", "page_number_check", "filename_verification"],
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
            { target: WORKFLOW_STATES.PRINTABLE, label: "Jóváhagyás", type: "forward" },
            { target: WORKFLOW_STATES.DESIGN_APPROVAL, label: "Terv ellenőrzés", type: "backward" }
        ],
        validations: {
            onEntry: [
                 { validator: 'preflight_check', options: { profile: "Levil", profileFile: "Levil.idpp" } }
            ],
            requiredToEnter: ["file_accessible"],
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
            { target: WORKFLOW_STATES.ARCHIVABLE, label: "Levilágítás", type: "forward" },
            { target: WORKFLOW_STATES.FINAL_APPROVAL, label: "Végső ellenőrzés", type: "backward" }
        ],
        validations: {
            onEntry: [
                 { validator: 'preflight_check', options: { profile: "Levil", profileFile: "Levil.idpp" } }
            ],
            requiredToEnter: [
                "file_accessible",
                { validator: 'preflight_check', options: { profile: "Levil", profileFile: "Levil.idpp" } }
            ],
            requiredToExit: [
                { validator: 'preflight_check', options: { profile: "Levil", profileFile: "Levil.idpp" } }
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
            requiredToEnter: ["file_accessible"],
            requiredToExit: []
        },
        commands: [
             { id: 'archive', label: 'Archiválás' },
             { id: 'print_output', label: 'Levilágítás' }
        ]
    }
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
