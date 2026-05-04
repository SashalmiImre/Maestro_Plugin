/**
 * Maestro Server — Megosztott konstansok (Fázis 1 helper-extract, 2026-05-02).
 *
 * Ez a modul azokat a konstansokat tartalmazza, amelyeket a `main.js` és a
 * `helpers/*` modulok egyaránt használnak. A komment-anyag a kanonikus
 * `main.js`-ben volt, onnan költözött át változatlanul.
 *
 * A `SLUG_REGEX`, `SLUG_MAX_LENGTH`, `NAME_MAX_LENGTH` SZÁNDÉKOSAN a `main.js`-ben
 * marad, mert a `slugifyName` / `sanitizeString` utility-k ott élnek és csak a
 * `main.js` actionjeiben használtak.
 */

// Kaszkád törlés batch mérete — lapozás a nagy dokumentum-mennyiségek kezeléséhez.
const CASCADE_BATCH_LIMIT = 100;

// Scan-eredmény felső korlát forrásonként (delete_group referencia-check).
// Ha egy scan eléri, a hátralévő lapokat nem olvassuk — az admin UI-nak ennyi
// példa bőven elég a "használatban van" állapot érzékeltetéséhez, és a payload
// + memória bounded marad pathologikus (tízezer+ hivatkozás) esetekben is.
const MAX_REFERENCES_PER_SCAN = 50;

// Workflow láthatóság enum — Feladat #80 (2026-04-20) óta 3-way: a `public`
// scope-pal a workflow a teljes platformon elérhető (minden authentikált
// user láthatja). A 2-way MVP (#30) `editorial_office` / `organization`
// szemantikája változatlan.
const WORKFLOW_VISIBILITY_VALUES = ['organization', 'editorial_office', 'public'];
const WORKFLOW_VISIBILITY_DEFAULT = 'editorial_office';

// Sentinel a `contributorJsonReferencesSlug` parse-hibás visszatéréséhez —
// fail-closed jelzés a hívóknak (delete_group/archive_group blocker scan).
const PARSE_ERROR = 'parse_error';

// B.1.1 (ADR 0007 Phase 0) — workflow extension enum-ok.
// A `kind` mindkét Phase 0 értékét tartalmazza (`validator`, `command`).
//
// A `scope` Phase 0-ban CSAK `['article']` — fail-closed séma. A Phase 1+
// `publication` scope egy schema-frissítéssel kerül be (`updateEnumAttribute`,
// a `bootstrap_workflow_schema` `public` visibility late-add mintáját követve).
// Ezzel a Phase 0-ban a séma maga rejekti az ismeretlen scope-ú write-okat —
// a B.3 CRUD action-nek nem kell explicit `scope: 'publication'` guard-ot
// adnia (defense-in-depth a sémából jön; Codex adversarial review B.1
// 2026-05-04 Medium fix).
const EXTENSION_KIND_VALUES = ['validator', 'command'];
const EXTENSION_SCOPE_VALUES = ['article'];
const EXTENSION_SCOPE_DEFAULT = 'article';

// B.3 (ADR 0007 Phase 0, 2026-05-04) — extension méret-konstansok.
//
// SYNC WITH: packages/maestro-shared/extensionContract.js
//   - EXTENSION_NAME_MAX_LENGTH (= 100): a kliens-oldali kontraktusban
//     dokumentált, schema-szintű string size-zal egyezik. NEM a generikus
//     NAME_MAX_LENGTH (= 128) — az extension `name` UI-ban látszik
//     (Designer "Bővítmények" tab kártya-fejléc), domain-konstans.
//   - EXTENSION_SLUG_REGEX, EXTENSION_SLUG_MAX_LENGTH: a server-helpers/util.js
//     `SLUG_REGEX` (= /^[a-z0-9]+(?:-[a-z0-9]+)*$/) és `SLUG_MAX_LENGTH` (= 64)
//     értékeivel betűre azonos. Phase 0-ban a CF write-path a meglévő
//     `SLUG_REGEX`/`SLUG_MAX_LENGTH`-szal validál (NEM duplikál külön
//     `EXTENSION_SLUG_*` konstansokat) — semantic drift-rizikó: a shared
//     `validateExtensionSlug` whitespace-érzékeny + error-akkumulátor, a
//     CF-en pedig a `sanitizeString` trim-elt érték szerint regex.test —
//     értékek azonosak, semantic eltérő (Codex tervi review nyíltan rögzít).
//
// A `code` ~1 MB schema-ceiling (B.1.1 attribute size); a CF write-path
// szigorúbb operatív cap-et tesz (Codex tervi review): a Phase 0 tipikus
// extension 5-50 KB, a 256 KB defense-in-depth payload-méret guard. Az
// aggregate `compiledExtensionSnapshot` ezzel max. ~16 extension-t fed
// le (256 KB × 16 = 4 MB), de a snapshot mező maga is 1 MB, ezért az
// `activate_publication` egy SNAPSHOT_MAX_BYTES guardot is alkalmaz a
// stringify-olt JSON hosszára (lásd actions/publications.js).
const EXTENSION_NAME_MAX_LENGTH = 100;
const EXTENSION_CODE_MAX_LENGTH = 256 * 1024;     // 262144 char ≈ 256 KB
const EXTENSION_SNAPSHOT_MAX_BYTES = 800 * 1024;  // 819200 char ≈ 800 KB

module.exports = {
    CASCADE_BATCH_LIMIT,
    MAX_REFERENCES_PER_SCAN,
    WORKFLOW_VISIBILITY_VALUES,
    WORKFLOW_VISIBILITY_DEFAULT,
    PARSE_ERROR,
    EXTENSION_KIND_VALUES,
    EXTENSION_SCOPE_VALUES,
    EXTENSION_SCOPE_DEFAULT,
    EXTENSION_NAME_MAX_LENGTH,
    EXTENSION_CODE_MAX_LENGTH,
    EXTENSION_SNAPSHOT_MAX_BYTES
};
