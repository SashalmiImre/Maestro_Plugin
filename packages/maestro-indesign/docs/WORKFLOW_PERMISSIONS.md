# Jogosultsági Rendszer (Workflow Permissions)

A munkafolyamat állapotátmeneteit csapat-alapú jogosultsági rendszer védi. A rendszer meghatározza, hogy egy adott felhasználó mozgathatja-e a cikket a jelenlegi állapotából — előre és hátra egyaránt.

**Forrásfájlok:**
- Capability label konfiguráció: `maestro-shared/labelConfig.js` (`CAPABILITY_LABELS`, `resolveGrantedTeams`, `hasCapability`)
- Label → csapat feloldás: `maestro-shared/workflowConfig.js` (`labelMatchesSlug`)
- Állapot-jogosultság konfiguráció: `src/core/utils/workflow/workflowConstants.js` (`STATE_PERMISSIONS`, `TEAM_ARTICLE_FIELD`, `COMMANDS`)
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
| **Capability label** | `user.labels` | Appwrite Console → User → Labels | Képesség-alapú jogosultság-kiterjesztés |

A `user.teamIds` csapat slug-okat tartalmaz (pl. `"designers"`, `"editors"`). A `user.labels` **capability neveket** tartalmaz (`can` + ige + tárgy, camelCase — pl. `"canEditContent"`, `"canUseDesignerFeatures"`), amelyeket a `labelConfig.js` központi konfiguráció old fel csapat slug-okra.

### Capability Label Rendszer

**Forrásfájl:** `maestro-shared/labelConfig.js`

A capability label-ek két típusúak:

| Típus | Működés | Példa |
|-------|---------|-------|
| **Csapat-ekvivalens** (`grantTeams`) | A label a megadott csapat(ok) jogait adja | `canEditContent` → `['editors']` jogokat ad |
| **Exkluzív** (`exclusive`) | Egyedi képesség, csapattagsággal nem kapható meg | `canAddArticlePlan` → cikk terv InDesign nélkül |

#### Elérhető capability label-ek

| Label név | Típus | grantTeams | Leírás |
|-----------|-------|------------|--------|
| `canUseDesignerFeatures` | grant | `['designers']` | Tervezői funkciók használata |
| `canApproveDesigns` | grant | `['art_directors']` | Tervek jóváhagyása |
| `canEditContent` | grant | `['editors']` | Szerkesztői funkciók |
| `canManageEditorial` | grant | `['managing_editors']` | Vezetőszerkesztői jogok |
| `canProofread` | grant | `['proofwriters']` | Korrektúrázás |
| `canWriteArticles` | grant | `['writers']` | Íráshoz való hozzáférés |
| `canEditImages` | grant | `['image_editors']` | Képszerkesztői hozzáférés |
| `canUseEditorFeatures` | grant | `['editors']` | Szerkesztői UI jogok (pl. tördelőnek) |
| `canAddArticlePlan` | exclusive | — | Cikk terv hozzáadása InDesign fájl nélkül |

#### Feloldási logika

A `labelMatchesSlug(userLabels, slug)` függvény a `resolveGrantedTeams()` segítségével oldja fel a capability label-eket csapat slug-okra. Az összes meglévő jogosultság-ellenőrző függvény (`canUserMoveArticle`, `checkElementPermission`, `canUserAccessInState`, `canEditContributorDropdown`) változatlanul a `labelMatchesSlug`-ot hívja — a capability mapping transzparens.

#### Példa

Egy tördelő (designers csapattag) szerkesztői jogokat kap:
- Appwrite Console → User → Labels: `["canEditContent"]`
- A `canEditContent` label → `grantTeams: ['editors']` → a rendszer úgy kezeli, mintha az editors csapatba is tartozna
- Eredmény: szerkesztheti az `articleName` mezőt, mozgathatja a cikket EDITORIAL_APPROVAL állapotból stb.

#### Új capability hozzáadása

1. `maestro-shared/labelConfig.js` → `CAPABILITY_LABELS` objektumba felvenni
2. Ha exkluzív: `hasCapability()` hívás a releváns ellenőrző függvénybe
3. Ha csapat-ekvivalens: automatikusan működik a `resolveGrantedTeams` feloldáson keresztül

---

## Jogosultsági logika

A `canUserMoveArticle(article, currentState, user)` függvény dönt:

```
1. Nincs STATE_PERMISSIONS bejegyzés az állapothoz?
   └─ IGEN → bárki mozgathatja (pl. ARCHIVABLE végállapot)

2. A felhasználónak csapattagsága (teamIds) VAGY label override-ja van a releváns csapatokhoz?
   └─ IGEN → mozgathatja
   └─ NEM  → NEM mozgathatja
```

A közvetlen hozzárendelés (contributor mező) **nem ad** önálló átmenet-jogosultságot — csapattagság vagy label mindig szükséges. Ez megakadályozza, hogy egy véletlenül rossz mezőbe beállított felhasználó (pl. editor a `designerId`-ban) a csapatától független jogot kapjon.

### Példa

Egy cikk `DESIGN_APPROVAL` (1) állapotban van:

- **user_A** (Art Directors csapat tagja) → **mozgathatja** (csapattagság)
- **user_B** (`labels: ["canApproveDesigns"]`) → **mozgathatja** (capability label → `art_directors` jog)
- **user_C** (Editor csapat tagja, de az `artDirectorId` mezőbe van beállítva) → **NEM mozgathatja** (az Editors csapat nem szerepel a DESIGN_APPROVAL STATE_PERMISSIONS-ben)
- **user_D** (nem tag, nincs label) → **NEM mozgathatja**

---

## Realtime szinkronizáció

### Csapattagság (`user.teamIds`)
A `UserContext` a `teams.list()` API-val kérdezi le a bejelentkezett felhasználó csapatait. A `teamIds` mező frissül:
- **Login**: `enrichUserWithTeams()` → `teams.list()` → `user.teamIds`
- **App indulás**: `checkUserStatus` → `enrichUserWithTeams()`
- **Team tagság változás (kliens-oldali)**: `teams` Realtime csatorna → `teamMembershipChanged` MaestroEvent → `teams.list()` → `user.teamIds` frissül
- **Team tagság változás (szerver-oldali)**: `account` Realtime csatorna → `events[]` tartalmaz `.memberships.` stringet → `teams.list()` → `user.teamIds` azonnali frissítés *(fallback, ha az admin szerveren változtatja a tagságot)*
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

### Parancsonkénti jogosultságok (`COMMANDS` regiszter)

Az egyes parancsokhoz csapatszintű jogosultság van rendelve a `COMMANDS` objektumban (`workflowConstants.js`). Az állapot csak azt határozza meg, mely parancsok **jelennek meg** — hogy egy adott felhasználó **futtathatja-e**, azt a `teams[]` lista dönti.

| Parancs | Engedélyezett csapatok |
|---------|----------------------|
| `export_pdf` | Designers, Art Directors |
| `export_final_pdf` | Designers, Art Directors |
| `collect_images` | Designers, Art Directors |
| `collect_selected_images` | Designers, Art Directors |
| `preflight_check` | Designers, Art Directors |
| `archive` | Designers, Art Directors |
| `print_output` | Designers, Art Directors |

Az ellenőrzés: `user.teamIds` vagy `user.labels` tartalmaz-e valamelyik engedélyezett csapatot. Ha nem, a gomb `disabled` + tooltip jelenik meg.

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

### Új parancs jogosultság módosítása

A `workflowConstants.js` fájlban a `COMMANDS` objektumban kell módosítani a `teams[]` tömböt:

```javascript
export const COMMANDS = {
    'export_pdf': { label: 'PDF írás', teams: ['designers', 'art_directors'] },
    // ...
};
```

### Új csapat hozzáadása

1. Appwrite Console-ban új team létrehozása
2. `appwriteConfig.js` → `TEAMS` objektumba felvenni
3. `workflowConstants.js` → `TEAM_ARTICLE_FIELD` leképezésbe felvenni
4. Ha szükséges: új contributor mező az articles collection-ben + dropdown a `ContributorsSection.jsx`-ben
