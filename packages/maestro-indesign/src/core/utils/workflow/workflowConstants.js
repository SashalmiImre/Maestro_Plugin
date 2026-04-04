
import { VALIDATOR_TYPES } from "../validationConstants.js";
import {
    WORKFLOW_STATES,
    MARKERS,
    STATE_DURATIONS,
    TEAM_ARTICLE_FIELD,
    STATUS_LABELS,
    CONFIG_VERSION,
    CONFIG_DOCUMENT_ID,
    labelMatchesSlug
} from "maestro-shared/workflowConfig.js";

import { resolveGrantedTeams, hasCapability, CAPABILITY_LABELS, VALID_LABELS, isValidLabel } from "maestro-shared/labelConfig.js";

// Re-export a shared-ből — a fogyasztó fájlok változatlanul importálhatnak innen
export { WORKFLOW_STATES, MARKERS, STATE_DURATIONS, TEAM_ARTICLE_FIELD, CONFIG_VERSION, CONFIG_DOCUMENT_ID, labelMatchesSlug };
export { resolveGrantedTeams, hasCapability, CAPABILITY_LABELS, VALID_LABELS, isValidLabel };

/**
 * Parancs-regiszter: az összes elérhető parancs definíciója.
 * Az egyes állapotokban megjelenő parancsokat a WORKFLOW_CONFIG határozza meg.
 * A jogosultságot (melyik csapatok futtathatják) itt kell konfigurálni.
 *
 * @type {Object.<string, { label: string, teams: string[] }>}
 */
export const COMMANDS = {
    'export_pdf':              { label: 'PDF írás',                 teams: ['designers', 'art_directors'] },
    'export_final_pdf':        { label: 'Végleges PDF írás',        teams: ['designers', 'art_directors'] },
    'collect_images':          { label: 'Képek összegyűjtése',      teams: ['designers', 'art_directors'] },
    'collect_selected_images': { label: 'Kijelölt képek gyűjtése',  teams: ['designers', 'art_directors'] },
    'preflight_check':         { label: 'Preflight',                teams: ['designers', 'art_directors'] },
    'archive':                 { label: 'Archiválás',               teams: ['designers', 'art_directors'] },
    'print_output':            { label: 'Levilágítás',              teams: ['designers', 'art_directors'] }
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
 *   commands: string[]
 * }>}
 */
export const WORKFLOW_CONFIG = {
    [WORKFLOW_STATES.DESIGNING]: {
        config: { label: STATUS_LABELS[WORKFLOW_STATES.DESIGNING], color: "var(--status-designing)", icon: "" },
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
        config: { label: STATUS_LABELS[WORKFLOW_STATES.DESIGN_APPROVAL], color: "var(--status-design-approval)", icon: "" },
        transitions: [
            { target: WORKFLOW_STATES.WAITING_FOR_START, label: "Jóváhagyás", type: TRANSITION_TYPES.FORWARD },
            { target: WORKFLOW_STATES.DESIGNING, label: "Tervezéshez", type: TRANSITION_TYPES.BACKWARD }
        ],
        validations: {
            onEntry: [],
            requiredToEnter: [VALIDATOR_TYPES.FILE_ACCESSIBLE, VALIDATOR_TYPES.PAGE_NUMBER_CHECK, VALIDATOR_TYPES.FILENAME_VERIFICATION],
            requiredToExit: []
        },
        commands: ['export_pdf']
    },
    [WORKFLOW_STATES.WAITING_FOR_START]: {
        config: { label: STATUS_LABELS[WORKFLOW_STATES.WAITING_FOR_START], color: "var(--status-waiting-for-start)", icon: "" },
        transitions: [
            { target: WORKFLOW_STATES.EDITORIAL_APPROVAL, label: "Indítás", type: TRANSITION_TYPES.FORWARD },
            { target: WORKFLOW_STATES.DESIGN_APPROVAL, label: "Jóváhagyáshoz", type: TRANSITION_TYPES.BACKWARD }
        ],
        validations: {
            onEntry: [],
            requiredToEnter: [VALIDATOR_TYPES.FILE_ACCESSIBLE, VALIDATOR_TYPES.PAGE_NUMBER_CHECK, VALIDATOR_TYPES.FILENAME_VERIFICATION],
            requiredToExit: []
        },
        commands: ['export_pdf', 'collect_images']
    },
    [WORKFLOW_STATES.EDITORIAL_APPROVAL]: {
        config: { label: STATUS_LABELS[WORKFLOW_STATES.EDITORIAL_APPROVAL], color: "var(--status-editorial-approval)", icon: "" },
        transitions: [
            { target: WORKFLOW_STATES.CONTENT_REVISION, label: "Jóváhagyás", type: TRANSITION_TYPES.FORWARD },
            { target: WORKFLOW_STATES.DESIGNING, label: "Tervezéshez", type: TRANSITION_TYPES.BACKWARD }
        ],
        validations: {
            onEntry: [],
            requiredToEnter: [VALIDATOR_TYPES.FILE_ACCESSIBLE, VALIDATOR_TYPES.PAGE_NUMBER_CHECK, VALIDATOR_TYPES.FILENAME_VERIFICATION],
            requiredToExit: []
        },
        commands: ['export_pdf', 'collect_images']
    },
    [WORKFLOW_STATES.CONTENT_REVISION]: {
        config: { label: STATUS_LABELS[WORKFLOW_STATES.CONTENT_REVISION], color: "var(--status-content-revision)", icon: "" },
        transitions: [
            { target: WORKFLOW_STATES.FINAL_APPROVAL, label: "Korrektúrázva", type: TRANSITION_TYPES.FORWARD },
            { target: WORKFLOW_STATES.EDITORIAL_APPROVAL, label: "Szerkesztőhöz", type: TRANSITION_TYPES.BACKWARD }
        ],
        validations: {
            onEntry: [],
            requiredToEnter: [VALIDATOR_TYPES.FILE_ACCESSIBLE, VALIDATOR_TYPES.PAGE_NUMBER_CHECK, VALIDATOR_TYPES.FILENAME_VERIFICATION],
            requiredToExit: []
        },
        commands: ['export_pdf', 'collect_images']
    },
    [WORKFLOW_STATES.FINAL_APPROVAL]: {
        config: { label: STATUS_LABELS[WORKFLOW_STATES.FINAL_APPROVAL], color: "var(--status-final-approval)", icon: "" },
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
        commands: ['export_final_pdf', 'preflight_check']
    },
    [WORKFLOW_STATES.PRINTABLE]: {
        config: { label: STATUS_LABELS[WORKFLOW_STATES.PRINTABLE], color: "var(--status-printable)", icon: "" },
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
        commands: ['preflight_check']
    },
    [WORKFLOW_STATES.ARCHIVABLE]: {
        config: { label: STATUS_LABELS[WORKFLOW_STATES.ARCHIVABLE], color: "var(--status-archivable)", icon: "" },
        transitions: [],
        validations: {
            onEntry: [],
            requiredToEnter: [VALIDATOR_TYPES.FILE_ACCESSIBLE],
            requiredToExit: []
        },
        commands: ['archive', 'print_output']
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
    [WORKFLOW_STATES.DESIGNING]:           ["designers", "art_directors"],
    [WORKFLOW_STATES.DESIGN_APPROVAL]:     ["art_directors"],
    [WORKFLOW_STATES.WAITING_FOR_START]:   ["designers", "art_directors"],
    [WORKFLOW_STATES.EDITORIAL_APPROVAL]:  ["editors", "managing_editors"],
    [WORKFLOW_STATES.CONTENT_REVISION]:    ["proofwriters"],
    [WORKFLOW_STATES.FINAL_APPROVAL]:      ["editors", "managing_editors"],
    [WORKFLOW_STATES.PRINTABLE]:           ["designers", "art_directors"]
};

// ─── Config builder (szerver-oldali konstansok) ────────────────────────────

/**
 * Összeállítja a workflow config dokumentumot a DB `config` collection számára.
 * A Cloud Function-ök ezt a dokumentumot olvassák — nem hardkódolnak konstansokat.
 *
 * A WORKFLOW_CONFIG transitions tömbjéből kinyeri az érvényes átmeneteket
 * (VALID_TRANSITIONS), a többi konstanst közvetlenül JSON-ná szerializálja.
 *
 * @returns {Object} A config dokumentum mezői (JSON string értékekkel).
 */
export function buildWorkflowConfigDocument() {
    // Érvényes átmenetek kinyerése a WORKFLOW_CONFIG-ból
    const validTransitions = {};
    for (const [stateStr, config] of Object.entries(WORKFLOW_CONFIG)) {
        validTransitions[stateStr] = config.transitions.map(t => t.target);
    }

    // Capability label → csapat mapping (csak a grantTeams, ami a szerveren kell)
    const capabilityLabels = {};
    for (const [label, config] of Object.entries(CAPABILITY_LABELS)) {
        if (config.grantTeams) {
            capabilityLabels[label] = config.grantTeams;
        }
    }

    return {
        configVersion: CONFIG_VERSION,
        statePermissions: JSON.stringify(STATE_PERMISSIONS),
        validTransitions: JSON.stringify(validTransitions),
        teamArticleField: JSON.stringify(TEAM_ARTICLE_FIELD),
        capabilityLabels: JSON.stringify(capabilityLabels),
        validLabels: JSON.stringify([...VALID_LABELS]),
        validStates: JSON.stringify(Object.values(WORKFLOW_STATES))
    };
}

