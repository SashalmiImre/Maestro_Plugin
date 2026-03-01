# Jogosultsági Rendszer (Workflow Permissions)

A munkafolyamat állapotátmeneteit csapat-alapú jogosultsági rendszer védi. A rendszer meghatározza, hogy egy adott felhasználó mozgathatja-e a cikket a jelenlegi állapotából — előre és hátra egyaránt.

**Forrásfájlok:**
- Konfiguráció: `src/core/utils/workflow/workflowConstants.js` (`STATE_PERMISSIONS`, `TEAM_ARTICLE_FIELD`)
- Logika: `src/core/utils/workflow/workflowPermissions.js` (`canUserMoveArticle`, `hasTransitionPermission`)
- User adatok: `src/core/contexts/UserContext.jsx` (`user.teamIds`, `user.labels`)

---

## Állapot → Csapat leképezés (`STATE_PERMISSIONS`)

Meghatározza, mely csapatok mozgathatják a cikkeket az adott állapotBÓL:

| Állapot | Csapatok |
|---------|----------|
| DESIGNING (0) | Designers, Art Directors |
| DESIGN_APPROVAL (1) | Art Directors |
| WAITING_FOR_START (2) | Designers, Art Directors |
| EDITORIAL_APPROVAL (3) | Editors, Managing Editors |
| CONTENT_REVISION (4) | Proofwriters |
| FINAL_APPROVAL (5) | Editors, Managing Editors |
| PRINTABLE (6) | Designers, Art Directors |
| ARCHIVABLE (7) | — (végállapot, nincs átmenet) |

---

## Csapat → Cikkmező leképezés (`TEAM_ARTICLE_FIELD`)

Meghatározza, melyik csapat melyik cikkmező értékéhez van kötve a jogosultsági ellenőrzésben:

| Label slug | Cikk mező | Appwrite team ID |
|-------------|-----------|------------------|
| `designers` | `designerId` | `designers` |
| `artDirectors` | `artDirectorId` | `art_directors` |
| `editors` | `editorId` | `editors` |
| `managingEditors` | `managingEditorId` | `managing_editors` |
| `proofwriters` | `proofwriterId` | `proofwriters` |
| `writers` | `writerId` | `writers` |
| `imageEditors` | `imageEditorId` | `image_editors` |

---

## Kétszintű jogosultság

A jogosultság két egymást kiegészítő forrásból származik:

| Forrás | Mező | Beállítás | Cél |
|--------|------|-----------|-----|
| **Csapattagság** | `user.teamIds` | Appwrite Console → Teams → tag hozzáadás | Alap jogosultság a munkahelyi pozíció alapján |
| **Label override** | `user.labels` | Appwrite Console → User → Labels | Plusz jogosultságok egyedi hozzárendeléssel |

Mindkettő csapat slug-okat tartalmaz (pl. `"designers"`, `"editors"`). A permission ellenőrzés mindkettőt vizsgálja — ha **bármelyikben** megtalálható a releváns csapat slug-ja, a jogosultság megvan.

---

## Jogosultsági logika

A `canUserMoveArticle(article, currentState, user)` függvény dönt:

```
1. Nincs STATE_PERMISSIONS bejegyzés az állapothoz?
   └─ IGEN → bárki mozgathatja (pl. ARCHIVABLE végállapot)

2. A releváns csapatok contributor mezőiből van-e bárki hozzárendelve?
   └─ NEM → csapattagság (teamIds) VAGY label szükséges

3. A jelenlegi felhasználó az egyik hozzárendelt személy?
   └─ IGEN → mozgathatja (saját anyag)

4. A felhasználó csapat tagja (teamIds) VAGY labels tartalmazza a releváns slug-ot?
   └─ IGEN → mozgathatja (csapattagság / label override)

5. Egyik sem teljesül → NEM mozgathatja
```

### Példa

Egy cikk `DESIGN_APPROVAL` (1) állapotban van, `artDirectorId = "user_A"`:

- **user_A** kiválasztja → **mozgathatja** (ő a hozzárendelt Art Director)
- **user_B** (Art Directors csapat tagja) → **mozgathatja** (csapattagság)
- **user_C** (`labels: ["artDirectors"]`) → **mozgathatja** (label override)
- **user_D** (nem tag, nincs label) → **NEM mozgathatja**
- Ha az `artDirectorId` **üres** → csak az Art Directors csapat tagjai (`teamIds` vagy `labels`) mozgathatják

---

## Realtime szinkronizáció

### Csapattagság (`user.teamIds`)
A `UserContext` a `teams.list()` API-val kérdezi le a bejelentkezett felhasználó csapatait. A `teamIds` mező frissül:
- **Login**: `enrichUserWithTeams()` → `teams.list()` → `user.teamIds`
- **App indulás**: `checkUserStatus` → `enrichUserWithTeams()`
- **Team tagság változás**: `teams` Realtime csatorna → `teamMembershipChanged` MaestroEvent → `teams.list()` → `user.teamIds` frissül
- **Recovery** (sleep/wake): `dataRefreshRequested` → `account.get()` + `teams.list()` → teljes frissítés

### Labels (`user.labels`)
- **Login/Recovery**: `account.get()` → `user.labels`
- **Realtime**: `account` csatorna → payload tartalmazza a friss `labels` tömböt

Mindkét szinkronizáció azonnali UI frissítést eredményez (a `user` state változása React re-render-t vált ki).

---

## Háromszintű védelem

A jogosultsági ellenőrzés három ponton fut, egymást erősítve:

```
┌─────────────────────────────────────────────────────────────┐
│  1. UI szint (GeneralSection)                               │
│     A transition gombok `disabled` állapota                 │
│     → megelőzi a felesleges kattintást                      │
├─────────────────────────────────────────────────────────────┤
│  2. Handler szint (ArticleProperties.handleStateTransition) │
│     Toast üzenet a felhasználónak                           │
│     → védi a közvetlen handler hívást                       │
├─────────────────────────────────────────────────────────────┤
│  3. Engine szint (WorkflowEngine.executeTransition)         │
│     Végső biztonsági háló                                   │
│     → megakadályozza a DB írást jogosultság nélkül          │
└─────────────────────────────────────────────────────────────┘
```

---

## Contributor mezők (Appwrite articles collection)

A jogosultsági rendszer az alábbi contributor mezőket használja a cikkeken:

| Mező | Típus | Leírás | UI dropdown |
|------|-------|--------|-------------|
| `writerId` | string (36) | Szerző | Szerző |
| `editorId` | string (36) | Szerkesztő | Szerkesztő |
| `imageEditorId` | string (36) | Képszerkesztő | Képszerkesztő |
| `designerId` | string (36) | Tervező | Tervező |
| `proofwriterId` | string (36) | Korrektor | Korrektor |
| `artDirectorId` | string (36) | Művészeti vezető | Művészeti vezető |
| `managingEditorId` | string (36) | Vezetőszerkesztő | Vezetőszerkesztő |

A dropdown-ok a `ContributorsSection.jsx` komponensben találhatók, és a `useTeamMembers` hook-kal kérdezik le az egyes csapatok tagjait (Realtime szinkronnal).

---

## UI Elem Jogosultságok

Az állapotátmenet-jogosultságon túl az egyes UI elemek szerkeszthetősége is csapat/label alapján van korlátozva. Csapat/label nélküli felhasználó teljes read-only módot kap — minden interaktív elem disabled, csak böngészhet.

**Forrásfájlok:**
- Konfiguráció: `src/core/utils/workflow/elementPermissions.js`
- Hook: `src/data/hooks/useElementPermission.js`

### Jogosultsági szintek

| Típus | Leírás |
|-------|--------|
| Csapattömb | Csak a felsorolt csapatok szerkeszthetik (pl. `["designers", "artDirectors"]`) |
| `ANY_TEAM` | Bárki, akinek van legalább egy csapattagsága vagy label-je |
| Állapotfüggő | Tervezők/művészeti vezetők mindig, mások a `STATE_PERMISSIONS` alapján |

### Cikk-szintű elemek (állapotfüggetlen)

| Elemcsoport | Csapatok |
|-------------|----------|
| `articleName` | Editors, Designers, Managing Editors, Art Directors |
| `articlePages` | Designers, Art Directors |
| `articleLayout` | Designers, Art Directors |
| `validationForm` | ANY_TEAM |
| `validationActions` | ANY_TEAM |
| `ignoreToggle` | Editors, Designers, Managing Editors, Art Directors |

### Contributor dropdown-ok (per-dropdown, állapotfüggő)

A cikk ContributorsSection 7 dropdown-ja egyenként van vezérelve a `canEditContributorDropdown()` függvénnyel:

- **Vezetők** (Managing Editors, Art Directors) → bármely dropdown, bármely állapotban
- **Nem-vezetők** → csak a saját csapatjuknak/label-jüknek megfelelő dropdown-ot szerkeszthetik, és csak ha a cikk olyan állapotban van, ahol az adott team-slug szerepel a `STATE_PERMISSIONS`-ben

| Team/Label slug | Szerkeszthető dropdown | Aktív állapotok |
|-----------------|----------------------|-----------------|
| editors | editorId | EDITORIAL_APPROVAL, FINAL_APPROVAL |
| designers | designerId | DESIGNING, WAITING_FOR_START, PRINTABLE |
| proofwriters | proofwriterId | CONTENT_REVISION |
| writers | writerId | *(nincs STATE_PERMISSIONS → soha)* |
| imageEditors | imageEditorId | *(nincs STATE_PERMISSIONS → soha)* |

A kiadvány ContributorsSection-ben csak a vezetők szerkeszthetik a dropdown-okat (`publicationContributors`).

### Állapotfüggő elemek

| Elem | Szabály |
|------|---------|
| Fájl megnyitás | Designers/Art Directors: mindig. Mások: csak ha a cikk a STATE_PERMISSIONS szerinti állapotban van |
| Parancsok (export, collect, preflight, archive, print) | Ugyanaz mint a fájl megnyitás |

### Kiadvány-szintű elemek

| Elemcsoport | Csapatok |
|-------------|----------|
| `publicationGeneral` | Editors, Managing Editors, Art Directors |
| `publicationLayouts` | Designers, Art Directors |
| `publicationDeadlines` | Editors, Managing Editors, Art Directors |
| `publicationContributors` | Editors, Managing Editors, Art Directors |

### Kompozíció

Az elem-jogosultság a meglévő disabled logikával együtt működik — az elem disabled, ha **bármelyik** feltétel igaz:

```
disabled = isIgnored || isSyncing || !permission.allowed
```

---

## Konfiguráció módosítása

### Új állapot-csapat hozzárendelés

A `workflowConstants.js` fájlban a `STATE_PERMISSIONS` objektumot kell módosítani:

```javascript
export const STATE_PERMISSIONS = {
    [WORKFLOW_STATES.DESIGNING]: ["designers", "art_directors"],
    // ...
};
```

### Új csapat hozzáadása

1. Appwrite Console-ban új team létrehozása
2. `appwriteConfig.js` → `TEAMS` objektumba felvenni
3. `workflowConstants.js` → `TEAM_ARTICLE_FIELD` leképezésbe felvenni
4. Ha szükséges: új contributor mező az articles collection-ben + dropdown a `ContributorsSection.jsx`-ben
