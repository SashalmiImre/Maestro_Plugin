# Workflow Designer — Adatmodell

> Az új és módosuló Appwrite collectionök részletes leírása.
> **Kapcsolódó**: [ARCHITECTURE.md](ARCHITECTURE.md), [COMPILED_SCHEMA.md](COMPILED_SCHEMA.md).

---

## Scope lánc

```
┌────────────────┐
│ organization   │   (top-level bérlő — a regisztráló user az owner)
└───────┬────────┘
        │ 1..N
┌───────▼────────┐
│ editorialOffice│   (szerkesztőség — saját workflow-val)
└───────┬────────┘
        │ 1..N
┌───────▼────────┐
│ publication    │   (kiadvány — egyetlen officehez tartozik)
└───────┬────────┘
        │ 1..N
┌───────▼────────┐
│ article        │   (cikk — a publication gyermeke, de office-scope-ja denormalizált)
└────────────────┘
```

Minden alacsonyabb entitás **denormalizált** `organizationId` + `editorialOfficeId` mezővel hordozza a scope-ját. Ez gyors query-t és Cloud Function guard-okat tesz lehetővé.

---

## Új collectionök

### `organizations`

A top-level bérlő egység. A regisztráló user automatikusan létrehozza a saját organization-jét.

| Mező | Típus | Leírás |
|------|-------|--------|
| `$id` | string | Appwrite auto ID |
| `name` | string | Megjelenített név (pl. „Teszt Kiadó Kft.") |
| `slug` | string (unique) | URL-barát azonosító |
| `ownerUserId` | string | Az org létrehozó user ID-ja |
| `createdAt` | datetime | |

**Index**: `slug` (unique), `ownerUserId`.

---

### `organizationMemberships`

Ki melyik org tagja és milyen szerepkörrel.

| Mező | Típus | Leírás |
|------|-------|--------|
| `$id` | string | |
| `organizationId` | string | → `organizations.$id` |
| `userId` | string | Appwrite user ID |
| `role` | enum | `owner` \| `admin` \| `member` |
| `addedByUserId` | string | Ki hozta létre ezt a tagságot |
| `createdAt` | datetime | |

**Index**: `(organizationId, userId)` unique, `userId`.

**Védelem**: collection-szintű ACL `read("users")` only — a kliens NEM tud közvetlenül írni. Minden membership-művelet az `invite-to-organization` Cloud Function-ön keresztül történik (API key-jel), amely a `bootstrap_organization` (új org első owner), `accept` (invite elfogadás) és későbbi admin műveleteket implementálja.

---

### `organizationInvites`

Egyszer felhasználható token-ek meghívó flow-hoz.

| Mező | Típus | Leírás |
|------|-------|--------|
| `$id` | string | |
| `organizationId` | string | |
| `email` | string | A meghívott e-mail címe |
| `token` | string (unique) | Kriptografikusan erős véletlen token |
| `status` | enum | `pending` \| `accepted` \| `expired` \| `revoked` |
| `expiresAt` | datetime | Pl. 7 nap |
| `invitedByUserId` | string | |
| `createdAt` | datetime | |

**Cloud Function**: `invite-to-organization` — generál tokent, e-mailt küld Appwrite Messaging-en át.
Az elfogadás (`/invite?token=...` route a Dashboardon) létrehozza a `organizationMemberships` rekordot és `status=accepted`-re állítja.

---

### `editorialOffices`

A szerkesztőség — saját workflow-val.

| Mező | Típus | Leírás |
|------|-------|--------|
| `$id` | string | |
| `organizationId` | string | Denormalizált scope |
| `name` | string | Megjelenített név (pl. „Stílus Magazin") |
| `slug` | string | URL-barát (office-en belül unique) |
| `workflowId` | string | → `workflows.$id` (az office aktuális workflow dokumentuma) |
| `createdAt` | datetime | |

**Index**: `organizationId`, `(organizationId, slug)` unique.

Új office létrehozásakor automatikusan létrejön:
- Egy `workflows` dokumentum a `defaultWorkflow.json` template másolataként → a `workflowId` erre mutat.
- Egy `editorialOfficeMemberships` rekord a létrehozó userrel `admin` szerepkörben.

---

### `editorialOfficeMemberships`

Ki az office admin és ki tagja.

| Mező | Típus | Leírás |
|------|-------|--------|
| `$id` | string | |
| `editorialOfficeId` | string | |
| `organizationId` | string | Denormalizált |
| `userId` | string | |
| `role` | enum | `admin` \| `member` |
| `createdAt` | datetime | |

**Index**: `(editorialOfficeId, userId)` unique, `userId`, `organizationId`.

Az office `admin` szerepkör → a workflow designer és a csoport-kezelés használható. A `member` csak belép, de csoporttagság nélkül read-only.

---

### `groups`

Dinamikus csoportok (a 7 fix Appwrite Team helyett).

| Mező | Típus | Leírás |
|------|-------|--------|
| `$id` | string | |
| `editorialOfficeId` | string | |
| `organizationId` | string | Denormalizált |
| `slug` | string | Pl. `designers`, `editors` (office-on belül unique, camelCase vagy snake_case) |
| `label` | string | Megjelenített név („Tervező") |
| `color` | string | Hex szín, UI-hoz |
| `isContributorGroup` | boolean | Megjelenik-e contributor dropdown-ként az Article Properties-ben |
| `isLeaderGroup` | boolean | Szuperjogot kap-e (régi `LEADER_TEAMS` dinamikus változata) |
| `description` | string | Rövid leírás az adminnak |
| `createdAt` | datetime | |

**Index**: `editorialOfficeId`, `(editorialOfficeId, slug)` unique.

---

### `groupMemberships`

Ki melyik csoport tagja.

| Mező | Típus | Leírás |
|------|-------|--------|
| `$id` | string | |
| `groupId` | string | |
| `userId` | string | |
| `editorialOfficeId` | string | Denormalizált |
| `organizationId` | string | Denormalizált |
| `addedByUserId` | string | |
| `createdAt` | datetime | |

**Index**: `(groupId, userId)` unique, `(userId, editorialOfficeId)`, `editorialOfficeId`.

**Guard**: `group-membership-guard` Cloud Function — csak office admin vagy org owner/admin hozhat létre/törölhet.

**Realtime**: A plugin feliratkozik a saját `userId`-jára szűrve → `groupMembershipChanged` MaestroEvent → UserContext újraszámolás.

---

### `workflows`

A dinamikus workflow definíció — office-onként egy dokumentum.

| Mező | Típus | Leírás |
|------|-------|--------|
| `$id` | string | |
| `editorialOfficeId` | string | |
| `organizationId` | string | Denormalizált |
| `name` | string | Megjelenített név („Stílus Magazin Workflow") |
| `version` | integer | Monoton növekvő verziószám, auto-inkrementált mentéskor |
| `graph` | longtext (JSON) | A designer számára: node pozíciók, UI state, edge-ek |
| `compiled` | longtext (JSON) | A plugin/CF számára: minimalizált runtime forma (részletes séma a [COMPILED_SCHEMA.md](COMPILED_SCHEMA.md)-ben) |
| `updatedByUserId` | string | Ki mentette utoljára |
| `createdAt` | datetime | |
| `updatedAt` | datetime | |

**Index**: `editorialOfficeId` (minden office-nak jellemzően egy aktív workflow doc-ja van, de elvben lehet több verzió).

**Realtime**: A plugin és a Cloud Function-ök feliratkoznak ennek a dokumentumnak az update-jeire → hot-reload.

---

## Módosuló meglévő collectionök

### `publications`

**Új mezők**:
- `organizationId` (string, denormalizált)
- `editorialOfficeId` (string, denormalizált)
- `defaultContributors` (longtext JSON) — `{groupSlug: userId}` map

**Törölt mezők**:
- `defaultDesignerId`, `defaultWriterId`, `defaultEditorId`, `defaultImageEditorId`, `defaultArtDirectorId`, `defaultManagingEditorId`, `defaultProofwriterId` (a 7 régi alapértelmezett contributor oszlop — az új `defaultContributors` JSON pótolja).

### `articles`

**Új mezők**:
- `organizationId` (string, denormalizált)
- `editorialOfficeId` (string, denormalizált)
- `contributors` (longtext JSON) — `{groupSlug: userId}` map

**Módosult mezők**:
- `state` (integer → **string**, pl. `"designing"` a `0` helyett)
- `previousState` (integer → **string**, ugyanúgy)

**Törölt mezők**:
- `designerId`, `writerId`, `editorId`, `imageEditorId`, `artDirectorId`, `managingEditorId`, `proofwriterId` (az új `contributors` JSON pótolja)

### `layouts`, `deadlines`, `uservalidations`, `validations`

Minden kap `organizationId` + `editorialOfficeId` mezőt (denormalizált scope).

---

## Törölt collectionök

### `config`

A korábbi `workflow_config` dokumentum (config collection-ben) **megszűnik**. A workflow helye a `workflows` collection, office-onként. A `config` collection és a `syncWorkflowConfig.js` helper törlődik.

---

## Példa dokumentumok

### Organization

```json
{
  "$id": "org_sgv12",
  "name": "Teszt Kiadó Kft.",
  "slug": "teszt-kiado",
  "ownerUserId": "user_abc123",
  "createdAt": "2026-04-06T10:00:00Z"
}
```

### EditorialOffice

```json
{
  "$id": "office_mag01",
  "organizationId": "org_sgv12",
  "name": "Stílus Magazin",
  "slug": "stilus-magazin",
  "workflowId": "wf_mag01",
  "createdAt": "2026-04-06T10:00:05Z"
}
```

### Group

```json
{
  "$id": "grp_desgr",
  "editorialOfficeId": "office_mag01",
  "organizationId": "org_sgv12",
  "slug": "designers",
  "label": "Tervező",
  "color": "#FFEA00",
  "isContributorGroup": true,
  "isLeaderGroup": false,
  "description": "A magazin tördelőcsapata",
  "createdAt": "2026-04-06T10:10:00Z"
}
```

### Workflow (csak a wrapper, a `compiled` részleteket ld. [COMPILED_SCHEMA.md](COMPILED_SCHEMA.md))

```json
{
  "$id": "wf_mag01",
  "editorialOfficeId": "office_mag01",
  "organizationId": "org_sgv12",
  "name": "Stílus Magazin Workflow",
  "version": 3,
  "graph": "{\"nodes\":[...],\"edges\":[...]}",
  "compiled": "{\"version\":3,\"states\":[...],\"transitions\":[...]}",
  "updatedByUserId": "user_abc123",
  "createdAt": "2026-04-06T10:00:05Z",
  "updatedAt": "2026-04-06T14:23:10Z"
}
```

### Article (új séma)

```json
{
  "$id": "art_xyz789",
  "organizationId": "org_sgv12",
  "editorialOfficeId": "office_mag01",
  "publicationId": "pub_jun2026",
  "name": "Bevezető cikk",
  "filePath": ".maestro/bevezeto.indd",
  "pageStart": 4,
  "pageEnd": 5,
  "pageRanges": "[4,5]",
  "state": "designing",
  "previousState": null,
  "contributors": "{\"designers\":\"user_abc123\",\"editors\":\"user_def456\"}",
  "marker": 0,
  "thumbnails": "[]"
}
```
