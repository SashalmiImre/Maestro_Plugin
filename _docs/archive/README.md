# Archívum

Ez a mappa a Maestro átalakítás során **történelmi hivatkozásként** megőrzött dokumentumokat tartalmazza.

Az itt lévő fájlok a statikus, egybérlős workflow rendszer időszakából származnak, és **már nem tükrözik a jelenlegi állapotot**. Új implementációhoz ne használd őket — a friss igazságforrás a [_docs/workflow-designer/](../workflow-designer/) mappa.

## Tartalom

- [WORKFLOW_CONFIGURATION.md](WORKFLOW_CONFIGURATION.md) — a régi hardkódolt workflow konfiguráció leírása (`WORKFLOW_STATES` integer enum, `STATUS_LABELS`, `STATE_DURATIONS`, `TEAM_ARTICLE_FIELD`). Az új rendszerben ezek a [`workflows.compiled`](../workflow-designer/COMPILED_SCHEMA.md) JSON-ban élnek.
- [WORKFLOW_PERMISSIONS.md](WORKFLOW_PERMISSIONS.md) — a régi jogosultsági rendszer: fix Appwrite Team-ek, capability label-ek, hardkódolt `STATE_PERMISSIONS`. Az új rendszerben a `compiled.statePermissions` + `compiled.elementPermissions` + dinamikus `groups` collection váltja.

## Miért őriztük meg?

1. **Üzleti logika referencia**: a 8 állapotú magazin workflow szemantikája és a 7 csapat szerepköre innen származik.
2. **Migrációs validáció**: a `defaultWorkflow.json` template ezekből a dokumentumokból lett átírva `compiled` formátumra — ellenőrzéshez összevethető.
3. **Visszamenőleges nyomozás**: ha egy régi commit vagy hibajelentés hivatkozik egy korábbi viselkedésre, itt utánanézhető.

A teljes régi → új megfeleltetés a [MIGRATION_NOTES.md](../workflow-designer/MIGRATION_NOTES.md)-ban található.
