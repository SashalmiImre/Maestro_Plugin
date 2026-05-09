---
tags: [komponens, server, cloud-function, template]
aliases: [CFTemplate, cloud-function-template]
---

# Cloud Function template

## Cél
**Standard boilerplate** új Appwrite Cloud Function írásakor. A 2026-05-09 incident során a `user-cascade-delete` v1 ad-hoc `https://cloud.appwrite.io/v1` default-ot használt — `fra.cloud.appwrite.io` régió kellett volna ([[Naplók/2026-05-09]]), ami a `users.list()` üres tömböt adott vissza Codex stop-time #5 fix-ig. Ezzel a template-tel az ilyen drift kizárt.

## Kanonikus init pattern

Forrás: `packages/maestro-server/functions/invite-to-organization/src/main.js:419-447`.

```js
const sdk = require('node-appwrite');

module.exports = async ({ req, res, log, error }) => {
    try {
        // ── SDK init ──
        // A key elsődleges forrása a request `x-appwrite-key` header — az Appwrite
        // runtime beinjektálja a CF scope-jaival generált dynamic API kulcsot.
        // Fallback a `process.env.APPWRITE_API_KEY`-re, ha a header hiányzik
        // (régebbi runtime vagy Console „Execute function" gomb).
        const apiKey = req.headers['x-appwrite-key'] || process.env.APPWRITE_API_KEY || '';
        const client = new sdk.Client()
            .setEndpoint(process.env.APPWRITE_ENDPOINT || 'https://cloud.appwrite.io/v1')
            .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID)
            .setKey(apiKey);

        const databases = new sdk.Databases(client);
        const usersApi = new sdk.Users(client);
        // const teamsApi = new sdk.Teams(client); // ha kell tenant Team ACL

        // ── Env var guard (fail-closed) ──
        const databaseId = process.env.DATABASE_ID;
        const myCollectionId = process.env.MY_COLLECTION_ID;
        if (!databaseId || !myCollectionId) {
            return res.json({
                success: false,
                reason: 'misconfigured',
                missing: [
                    !databaseId && 'DATABASE_ID',
                    !myCollectionId && 'MY_COLLECTION_ID'
                ].filter(Boolean)
            }, 500);
        }

        // ── Auth (CF-szintű, ha HTTP execute action) ──
        const callerId = req.headers['x-appwrite-user-id'];
        if (!callerId) {
            return res.json({ success: false, reason: 'unauthenticated' }, 401);
        }

        // ── Payload ──
        let payload = {};
        try {
            payload = req.bodyJson || (req.body ? JSON.parse(req.body) : {});
        } catch {
            return res.json({ success: false, reason: 'invalid_payload' }, 400);
        }

        // ── Üzleti logika ──
        // ... (a CF saját feladata)

        return res.json({ success: true });
    } catch (err) {
        error(`[FunctionName] uncaught: ${err.message}`);
        return res.json({ success: false, reason: 'internal_error' }, 500);
    }
};
```

## Kötelező env varok minden CF-en

| Var | Forrás | Megjegyzés |
|---|---|---|
| `APPWRITE_API_KEY` | secret | Csak fallback — első a `x-appwrite-key` header. |
| `APPWRITE_ENDPOINT` | `https://fra.cloud.appwrite.io/v1` | **EXPLICIT** beállítás kötelező. A `cloud.appwrite.io` (region nélkül) `users.list()`-en üres tömböt ad. |
| `APPWRITE_FUNCTION_PROJECT_ID` | automatikus | Appwrite runtime injektálja. |

A 2026-05-09 incident gyökere: az `APPWRITE_ENDPOINT` env var hiánya esetén a `https://cloud.appwrite.io/v1` default-ra esett, ami a project régiójánál (FRA) `users.list()`-on csendes üres tömböt ad. **Mindig másold a kanonikus pattern-t** a `cascade-delete` és `invite-to-organization` CF-ből, NE kreálj ad-hoc default-ot.

## Logger

Az Appwrite CF runtime `log()` és `error()` callback-et ad. **Soha** `console.*`-ot. Példa:
```js
log(`[FunctionName] action=create_X user=${callerId} target=${targetId}`);
error(`[FunctionName] DB write failed: ${err.message}`);
```

## Fail-closed minta

- **Env var hiány** → 500 `misconfigured` + `missing: [...]`
- **Auth hiány** → 401 `unauthenticated`
- **Permission denied** → 403 `insufficient_permission` + `{ slug, scope }`
- **Invalid payload** → 400 `invalid_payload` / `missing_fields` + `required: [...]`
- **Doc not found** → 404 `<resource>_not_found`
- **Concurrency** → 409 `concurrent_modification` (TOCTOU `expectedUpdatedAt` mismatch)
- **Validation** → 422 `<reason>` + `{ ...detail }`

## Action-router minta (HTTP CF, multi-action)

Lásd `invite-to-organization/src/main.js` action-router (~589 sor a B.0.3 modularizáció után). Egy CF, sok `action` payload — minden action saját `actions/<topic>.js` modulban.

## Tenant ACL minta

Új collection-höz: `buildOrgAclPerms(orgId)` / `buildOfficeAclPerms(officeId)` / `buildWorkflowAclPerms(...)` helper kötelező + `rowSecurity: true` a collection-ön. Részletek: [[Döntések/0003-tenant-team-acl]], [[Döntések/0006-workflow-lifecycle-scope]].

## Deploy minta

Appwrite MCP-vel:
```js
functions_create_deployment(functionId, code, entrypoint='src/main.js', activate=true)
functions_get_deployment(functionId, deploymentId)  // polling
functions_list_executions(functionId)               // debug
```

## Kapcsolódó
- ADR: [[Döntések/0003-tenant-team-acl]] (per-tenant Team ACL)
- Csomag: [packages/maestro-server/CLAUDE.md](packages/maestro-server/CLAUDE.md) (function-onként részletes leírás)
- SessionPreflight: [[SessionPreflight]] (deploy-mechanizmus)
- Napló: [[Naplók/2026-05-09]] (incident: endpoint-default mismatch)
