---
aliases: [TODO, Tasks, Teendők]
tags: [feladatok]
---

# Feladatok

> Ide gyűjtsd a fejlesztési ötleteket, bugokat, teendőket. A Claude Code is olvassa — megbeszéljük, majd kipipáljuk.

## Aktív

### Dashboard finomítás (webes felület)

> Workflow: 1 bullet = 1 commit, utána kipipálás. A témakörök sorrendben haladhatók, de C és D függetlenek.

#### A. Breadcrumbs viselkedés

- [x] 23. **„Beállítások" menüpont áthelyezés**: első listaelemként, ikon nélkül, a többi menüponttal azonos stílusban. A beállítás utáni divider marad (vizuális elválasztás a lista többi részétől).
- [x] 24. **Aktív elem eltávolítása a listából**: a breadcrumb dropdown ne tartalmazza a már kiválasztott elemet (a trigger gombon már látszik a neve).
- [x] 25. **„+ Új …" menüpont eltávolítása mindhárom breadcrumb dropdown-ból** (szervezet, szerkesztőség, kiadvány). A létrehozás a megfelelő beállítás panelre költözik (26, 28).

#### B. Szervezet beállítás panel (OrganizationSettingsModal tab-osítás)

- [x] 26. **Általános tab**: szervezet név szerkesztése + „Új szerkesztőség" gomb (modal a létrehozáshoz) + szervezet törlés (DangerZone).
- [x] 27. **Felhasználók tab**: aktuális invite flow + függő meghívók + szervezeti tagok listája ide költöztetve.

#### C. Szerkesztőség beállítás panel (EditorialOfficeSettingsModal tab-osítás)

- [x] 28. **Általános tab**: szerkesztőség név szerkesztése + „Új kiadvány" gomb (a jelenlegi CreatePublicationModal rootPath nélküli változatával, ld. 31) + szerkesztőség törlés.
- [x] 29. **Csoportok tab**: csoport CRUD (létrehozás, átnevezés, törlés) + tag×csoport mátrix + csoportok jogosultság-sablon placeholder (a konkrét jogosultságok modelt később pontosítjuk).
    - Szerver oldal: új CF-ek (`create_group`, `rename_group`, `delete_group`) a meglévő invite-to-organization CF mintájára.
    - Validáció: csoport törlésnél a workflow-k `compiled.elementPermissions` orphan entry-jei tisztítandók vagy visszautasítva (ha a csoport használatban van).
- [x] 30. **Workflow tab**: workflow-k listája, tervező megnyitás, új workflow létrehozása, átnevezés, „más néven mentés" (duplikáció), láthatóság (`visibility` enum 2-way MVP: `organization` / `editorial_office`) + `createdBy` user FK. Schema bootstrap (`bootstrap_workflow_schema` CF action). Delete blocking scan a hivatkozó publikációkra. Plugin 2-way `Query.or` fetch + Realtime `isVisible` szűrés. (`public`/`private` érték halasztva: külön iterációban jöhet, ha felmerül az igény.)

#### D. Kiadvány beállítás panel & Plugin rootPath flow

- [x] 31. **Dashboard — rootPath opcionális**: `CreatePublicationModal` rootPath mezője opcionális. A `publications` collection rootPath mező nullable (schema frissítés + `validate-publication-update` szerver-oldali engedékenység).
- [x] 32. **Szerver — `set-publication-root-path` CF**: új Appwrite Function, amely kizárólag null-ról nem-null kanonikus formátumra engedi a rootPath írást. Kanonikus validáció + office-scope check + caller jogosultság (office admin VAGY org owner/admin fallback).
- [x] 33. **Plugin — DataContext**: a `publications` query nem szűri ki a rootPath nélküli aktív publikációkat. Új UI állapot: „konfiguráció szükséges" kiadvány (letiltott cikk műveletek, figyelmeztető banner).
    - Harden finding (halasztva): tri-state `useDriveAccessibility` map (`accessible` / `inaccessible` / `checking`). Jelenlegi optimista `?? true` default miatt rootPath beállítása után egy rövid (async ExtendScript ablak) ideig kék fejléc villanhat, mielőtt piros lenne, ha a meghajtó nem elérhető. Külön iterációban megoldható.
- [x] 34. **Plugin — folder picker modal**: UXP `storage.localFileSystem.getFolder()` alapú folder picker, a kiválasztott natív útvonal `toCanonicalPath()`-on átkonvertálva, majd `set-publication-root-path` CF hívás. Cross-platform MOUNT_PREFIX validáció.
- [x] 35. **Dashboard — rootPath panel (r/o)**: `GeneralTab` mutassa a rootPath-t read-only-ban, jelezze, ha még nincs beállítva („Beállítva a Pluginból …").

#### E. Workflow snapshot aktiváláskor

- [x] 36. **Publications schema**: új `compiledWorkflowSnapshot` string mező (JSON). Schema migráció.
- [x] 37. **Aktiválás CF**: `validate-publication-update` (vagy dedikált `activate-publication` CF) aktiváláskor beolvassa a workflow `compiled` mezőjét és a publikációba írja (snapshot). Továbbiakban a mező immutable.
- [x] 38. **Plugin — snapshot preferálás**: `DataContext` workflow feloldás preferáltan a `compiledWorkflowSnapshot`-ból (ha van), fallback a `workflowId` → `workflows[]` cache-re (legacy publikációk).
- [x] 39. **Dashboard — designer guard**: ha egy workflow-t már snapshot-oltak legalább egy aktív publikációhoz, a designer figyelmeztet, hogy a változás csak új aktiválásoknál érvényesül.

#### F. User avatar menü bővítés (globális szint)

- [x] 40. **„Új szervezet…" menüpont** a user avatar dropdown-ban: modal-os create flow (név + slug). Jelenlegi `bootstrap_organization` CF újrahasznosítása.
    - Szerver: új `create_organization` CF action a `bootstrap_organization` mellett — ugyanaz a 7 lépéses atomikus create logika, de az idempotencia check kihagyva (a caller már tagja egy meglévő orgnak, mégis explicit új-t kér).
    - Dashboard: új `slugify()` utility (HU transliteráció + kebab-case) + `AuthContext.createNewOrganization()` callback + `CreateOrganizationModal` komponens (név → auto-slug, default office név „Általános" + slug `altalanos`). Sikeres create után scope váltás új org + office-ra, success toast.
    - UserAvatar dropdown első menüpontja: „Új szervezet…" — kattintásra `sm` méretű modal nyílik.
- [x] 41. **„Maestro beállítások" menüpont**: modal, benne: saját szervezetek listája (váltás/kilépés), függőben lévő invite-ok (fogadás/elutasítás).
    - Szerver: 3 új CF action az `invite-to-organization`-ben:
        - `list_my_invites` — caller email-jére regisztrált pending invite-ok API key-jel (a kliensnek nincs read joga az `organizationInvites` doc-okra, amíg nincs az org team-ben), denormalizált org-név + meghívó név mezőkkel.
        - `decline_invite` — token + e-mail match védelem (mint az `accept`-nél), `status='declined'` set; idempotens.
        - `leave_organization` — last-owner blokk (`last_owner_block` ha van más tag, `last_member_block` ha egyedüli — UI a `delete_organization`-t ajánlja); cascade delete: caller `editorialOfficeMemberships` (org alatti összes office) + `groupMemberships` + `organizationMemberships`; team membership cleanup `org_${orgId}` + per-office `office_${officeId}`.
        - Új `removeTeamMembership(teams, teamId, userId)` helper a `teamHelpers.js`-ben (listMemberships + deleteMembership, idempotens 404 + 409-re).
    - Dashboard: `AuthContext.listMyInvites/declineInvite/leaveOrganization` callback-ek; új `MaestroSettingsModal` (Szervezeteim szekció: aktív scope jelzés + role badge + Kilépés gomb név-verifikáló ConfirmDialog-gal; Függő meghívóim szekció: org név + meghívó név + role + lejárati formázás + Elfogadom/Elutasítom gombok).
    - UserAvatar dropdown első menüpontja: „Maestro beállítások" — `md` méretű modal.

#### G. Dashboard design review (2026-04-17)

> Forrás: Claude design plugin (`/design-critique` + `/accessibility-review` + `/ux-copy` + `/design-system`). Screenshotok alapján készült audit, 17 view lefedve. Részletes design system dokumentum: [packages/maestro-dashboard/design-system.md](../packages/maestro-dashboard/design-system.md).

**Kritikus (🔴) — blokkoló:**

- [x] 42. **Primary CTA kontraszt-fix (WCAG AA)**: `--accent-solid` (`#3b82f6`) + fehér szöveg = 3.7:1, bukik AA normal-t. Váltás `#2563eb`-re (5.1:1). Egysoros token-változás a `css/styles.css`-ben. Érint: login CTA, modal Létrehozás gombok, Meghívás, minden primary button.
- [x] 43. **IconButton `aria-label` konvenció**: minden ikon-only gomb kötelezően `aria-label`-et kap. Sweep lista: breadcrumb dropdown triggerek, szűrők nyitás, avatar menü, Workflow Designer node-akciók, jobb felső toolbar ikonok.
- [x] 44. **Landing empty state újratervezés**: a bejelentkezés utáni üres képernyő jelenleg csak egy szürke szöveget mutat, nincs elsődleges CTA. Új `<EmptyState>` komponens: címsor („Még nincs kiadványod"), leírás, primary gomb „Kiadvány létrehozása" (Office Settings → Általános tabot nyitja) + secondary link „Szervezet beállításai".
- [x] 45. **Breadcrumb „Kiadvány" gomb üres scope-ban**: jelenleg enabled de kattintásra no-op (silent zsákutca). Disabled állapot + tooltip („Először hozz létre egy kiadványt a Szerkesztőség beállításokban"), VAGY egysoros dropdown „Nincs kiadvány — Új létrehozása" linkkel.
- [x] 46. **Workflow node marker kódok accessibility**: FA/PN/FN/EP vizuális markerek screen reader-nek értelmezhetetlenek. `aria-label` a teljes validáció-névvel minden node-on. Opcionálisan hover-tooltip a canvason.

**Mérsékelt (🟡):**

- [x] 47. **Org/Office breadcrumb egy-elemű dropdown megszüntetése**: ha a dropdown-ban csak „Beállítások" van, a breadcrumb gomb közvetlenül nyissa a modalt (dropdown kihagyva). Többtagú dropdown csak akkor, ha tényleg van választási lehetőség (több org/office).
- [x] 48. **Spacing + radius tokenek bevezetése**: `--space-1..8` (4–64px) és `--radius-sm/md/lg/xl` (4/6/8/12px) a `styles.css` `:root`-ba. Sweep a 2299 soros fájlon, cseréld a magic number-eket tokenekre. Részletek: [design-system.md](../packages/maestro-dashboard/design-system.md).
- [x] 49. **Workflow tab sor sűrítés**: 5 vezérlő/sor zsúfolt. Visibility combobox és „Tervező →" marad inline, Átnevezés/Duplikálás/Törlés kebab-menübe (⋯).
- [x] 50. **Filter „popover" vs teljes sáv inkonzisztencia**: a trigger gomb popover-elvárást ad, de a tartalom teljes szélességű sáv. Döntés: vagy valódi popover (a trigger mellett felnyíló panel), vagy a trigger cseréje toggle-sávra/accordion fejlécre.
- [x] 51. **DangerAction pattern egységesítés**: a Veszélyes zóna stílus (piros keret + subtle háttér) három helyen háromféle: Org/Office modalban keretes box, Workflow Designer „Állapot törlése"-nél sima szöveges gomb. Egységes `.danger-action` CSS class + dokumentáció a design-system.md-ben.
- [x] 52. **`--text-muted` kontraszt `--bg-elevated` felett**: 4.1:1, AA normal fail. Vagy világosítás `#9aa0b0`-ra (4.7:1), vagy ne használjuk elevated felszín felett.
- [x] 53. **State/validáció szín + szöveg kettős kódolás**: color-blind user-ek a 9 workflow állapotot nehezen különböztetik meg csak a színes dot alapján. State-specifikus ikon a dot mellé VAGY egyedi szöveges prefix a filter checkbox label-ben.
- [x] 54. **Elavult copy „bal oldali navigáció"**: Office Settings → Általános → Kiadványok szekció hivatkozik nem létező bal oldali navigációra. Javítás: „…a Kiadvány menüben (breadcrumb)…".
- [x] 55. **Magyar/angol keverés sweep**: „OWNEREK" (Org Settings → Felhasználók) → „Tulajdonosok". Teljes UI átnézés angol szavakért: `owners`, `admins`, `members`, `invites`, `flatplan`.
- [x] 56. **„Hamarosan" placeholder egységesítés**: jelenleg 3+ helyen szerepel (Jogosultság-sablonok, Elem jogosultságok, Képességek). Vagy rejtsd el, amíg nincs funkció, vagy egységes frázis + ETA.

**Minor (🟢) — polish:**

- [x] 57. **Login/Register CTA szöveg redundancia**: tab + primary CTA ugyanaz a szöveg. CTA: „Belépés" / „Fiók létrehozása".
- [x] 58. **Új kiadvány modal disabled CTA hint**: disabled „Létrehozás" mellé inline help: „Add meg a nevet és válassz workflow-t."
- [x] 59. **Workflow állapot törlése confirm dialog**: copy: „Biztosan törlöd a(z) „{állapot neve}" állapotot? A cikkek, amelyek ebben az állapotban vannak, a kezdőállapotra kerülnek."

#### H. Biztonság / ACL (Fázis 2 follow-up)

> Forrás: Codex adversarial review (2026-04-18) — a dashboard tenant Realtime Fázis 2 diff-jére. Frontend-oldalon az `useTenantRealtimeRefresh` már scope-szűr (UX redundáns reload elkerülése), de a szerveroldali ACL továbbra is minden authenticated kliensnek push-olja a raw WS payload-ot → cross-tenant payload leakage.

- [x] 60. **Tenant scope ACL redesign — `groups` / `groupMemberships` / `organizationInvites`**. A 3 collection jelenleg `read("users")` ACL-lel (`rowSecurity: false` vagy equivalent) olvasható, így az Appwrite Realtime minden bejelentkezett usernek kézbesíti a payload-ot függetlenül a tenant-hovatartozástól. A raw WS üzenet így más szervezetek csoport-neveit, tag email-címeit és függő meghívóit is kiszivárogtatja minden klienshez — a frontend scope-szűrés csak a UI-reload zajt oldja meg, a confidentiality-t nem.
    - Szerver: per-dokumentum ACL (pl. `read("team:${organizationId}")` vagy explicit `read("user:${userId}")` tag-ek a tagokra) + `rowSecurity: true`. Érintett CF write path-ok, amelyek ACL tag-et kell állítsanak dokumentum create/update-en: `bootstrap_organization`, `create_group` / `rename_group` / `delete_group`, `add_group_member` / `remove_group_member`, `invite-to-organization` (minden meghívó életciklus).
    - Adat-migráció: meglévő `groups` / `groupMemberships` / `organizationInvites` dokumentumok backfill-je a korrekt ACL tag-ekkel (one-shot CF action, idempotens).
    - Teszt: két külön szervezetbe belépett két user két különálló böngészőben — egyik tenantban végzett mutation (pl. új csoport, meghívó kiküldés, tag hozzáadás) ne generáljon WS payload-ot a másik tenant kliensén (Appwrite Realtime inspector / `client.subscribe` log).
    - **Megjegyzés**: amíg ez nincs meg, Fázis 2 adminisztratív adatok (csoport struktúra, meghívó email-ek) gyakorlatilag nyilvánosak minden authenticated felhasználó számára — **mielőbbi fix javasolt**.

#### I. Workflow Designer design review (2026-04-19)

> Forrás: `/design-critique` live run a `/admin/office/:officeId/workflow/:workflowId` nézeten (6 screenshot, 7 kulcsnézet), persona: art director / managing editor, desktop 1440–1920px, ritka használat. A 42/43/46/48/51/59 pontokat NEM ismételjük.

**Kritikus (🔴) — blokkoló vagy magas friction:**

- [x] 61. **NodePalette szemantikus újratervezés**: 6 azonos item helyett egyetlen „+ Új állapot" gomb, amely a `nextAvailableColor()` (maestro-shared) helperrel a `WORKFLOW_STATE_COLORS` palettájából a legközelebbi még szabad színt húzza (case-insensitive). A WorkflowDesignerPage `usedNodeColors` memo-t pump-ol be a Palette-be. Ha minden szín foglalt, a paletta ciklikusan újrahasznosít — a hint sávban erről info látható.
- [x] 62. **StateNode badge hover-expand**: kódbadge két `<span>` — `state-node__badge-code` (default) és `state-node__badge-full` (hover). CSS `display` swap, native `title` eltávolítva (aria-label maradt screen reader-nek). Hover-on a teljes validátor/parancs név látszik a node-on belül popup nélkül.
- [x] 63. **Dirty indikátor kiemelése**: warning színű pulzáló pötty a workflow név input mellett (VS Code tab minta), `prefers-reduced-motion` esetén animáció kikapcsolva. Aria-label és role=status a screen reader-nek; a jobb oldali „Nem mentett változások" szöveg megmarad másodlagos info-ként.
- [x] 64. **State editor collapsible default + itemszám badge**: mindhárom szekció (`Validációk` / `Parancsok` / `Mozgatási jogosultság`) ZÁRVA alapból, az aszimmetria megszűnt. Minden trigger label a darabszámot mutatja (`Validációk (3)`, `Parancsok (2)`, `Mozgatási jogosultság (4 csoport)`). `aria-expanded` minden trigger-en a screen reader-eknek.
- [x] 65. **TransitionPropertiesEditor „Útvonal" human label**: a state human label (pl. „Tervezés") elsődleges, a slug (`designing`) monospace másodlagos sor. WorkflowDesignerPage-ben felépített `stateLabels` map prop-on át a TransitionPropertiesEditor-hez. Ha a label === slug (új state), csak a slug látszik (duplikáció elkerülve).
- [x] 66. **Validáció oszlop-fejléc magyarázat**: a három mező új label-eket kapott — „Akció: belépéskor futtatódik", „Ellenőrzés: belépés feltétele", „Ellenőrzés: kilépés feltétele". Új `helpText` prop a `ValidationListField`-en, a label alatt italic magyarázó szöveg (`.designer-field__help` CSS class).
- [x] 67. **`WORKFLOW_STATE_COLORS` közös token**: új `maestro-shared/workflowStateColors.js` modul (8 hex paletta + `nextAvailableColor()` helper). A NodePalette és a defaultWorkflow.json színei innen származnak — egységes vizuális paletta. Case-insensitive összehasonlítás a `nextAvailableColor`-ban (lower-case legacy értékek is használtnak számítanak).

**Mérsékelt (🟡):**

- [ ] 68. **StateNode szélesség magyar címkéknek**: 190px fix szélesség truncál hosszabb magyar állapotneveket („Tervellenőrzés kiadó által"). Javaslat: `min-width: 180px; max-width: 240px` + `word-break: break-word` a `.state-node__label`-re. [workflowDesigner.css](../packages/maestro-dashboard/src/features/workflowDesigner/workflowDesigner.css) `.state-node` + `.state-node__label`.
- [ ] 69. **Collapsible `aria-expanded` + `aria-controls`**: a Validációk / Parancsok / Mozgatási jogosultság trigger gombok csak vizuális chevron-t (▾/▸) mutatnak, screen reader nem tudja az állapotot. Javaslat: `aria-expanded={isOpen}` + `aria-controls={panelId}` minden triggerre. Ugyanez a `PropertiesSidebar` többi collapsible-jénél is.
- [ ] 70. **Üres canvas onboarding hint**: új workflow létrehozás után üres dotted háttér — a user nem tudja, hol kezdjen. Javaslat: középre pozicionált fakó szöveg „Húzz ide egy állapotot a bal oldali palettáról" + nyíl ikon a palette irányába. Eltűnik az első node lehelyezésekor.
- [ ] 71. **Parancsok / Mozgatási jogosultság — explicit „+ Hozzáadás" gomb**: kinyitott üres szekcióban nincs látható akció. Javaslat: block-szintű `+ Parancs hozzáadása` / `+ Csoport hozzáadása` gomb a szekció tetején (a jelenlegi chip-grid mellett).
- [ ] 72. **Native `<select>` → design system Select**: TransitionPropertiesEditor „Irány" dropdown-ja natív `<select>`-et használ (rendszerfüggő megjelenés), miközben a többi multi-select chip-alapú. Javaslat: `CustomDropdown` (vagy azzal ekvivalens Dashboard komponens) a design system-ből.
- [ ] 73. **Oldalpanel collapse toggle**: 1600px-n a 160px palette + 280px sidebar = 440px elvész, a canvas csak ~1100px-t kap. Javaslat: mindkét panelre `<<` / `>>` collapse toggle (VS Code Activity Bar minta), a kiválasztott állapot `localStorage`-ba mentve.
- [ ] 74. **MiniMap interaktivitás jelzés**: a user nem tudja, hogy a minimap kattintható (ugrás + navigáció). Javaslat: `cursor: pointer` + halvány border hover-en.
- [ ] 75. **WorkflowPropertiesEditor — Contributor csoportok read-only jelzés**: a szerepnév + slug táblázat read-only, de nincs vizuális jelzés. Javaslat: szürke háttér + „(csak olvasható)" felirat a szekció fejlécben, VAGY teljesen elrejteni, ha nincs szerkeszthető tartalom.

**Minor (🟢) — polish:**

- [ ] 76. **Snapshot-usage banner tömörítés**: jelenleg 3 mondatos magyarázat vizuálisan domináns. Javaslat: 1 mondatos TL;DR + „Részletek" collapse link („Ezt a workflow-t 3 aktív publikáció használja. Részletek…").
- [ ] 77. **MiniMap node-szín színkódolás**: a minimap node-jai jelenleg egységes színűek; a state-színeket ingyen továbbadhatnánk. xyflow `MiniMap` `nodeColor` prop.
- [ ] 78. **Toolbar gombcsoport separator**: `+ Új workflow` közvetlenül az Export/Import mellett van, a user véletlenül kattinthatja az Import-ra (destructive-ish). Javaslat: vertikális separator a két gombcsoport között.
- [ ] 79. **Verzió chip (`v1`) láthatóság**: amíg nincs valódi workflow verziózás, a mindig `v1`-et mutató chip felesleges zaj. Javaslat: rejtsük el, VAGY alakítsuk információs tooltip-be (pl. „Verzió: v1 — jelenleg nincs verziózás").

### Manuális smoke test checklist

> Valós InDesign környezetben végigkattintani — a kód review nem helyettesíti.

- [ ] 18. **Happy path** — bejelentkezés → kiadvány kiválasztás → cikk felvétel → megnyitás → szerkesztés → mentés → állapotváltás → bezárás
- [ ] 19. **Sleep/wake recovery** — laptop fedél le → 2+ perc → fedél fel → UI konzisztens, Realtime él, adatok frissek
- [ ] 20. **Dual-proxy failover** — primary leállítás → fallback átkapcsolás → primary visszajön → automatikus visszakapcsolás
- [ ] 21. **Offline → online** — WiFi ki → offline overlay → WiFi be → recovery → nincs dupla fetch, nincs UI ugrás
- [ ] 22. **Jogosultsági edge case-ek** — vezető csoport bypass, scope váltás közben állapotváltás, workflow hot-reload UI frissülés

---

## Kész

### Harden — Teljes projekt átvizsgálás (modulonként)

> **Workflow minden pontnál:**
> 1. `/roast` elemzés az adott modulra (kockázatok, overengineering, edge case-ek)
> 2. Kérdések tisztázása
> 3. `/harden` futtatás
> 4. ✅ Kipipálás

- [x] 1. **core/config/** — appwriteConfig, realtimeClient, recoveryManager, maestroEvents
- [x] 2. **core/utils/ (infra)** — logger, errorUtils, pathUtils, promiseUtils, constants, messageConstants
- [x] 3. **core/utils/workflow/** — workflowEngine, workflowPermissions
- [x] 4. **core/utils/validators/** — ValidatorBase, összes validator, validationRunner
- [x] 5. **core/utils/indesign/** — ExtendScript generátorok, scriptHelpers, indesignUtils
- [x] 6. **core/contexts/** — DataContext, UserContext, ValidationContext, ConnectionContext, ScopeContext
- [x] 7. **data/hooks/** — useArticles, useOverlapValidation, useUnifiedValidation, useElementPermission, stb.
- [x] 8. **ui/features/** — articles, publications, workspace komponensek
- [x] 9. **ui/common/** — CollapsibleSection, ConfirmDialog, ValidatedTextField, Table, Toast
- [x] 10. **maestro-shared/** — workflowRuntime, constants, urgency, pageGapUtils, contributorHelpers

### Cross-module interakciók (a modul-harden UTÁN)

> A harden modul-határokon belül dolgozik — a kritikus bugok viszont a modulok *között* élnek.

- [x] 11. **Recovery lánc** — RecoveryManager → realtimeClient → DataContext.fetchData → ConnectionContext állapotátmenetek egységben
- [x] 12. **Optimistic update konzisztencia** — applyArticleUpdate ↔ Realtime handler ↔ $updatedAt elavulás-védelem ↔ fetchGenerationRef — az összes írási útvonal együtt
- [x] 13. **Auth + Scope lánc** — UserContext (login/session/groupSlugs) → ScopeContext (auto-pick/stale ID) → DataContext (scope-szűrt fetch) → Realtime scope szűrés
- [x] 14. **Workflow átmenet teljes útvonal** — UI gomb → workflowPermissions → workflowEngine.executeTransition → StateComplianceValidator → callUpdateArticleCF → Realtime visszacsatolás

### Race condition audit

> Async timing problémák célzott keresése — statikus review-val nehezen megfogható hibák.

- [x] 15. **Párhuzamos fetch + recovery** — fetchGenerationRef + isReconnecting guard + debounce végpont együttes viselkedése gyors egymás utáni triggerek esetén (sleep + focus + online egyszerre)
- [x] 16. **Realtime burst** — layoutChanged / publicationCoverageChanged debounce + articlesAdded event payload (React state batching megkerülés) — szimulált burst szcenáriók
- [x] 17. **Lock race** — optimistic SYSTEM lock → DB lockDocument → Realtime update → unlock registerTask — mi történik ha közben publication switch vagy recovery fut
