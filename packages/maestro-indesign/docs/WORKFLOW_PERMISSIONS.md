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
