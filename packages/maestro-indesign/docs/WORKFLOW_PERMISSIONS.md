# Jogosultsági Rendszer (Workflow Permissions)

A munkafolyamat állapotátmeneteit csapat-alapú jogosultsági rendszer védi. A rendszer meghatározza, hogy egy adott felhasználó mozgathatja-e a cikket a jelenlegi állapotából — előre és hátra egyaránt.

**Forrásfájlok:**
- Konfiguráció: `src/core/utils/workflow/workflowConstants.js` (`STATE_PERMISSIONS`, `TEAM_ARTICLE_FIELD`)
- Logika: `src/core/utils/workflow/workflowPermissions.js` (`canUserMoveArticle`, `hasTransitionPermission`)

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

| Csapat slug | Cikk mező | Appwrite team ID |
|-------------|-----------|------------------|
| `designers` | `designerId` | `designers` |
| `art_directors` | `artDirectorId` | `art_directors` |
| `editors` | `editorId` | `editors` |
| `managing_editors` | `managingEditorId` | `managing_editors` |
| `proofwriters` | `proofwriterId` | `proofwriters` |
| `writers` | `writerId` | `writers` |
| `image_editors` | `imageEditorId` | `image_editors` |

---

## Jogosultsági logika

A `canUserMoveArticle(article, currentState, user)` függvény dönt:

```
1. Nincs STATE_PERMISSIONS bejegyzés az állapothoz?
   └─ IGEN → bárki mozgathatja (pl. ARCHIVABLE végállapot)

2. A releváns csapatok contributor mezőiből van-e bárki hozzárendelve?
   └─ NEM → csak a releváns csapatok tagjai mozgathatják (labels ellenőrzés)

3. A jelenlegi felhasználó az egyik hozzárendelt személy?
   └─ IGEN → mozgathatja (saját anyag)

4. A felhasználó labels tömbje tartalmazza valamelyik releváns csapat slug-ját?
   └─ IGEN → mozgathatja (label override)

5. Egyik sem teljesül → NEM mozgathatja
```

### Példa

Egy cikk `DESIGN_APPROVAL` (1) állapotban van, `artDirectorId = "user_A"`:

- **user_A** kiválasztja → **mozgathatja** (ő a hozzárendelt Art Director)
- **user_B** (Art Directors csapat tagja, de nincs hozzárendelve) → **NEM mozgathatja** (van hozzárendelt, de nem ő az)
- **user_C** (`labels: ["art_directors"]`) → **mozgathatja** (label override)
- Ha az `artDirectorId` **üres** → csak az Art Directors csapat tagjai (`labels: ["art_directors"]`) mozgathatják

---

## Label Override

Az Appwrite felhasználók `labels` tömbje (Server SDK-ból vagy Console-ból állítható) felülírhatja a hozzárendelés-alapú jogosultságot.

**Használati eset:** Egy főszerkesztő, aki bármely cikket mozgathat a szerkesztői állapotokból, anélkül hogy minden cikkhez hozzá kellene rendelni.

**Beállítás:** Az Appwrite Console-ban a felhasználó `labels` tömbjébe a csapat slug-ját kell felvenni:
```
labels: ["editors", "managing_editors"]
```

**Frissítés:** A `labels` tömb a bejelentkezéskor kerül lekérdezésre (`account.get()`). Ha egy admin megváltoztatja a felhasználó label-jeit az Appwrite Console-ban, a felhasználónak újra be kell töltenie a plugint (`uxp:reload`), hogy az új label-ek érvényesüljenek. (Az Appwrite Realtime `account` csatorna nem tüzel szerver-oldali label módosításra.)

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

A dropdown-ok a `ContributorsSection.jsx` komponensben találhatók, és a `useTeamMembers` hook-kal kérdezik le az egyes csapatok tagjait.

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
