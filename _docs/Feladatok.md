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

- [x] 68. **StateNode szélesség magyar címkéknek**: 190px fix szélesség truncál hosszabb magyar állapotneveket („Tervellenőrzés kiadó által"). Javaslat: `min-width: 180px; max-width: 240px` + `word-break: break-word` a `.state-node__label`-re. [workflowDesigner.css](../packages/maestro-dashboard/src/features/workflowDesigner/workflowDesigner.css) `.state-node` + `.state-node__label`. ✅ `min-width: 180px; max-width: 240px` + `word-break: break-word; line-height: 1.25` — az ellipsis levéve, a hosszabb magyar állapotnevek tördelődnek.
- [x] 69. **Collapsible `aria-expanded` + `aria-controls`**: a Validációk / Parancsok / Mozgatási jogosultság trigger gombok csak vizuális chevron-t (▾/▸) mutatnak, screen reader nem tudja az állapotot. Javaslat: `aria-expanded={isOpen}` + `aria-controls={panelId}` minden triggerre. Ugyanez a `PropertiesSidebar` többi collapsible-jénél is. ✅ Mindhárom StatePropertiesEditor collapsible (`state-validations-{id}`, `state-commands-{id}`, `state-permissions-{id}`) megkapta `aria-expanded` + `aria-controls` + matching `id` a body-n.
- [x] 70. **Üres canvas onboarding hint**: új workflow létrehozás után üres dotted háttér — a user nem tudja, hol kezdjen. Javaslat: középre pozicionált fakó szöveg „Húzz ide egy állapotot a bal oldali palettáról" + nyíl ikon a palette irányába. Eltűnik az első node lehelyezésekor. ✅ `WorkflowCanvas` overlay div `nodes.length === 0`-ra. `pointer-events: none` hogy ne blokkolja a drop event-et.
- [x] 71. **Parancsok / Mozgatási jogosultság — explicit „+ Hozzáadás" gomb**: kinyitott üres szekcióban nincs látható akció. Javaslat: block-szintű `+ Parancs hozzáadása` / `+ Csoport hozzáadása` gomb a szekció tetején (a jelenlegi chip-grid mellett). ✅ Üres állapot hint paragrafus (left accent border) a `CommandListField` és `GroupMultiSelectField`-ben — tisztázza, hogy a chip-grid ill. a dropdown az akció-felület.
- [x] 72. **Native `<select>` → design system Select**: TransitionPropertiesEditor „Irány" dropdown-ja natív `<select>`-et használ (rendszerfüggő megjelenés), miközben a többi multi-select chip-alapú. Javaslat: `CustomDropdown` (vagy azzal ekvivalens Dashboard komponens) a design system-ből. ✅ A natív `<select>`-et `role="radiogroup"` chip-csoportra cseréltem (3 chip: Előre / Vissza / Reset), single-select szemantika `aria-checked`-del. Konzisztens a többi designer mezővel.
- [x] 73. **Oldalpanel collapse toggle**: 1600px-n a 160px palette + 280px sidebar = 440px elvész, a canvas csak ~1100px-t kap. Javaslat: mindkét panelre `<<` / `>>` collapse toggle (VS Code Activity Bar minta), a kiválasztott állapot `localStorage`-ba mentve. ✅ Mindkét panel összecsukható (palette + sidebar), localStorage-perzisztált. Összecsukva 28px széles csíkká válnak vertikális címkével + toggle gombbal. A bontott állapotban a sidebar jobb felső sarkában, a palette header-ben jelenik meg a `‹` / `›` toggle.
- [x] 74. **MiniMap interaktivitás jelzés**: a user nem tudja, hogy a minimap kattintható (ugrás + navigáció). Javaslat: `cursor: pointer` + halvány border hover-en. ✅ `cursor: pointer` + 1px-ről 2px-re erősödő accent border hover-en (CSS-ben).
- [x] 75. **WorkflowPropertiesEditor — Contributor csoportok read-only jelzés**: a szerepnév + slug táblázat read-only, de nincs vizuális jelzés. Javaslat: szürke háttér + „(csak olvasható)" felirat a szekció fejlécben, VAGY teljesen elrejteni, ha nincs szerkeszthető tartalom. ✅ Label mellé „csak olvasható" badge + szürke `helpText` magyarázat („A csoportokat a Szerkesztőség → Csoportok fülön kezelheted"). A chip-ek `--readonly` variánst kapnak (dashed border, default cursor, slug másodlagos szín). Üres állapot kezelve.

**Minor (🟢) — polish:**

- [x] 76. **Snapshot-usage banner tömörítés**: jelenleg 3 mondatos magyarázat vizuálisan domináns. Javaslat: 1 mondatos TL;DR + „Részletek" collapse link („Ezt a workflow-t 3 aktív publikáció használja. Részletek…"). ✅ Egy mondatos TL;DR + `<details>`/`<summary>` collapse a részletekkel. Padding/font-size csökkentve, a banner kompakt.
- [x] 77. **MiniMap node-szín színkódolás**: a minimap node-jai jelenleg egységes színűek; a state-színeket ingyen továbbadhatnánk. xyflow `MiniMap` `nodeColor` prop. ✅ Korábbi commit-ban megvolt: `WorkflowCanvas.jsx`-ben `miniMapNodeColor = (node) => node.data?.color || '#888'` + `<MiniMap nodeColor={...}>`. Ellenőrizve, működik.
- [x] 78. **Toolbar gombcsoport separator**: `+ Új workflow` közvetlenül az Export/Import mellett van, a user véletlenül kattinthatja az Import-ra (destructive-ish). Javaslat: vertikális separator a két gombcsoport között. ✅ Két `.workflow-designer-toolbar__separator` (1px × 18px halvány vertikális csík): „+ Új workflow" / Export•Import / Mentés között. Az „IO csoport" és a primary akció vizuálisan elkülönül.
- [x] 79. **Verzió chip (`v1`) láthatóság**: amíg nincs valódi workflow verziózás, a mindig `v1`-et mutató chip felesleges zaj. Javaslat: rejtsük el, VAGY alakítsuk információs tooltip-be (pl. „Verzió: v1 — jelenleg nincs verziózás"). ✅ A chip csak akkor renderel, ha `version > 1` (pl. konkurens mentés után), egyébként rejtett. A token továbbra is része a state-nek (optimistic concurrency), csak nem zajos a UI. A v2+ chip tooltip-tel magyarázza a szemantikát.

#### J. Workflow életciklus & scope refactor (2026-04-20)

> Forrás: felhasználói felvetés — a workflow-tervező és -kezelés szétválasztása. A workflow önálló életet él: a breadcrumb mellől egy chip nyitja meg a workflow-könyvtár modal-t (ComfyUI template-panel stílus), ugyanez a panel jelenik meg a kiadvány-hozzárendelésnél is. A Settings → Workflow tab megszűnik. Új `public` scope a publikus megosztáshoz.
>
> **Döntések (2026-04-20 egyeztetés):**
> 1. Scope szabadon mozgatható; szűkítésnél popup figyelmeztet (aktív publikációk snapshot-tal védve, másolatok megmaradnak, de a szűken kívüli szerkesztőségek új kiadványt már nem indíthatnak); tágításnál csak info-tooltip.
> 2. Publikálás joga egyelőre kizárólag a tulajdonosé (később részletes jogosultsági rendszer köti össze a user-kezeléssel).
> 3. Törlés = 7 napos soft-delete (archív), utána cron-hard-delete (referencia-ellenőrzéssel).
> 4. Idegen workflow-t **read-only**-ban nyit meg, hangsúlyos „Duplikál & Szerkeszt" CTA; ha a user mégis mentene, a dialog „Más néven mentés" flow-ra vált — új workflow `editorial_office` scope-on indul.
> 5. Breadcrumb chip + nagy modal (első iteráció); az UX finomhangolás később.
>
> **Adatmegőrzés nincs** — a dev-adatbázisban lévő workflow-k eldobhatók, a `bootstrap_organization` seeding újrahúzza a default-okat. Nincs backfill.
>
> **Sorrend**: 80–81 szerver-oldal (az új schema + CF nélkül a kliens nem indulhat), utána 82–87 kliens.

- [x] 80. **Adatmodell + ACL** (`workflows` collection): (2026-04-20)
    - `visibility` enum bővítés: `editorial_office` | `organization` | `public`.
    - Új mezők: `description` (string), `archivedAt` (datetime, nullable). `updatedAt` Appwrite-managed, „Utoljára mentve" kijelzésre.
    - Fulltext index: `name` + `description` (szabadszavas kereső a library-ban).
    - Doc-szintű ACL: tulajdonos `user:${createdBy}` write + scope-szerinti read (`team:office_${officeId}` / `team:org_${orgId}` / `any authenticated` publikus esetén). `rowSecurity: true` — Fázis 2 minta (60. pont), cross-tenant Realtime leak ellen.
    - Nincs migráció: a dev-adatbázis workflow-dok eldobhatók, a `bootstrap_organization` újraseedeli a default-okat szerkesztőségenként.
    - **Szerver-oldali kész (2026-04-20)**:
        - `teamHelpers.js` `buildWorkflowAclPerms(visibility, orgId, officeId)` helper — `public` → `read("users")`, `organization` → `read("team:org_${orgId}")`, `editorial_office` → `read("team:office_${officeId}")`.
        - `WORKFLOW_VISIBILITY_VALUES = ['organization', 'editorial_office', 'public']` (`main.js`).
        - `bootstrap_workflow_schema` CF action bővítés: `visibility` enum 3 értékkel (createEnumAttribute → 409 fallback `updateEnumAttribute`-ra `public` bővítéssel), `description` (string 500), `archivedAt` (datetime nullable), fulltext indexek `name_fulltext` + `description_fulltext`. Válasz: `{ created, updated, skipped, indexesPending }`.
        - `createWorkflowDoc` helper + 4 hívó (`bootstrap_organization`, `create_workflow`, `create_editorial_office`, `duplicate_workflow`) — mostantól dokumentum-szintű read ACL-lel írnak.
        - `update_workflow_metadata` action átalakítva: `visibility_downgrade_blocked` (#30 hard block) → `visibility_shrinkage_warning` (soft warning + `force: true` override). Scope-váltáskor újraszámolt ACL-lel `databases.updateDocument(...)`.
    - **Deploy checklist** (manuális lépések éles futás előtt — NEM robotizálható, mert az Appwrite Console collection-beállítás):
        1. `invite-to-organization` CF újradeploy a frissített `teamHelpers.js` + `main.js` tartalommal (`--code functions/invite-to-organization`).
        2. `bootstrap_workflow_schema` CF action futtatása owner-rel (payload: `{ action: 'bootstrap_workflow_schema' }`) → az enum / string / datetime mezők létrejönnek. Az Appwrite az attribútumokat aszinkron feldolgozza → ha a válasz `indexesPending`-et jelez, **10 másodperc múlva újra futtatni** ugyanazt az action-t, hogy a fulltext indexek is felépüljenek (már létező attribútumon).
        3. Appwrite Console → `workflows` collection:
            - **`rowSecurity` flag → `true`** (különben a collection-szintű `read("users")` ACL felülírja a doc-szintű permit-eket, és minden user látna minden workflow-t Realtime-on).
            - **Globális `read("users")` ACL eltávolítása** a collection Permissions-ből (a doc-szintű read-et `buildWorkflowAclPerms` állítja be).
            - A collection Permissions `Update`/`Delete` role-okat üresen hagyni — minden mutation a CF API key-n keresztül fut, a user direkt write-ra ne is kapjon jogot.
        4. Dev-adatbázis workflow-dokumentumok eldobhatók (adatmegőrzés nincs, ld. J. szekció). Opcionális: a meglévő doc-ok törlése + `bootstrap_organization` újrafuttatása (vagy új office létrehozása) a helyes ACL-lel seed-el.
        5. Smoke: két külön org tagja külön böngészőben — a `workflows` Realtime subscribe-ra A org workflow módosítása NE küldjön WS payload-ot B org kliensének. (Részletes adversarial teszt: 87. pont.)

- [x] 81. **CF action-ök** (`invite-to-organization/src/main.js` + új scheduled CF): (2026-04-20)
    - `archive_workflow` + `restore_workflow` — soft-delete / undo. Egy közös handler kezeli mindkét action-t (`isArchive` flag), `archivedAt = now()` / `null`. Auth: `createdBy === callerId` VAGY org owner/admin fallback (kilépett tag workflow-jának takarítására). Idempotens: már archivált → `already_archived`, már aktív → `already_active`. Read ACL marad (a futó publikáció UI-ja ne vesszen el); a collection-szintű write a CF API key-jé, tehát a user a kliens SDK-ból direkten nem módosíthatja.
    - `update_workflow_metadata` owner-guard (#81 szigorítás): a **visibility** váltás kizárólag a `createdBy === callerId` tulajdonosnak engedett (ha a caller csak org admin/owner, 403 `not_workflow_owner { field: 'visibility' }`). A név és description továbbra is org owner/admin joggal szerkeszthető. Új `description` field-támogatás (string 500, trim→null→szándékos törlés, `undefined` = no-op). A szűkítés-warning (`visibility_shrinkage_warning` + `force: true`) és az ACL-újraírás (`buildWorkflowAclPerms` 5. paraméter) a #80-as iterációban beépült.
    - `duplicate_workflow` cross-tenant bővítés: az `editorialOfficeId` payload mező mostantól a **TARGET** office (a caller aktív office-a), nem a source-é. A forrás bárhol lehet (saját, org, public) — a CF scope alapján validálja a read-access-t (`editorial_office` → same-office tagság, `organization` → same-org tagság, `public` → mindenki). A duplikátum MINDIG `visibility = editorial_office` scope-on indul (a user később tágíthatja `update_workflow_metadata`-val), `createdBy = caller`. Név-ütközés esetén az `explicitName` hiánya mellett auto-suffix (`(másolat)`, `(másolat 2)`, …, cap 20). Archivált forrás: 400 `source_archived`.
    - `cleanup-archived-workflows` új scheduled CF (`packages/maestro-server/functions/cleanup-archived-workflows/`): napi 5:00 UTC (`0 5 * * *`), `databases.read + databases.write` scope. Az `archivedAt < now() - 7d` workflow-kra per-workflow blocking scan: ha **legalább egy snapshot-nélküli publikáció** hivatkozik rájuk, skip (a nem-aktivált publikáció a live doc-ra támaszkodik; a snapshot-tal védett aktív pub-ok NEM blokkolnak). Retention konfigurálható `ARCHIVED_RETENTION_DAYS` env var-ral (default 7). Stats response: `{ eligibleCount, deletedCount, skippedCount, skippedDetails }`.
    - **Env var-ok** (`cleanup-archived-workflows`): `DATABASE_ID`, `WORKFLOWS_COLLECTION_ID`, `PUBLICATIONS_COLLECTION_ID`, opcionálisan `ARCHIVED_RETENTION_DAYS`.
    - **Deploy lépések**: (1) `invite-to-organization` CF újradeploy (új action-ök), (2) `cleanup-archived-workflows` első deploy a `maestro-server/appwrite.json`-ból (`appwrite functions create-deployment`). A scheduled CF a regisztráció után automatikusan fut a beállított cron szerint; első futtatás manuálisan is triggerelhető (Appwrite Console → Execute).

- [x] 82. **`WorkflowLibraryPanel` közös komponens** (modal): (2026-04-20)
    - Props: `context: 'breadcrumb' | 'publication-assignment'`, `onSelect(workflowId)`, `onClose`.
    - Szűrők: scope chip-ek (office/org/public multi-select), `updatedAt` date range, szabadszavas kereső (`name` + `description`), rendezés (név / dátum).
    - Card: név, leírás, „Utoljára mentve" timestamp, szerző, scope-chip, „Saját" / „Idegen" jelölés.
    - Akciók card-on: „Megnyit" (saját → edit route; idegen → read-only preview); „Duplikál" (mindenkinek elérhető); „Archivál" (csak saját); „Új workflow" gomb a panel fejlécében.
    - Realtime: `subscribeRealtime` a `workflows` collection-re a `realtimeBus.js`-en keresztül (kötelező pattern).
    - **Implementálva**: `src/components/workflows/WorkflowLibraryPanel.jsx` (676 sor) + `CreateWorkflowModal.jsx` + `css/features/workflow-library.css` (381 sor). A BreadcrumbHeader chip-je + a GeneralTab workflow-picker gombja egyaránt ezt a modal-t nyitja.

- [x] 83. **Route refaktor + breadcrumb chip**: (2026-04-20)
    - Új: `/workflows/:id` (edit), `/workflows/new` (üres designer). `DataProvider` wrapping marad.
    - Legacy `/admin/office/:officeId/workflow/:workflowId` → redirect `/workflows/:id`-re (a `WorkflowDesignerRedirect` komponens bővítése).
    - `BreadcrumbHeader.jsx`: új „Workflows" chip a breadcrumb után — **vizuálisan szeparált**, nem része a tenant-láncnak. Kattintás → `WorkflowLibraryPanel` (context='breadcrumb'), kiválasztás → `navigate('/workflows/:id')`.
    - **Implementálva**: `App.jsx` 4 új route — `/workflows/:workflowId` (designer), `/workflows/new` (új workflow belépési pont), plusz 2 legacy redirect (`/admin/office/:officeId/workflow` → `WorkflowDesignerRedirect`, `/admin/office/:officeId/workflow/:workflowId` → inline `LegacyWorkflowRedirect` komponens, param preservál). Új fájl: `features/workflowDesigner/WorkflowNewRoute.jsx` — modal-alapú belépési pont `modalCount` figyeléssel (mégse → `/`-ra, siker → `/workflows/:id`-re a modal-on belül). `WorkflowDesignerPage.jsx` `useParams()`-ból csak `workflowId`-t vesz, az office ID a betöltött doc-ból (`workflowOwnerOfficeId`) származik — így idegen office-beli workflow olvasása is működik. `WorkflowDesignerRedirect` target-je `/workflows/:id`-re állítva. Minden `navigate()` hívó (`WorkflowLibraryPanel`, `CreateWorkflowModal`, `WorkflowDesignerPage.handleDuplicate/handleSwitchWorkflow`) az új URL-re mutat. `organization/GeneralTab.jsx` „Workflow tervező →" gombja helyett scope-váltás + dashboard nyitás („Megnyitás →"), a workflow böngészőt a breadcrumb chip nyitja.
    - **Harden pass (5 iteráció, 2026-04-20)**: `WorkflowNewRoute` `canCreateWorkflow` role-gate (csak owner/admin az aktív office org-jában kapja meg a modal-t; member user explicit toast + `navigate('/', { replace: true })`). `WorkflowDesignerRedirect` magyar `localeCompare('hu')` kliens-oldali sort visszaállítva (query-szinten nincs collation). Scope-init deep-link race: fresh session + direkt URL `/workflows/new`-re nem redirect-el, amíg a ScopeProvider memberships-alapú auto-pick lefut (loading spinner render). StrictMode double-mount guardok (`hasOpenedRef`, `hasNotifiedRef`). Visszatartva (Iter 5 adversarial push-back): cross-office admin auto-scope-switch + `/workflows/new` explicit office-picker — feature-add, nem hardening.

- [x] 84. **Designer oldal átalakítás** (`WorkflowDesignerPage.jsx`): (2026-04-20)
    - Title bar: név inline-edit, description textarea, `visibility` toggle (ownership guard — csak tulajdonos módosíthatja), „Utoljára mentve" timestamp.
    - **Read-only mód** idegen workflow-n: canvas view-only, toolbar disabled, hangsúlyos „Duplikál & Szerkeszt" CTA (új példányt nyit a szerkesztőben).
    - **Save As flow**: ha read-only view-ban mentést kísérel (Ctrl+S / mentés gomb), dialog: „Ez a workflow nem a tiéd. Más néven mented?" → új workflow `editorial_office` scope-pal, tulajdonos = caller.
    - Scope-szűkítés popup copy: „A már futó publikációk továbbra is használhatják (snapshot védi őket), a korábbi másolatok megmaradnak, de a szűkített scope-on kívüli szerkesztőségek már nem indíthatnak új kiadványt ezzel a workflow-val. Biztos szűkíted?"
    - Scope-tágítás info-tooltip (nem-blokkoló): „Mostantól szélesebb kör is látja és használhatja ezt a workflow-t."
    - **Implementálva**: `WorkflowDesignerPage.jsx` `isReadOnly` state, canvas `readOnly` prop, a toolbar mentés gomb helyén „Duplikál & szerkeszt" CTA (2 helyen: toolbar + üres-state). `duplicateWorkflow` CF hívás → navigálás az új doc-ra.
    - **Harden pass (2026-04-20)**: `isReadOnly` kettős feltétel — `isForeignOffice || isInsufficientRole` (office-boundary + role-gate). Foreign-office esetén org admin is read-only módba esik (szándékolt: a termék duplicate-to-edit UX-et tart fenn cross-office accidental edit ellen). Toolbar akciók (`+ Új workflow`, `Duplikál & szerkeszt`, workflow-switcher) `canCreateInActiveOrg`-gated — member-user-nek elrejtve a halál-végű CTA-k (`create_workflow` / `duplicate_workflow` CF owner/admin-only). Read-only label tooltip conditional (`isForeignOffice` vs insufficient role — pontos üzenet). `snapshotUsageCount` memo scope-gated: csak akkor számol, ha `workflowOwnerOfficeId === activeEditorialOfficeId` (idegen office `publications`-éből derivált banner félrevezető lenne). Workflow switcher dropdown scope-gated: nem jelenik meg idegen workflow nézetben (a lista az aktív scope-ra szűrt).

- [x] 85. **Publikáció integráció** (`GeneralTab.jsx`): (2026-04-20)
    - A jelenlegi workflow `<select>` dropdown cseréje: „Workflow kiválasztása" gomb + jelenleg aktív workflow-chip (név + scope jelzés).
    - Gomb → ugyanaz a `WorkflowLibraryPanel` (context='publication-assignment'). `onSelect` patcheli a `publications.workflowId`-t (meglévő CF flow változatlan).
    - Aktivált publikációnál letiltva (jelenlegi logika marad), a chip read-only látszik.
    - **Implementálva**: `GeneralTab.jsx` `handleOpenWorkflowLibrary` + `handleWorkflowSelect`. Archivált workflow-fallback `getDocument()`-tel (a GeneralTab nem törik, ha a publikáció archivált workflow-ra mutat). `publication-workflow-picker__chip is-${visibility}` scope-chip. Új CSS: `css/features/publication-settings.css` (69 sor kiegészítés).

- [x] 86. **Settings cleanup**: (2026-04-20)
    - `EditorialOfficeWorkflowTab.jsx` + kapcsolódó selector kód törlés. Az `EditorialOfficeSettingsModal` tab-listája rövidül (Általános + Csoportok marad).
    - `bootstrap_organization` CF default workflow seeding megmarad (office-enként egy default).
    - Minden belső navigáció, ami korábban Settings → Workflow tabra mutatott (pl. empty state linkek, reference dokok), átállítva a breadcrumb chip-re.
    - **Implementálva**: `EditorialOfficeWorkflowTab.jsx` törölve (−522 sor), a modal most csak `EditorialOfficeGeneralTab` + `EditorialOfficeGroupsTab` tab-okat tart. A `bootstrap_organization` seeding változatlan.

- [ ] 87. **Smoke test + adversarial**:
    - 2-tab Realtime: scope-váltás egyik user-nél → a másik library panel-jében azonnal látszik/eltűnik (a `rowSecurity: true` + doc-ACL pattern miatt csak a jogosult kliensek kapják meg a WS payload-ot).
    - Cross-tenant teszt: B szervezet user nem látja A szervezet `editorial_office` vagy `organization` scope-ú workflow-ját; publikus látszik mindenkinek.
    - Adversarial: idegen user direktben hívja a CF-eket (`updateWorkflow`, `archiveWorkflow`, `deleteWorkflow`) → szerver 403. Read-only designer UI megkerülhető-e a browser dev-tools-ból (pl. state patch)? → a CF guard a szerveroldalon véd.
    - Soft-delete → 7 nap után cron hard-delete élesben nem tesztelhető; helyette manuális trigger (ideiglenes mock-date vagy admin-only CF action).

- [ ] 88. **Design question — duplicate_workflow member access** (harden #J utóirat, 2026-04-20):
    - A `duplicate_workflow` CF (`invite-to-organization/src/main.js:3965-3967`) jelenleg org `owner`/`admin` szerepkörhöz köti a duplikálást (`insufficient_role` 403 `member`-eknek). A UI (WorkflowLibraryPanel) a phase 4 harden gate után szintén csak owner/admin-nak mutatja a „Duplikál & szerkeszt" + kebab „Duplikálás" akciókat.
    - A 80–84. feladat design intent-je szerint a `public`/`organization` scope-ú workflow-kat read-only módban minden tag megnyithatja, és a `Duplikál & Szerkeszt` CTA az egyetlen útja annak, hogy egy non-admin szerkesztő saját scope-ba forkolja a workflow-t. A jelenlegi CF-gate ezt non-admin-nak eljárásilag blokkolja.
    - **Eldöntendő**: (a) a CF policy lazítása — tetszőleges org member duplikálhat a saját active office-ába (UI gate visszavonásával); VAGY (b) a CTA owner/admin-only jelöléssel kiegészítve, non-admin-nak explicit „kérd owner-től" üzenet. Az (a) konzisztens a read-only UX intent-jével, a (b) szigorúbb kontrollt tart.

#### K. Harden follow-upok (2026-04-21)

> Forrás: Dashboard harden pass a `DataContext.jsx` / `WorkflowLibraryPanel.jsx` / `BreadcrumbHeader.jsx` hármason (2026-04-21). A scope-on kívülre eső, de a review során azonosított refaktor-lehetőségek.

- [x] 89. **`window.prompt` → Modal migráció** (dashboard polish): (2026-04-21)
    - Több helyen natív `window.prompt()` dialógus fut (pl. workflow átnevezés, description edit). Ezek blokkoló, stílusozhatatlan, screen reader-re nem optimalizált és mobile-on rossz UX-et adnak.
    - Javasolt: a meglévő `Modal` + `ConfirmDialog` mintára egy `openPrompt(title, initialValue, { validate, placeholder, maxLength })` Promise-alapú util a `ModalContext`-ben, és az összes `window.prompt` hívó lecserélése.
    - **Implementálva**: új `components/PromptDialog.jsx` — Promise-alapú `usePrompt()` hook a `ConfirmDialog` mintájára (auto-focus + select, Enter=submit single-line módban, textarea multiline módban, validate-on-blur, `.confirm-dialog-*` CSS újrahasznosítva). `WorkflowLibraryPanel.handleRename` (maxLength 128) és `handleEditDescription` (multiline, maxLength 500, üres → null) átírva. A `CreateWorkflowModal.jsx` docstring a migráció kontextusát hivatkozza. `UsersTab.jsx:131` (copy-link dialog) szándékosan nem változott — nem input, clipboard fallback read-only szövegmezővel, külön UX. Potenciális follow-up: `openCopyDialog` util (→ #94).

- [x] 90. **`useOrgRole(orgId)` hook kiemelés** (redundancia takarítás): (2026-04-21)
    - A dashboard legalább 9 komponensben ismétli ugyanazt a callerOrgRole pattern-t:
      ```js
      const callerOrgRole = useMemo(() => {
          const membership = (orgMemberships || []).find(
              (m) => m.organizationId === activeOrganizationId && m.userId === user.$id
          );
          return membership?.role || null;
      }, [orgMemberships, user?.$id, activeOrganizationId]);
      const isOrgAdmin = callerOrgRole === 'owner' || callerOrgRole === 'admin';
      ```
    - Érintett fájlok (harden review): `WorkflowLibraryPanel.jsx`, `CreateWorkflowModal.jsx`, `WorkflowDesignerPage.jsx`, `WorkflowNewRoute.jsx`, `organization/UsersTab.jsx`, `organization/GeneralTab.jsx`, `publications/GeneralTab.jsx`, `EditorialOfficeGroupsTab.jsx`, `EditorialOfficeGeneralTab.jsx` (teljes sweep a `findOrgMembership` mintáért).
    - Javasolt API: `src/hooks/useOrgRole.js` → `{ role, isOwner, isAdmin, isOrgAdmin, isMember }` scope-szűrt, `activeOrganizationId` default-ra bontva.
    - **Implementálva**: új `hooks/useOrgRole.js` — explicit `organizationId` paraméter (nincs implicit `activeOrganizationId` default, mert 3 szemantikai variánst kellett fenntartani: active-org / workflow-owner-org / publication-org). `EMPTY_ROLE` frozen-objektum fallback (null/null org-ra), visszatér `{ role, isOwner, isAdmin, isOrgAdmin, isMember }`. Migrálva: `DashboardLayout.jsx` (activeOrg), `WorkflowLibraryPanel.jsx` (activeOrg), `WorkflowDesignerPage.jsx` (2 hívás: owner-org + active-office-org), `WorkflowNewRoute.jsx` (active-office-org), `EditorialOfficeSettingsModal.jsx` (office-org), `publications/GeneralTab.jsx` (publication-org). Scope-on kívül maradt: `OrganizationSettingsModal` (közvetlen collection fetch, nem `orgMemberships` snapshot) és `MaestroSettingsModal` (multi-org aggregáció) — eltérő szemantika, hook nem illik.

- [x] 91. **`databases` context-use migration** (DataContext singleton, 1. ütem): (2026-04-21)
    - A `DataContext` már exportálja a `databases` / `storage` példányt a context value-ban (harden pass #82 fallout). A korábbi 4+ komponens még saját `new Databases(getClient())` példányt képez.
    - Érintett: sweep `grep -rn "new Databases(getClient" packages/maestro-dashboard/src` — várható call-site-ok: `WorkflowDesignerPage.jsx`, `features/workflowDesigner/api.js`, `organization/*Tab.jsx`, egyéb helyek.
    - Javasolt: minden call-site váltson `const { databases } = useData()`-ra (provider-on belül), a `features/workflowDesigner/api.js` típusú modulok kapjanak `databases` paramétert.
    - **Implementálva (1. ütem — `new Databases(getClient())` minta)**: `hooks/useContributorGroups.js` (databasesRef → `useData()`), `components/organization/CreateEditorialOfficeModal.jsx` (useMemo → `useData()`), `components/publications/GeneralTab.jsx` (archivált workflow fallback → `useData()`). Szándékosan nem érintett: `features/workflowDesigner/WorkflowDesignerRedirect.jsx:39` — a komponens **DataProvider-en kívül mount-ol** (az `App.jsx` legacy redirect route-jai nem bugyolálják `DataProvider`-be, mert csak egy `navigate()` háttérfetch-et csinál, nem hoz létre full designer állapotot). Külön task (#92) tárgyalja a második ütemet (`new Databases(client)` variáns sweepje) és a WorkflowDesignerRedirect szigetelését.
    - **Előny**: egyetlen Appwrite Databases instance per DataProvider — lépéseltartalékos konfiguráció-váltásnál (pl. endpoint rotáció) kiszámíthatóbb, és a teszteléshez mock-olható.

#### L. Harden follow-upok — 2. ütem (2026-04-21)

> Forrás: a K. szekció (#89–#91) implementáció közben feltárt tangenciális findingok. Mindegyik self-contained task, a K-tól függetlenül ütemezhető.

- [x] 92. **`new Databases(client)` sweep (második ütem)**: (2026-04-21)
    - A #91 eredeti grep (`new Databases(getClient`) kihagyta azokat a call-site-okat, ahol a komponens előbb `getClient()`-ből kikéri a `client`-et, majd `new Databases(client)` konstruál (ugyanaz a probléma, más írásmód).
    - **Provider-scope definíció** (App.jsx alapján): csak a `/` (DashboardLayoutWithProviders) és `/workflows/*` (WorkflowDesignerWithProviders) route-fák vannak DataProvider-en belül. A `/settings/*` és `/onboarding` AuthSplitLayout alatt renderel, DataProvider nélkül. A modal-ok aszerint „benne" vagy „kívül", hogy a megnyitó komponens melyik fán él.
    - Feltárt call-site-ok (2026-04-21 utáni újravizsgálat):
      - `routes/settings/GroupsRoute.jsx:37` — **DataProvider-en kívül** (AuthSplitLayout → `/settings/groups`), saját client-singleton kell.
      - `components/organization/OrganizationSettingsModal.jsx:71` — **DataProvider-en belül**: kizárólag `DashboardLayout.jsx:170` és `BreadcrumbHeader.jsx:151`-ből nyílik, mindkettő DashboardLayoutWithProviders alatt él. Cserélhető `useData().databases`-re.
      - `components/organization/EditorialOfficeSettingsModal.jsx:68` — **DataProvider-en belül** (a Harden pass simplify lépésében már megcsinálta).
      - `components/organization/CreateEditorialOfficeModal.jsx:86` — **DataProvider-en belül** (#91 már megcsinálta): parent `OrganizationSettingsModal` a DashboardLayout alatt él.
      - `features/workflowDesigner/WorkflowDesignerPage.jsx:219, 558` — DataProvider-en belül, cserélhető `useData().databases`-re.
      - `contexts/AuthContext.jsx:58` — modul-szintű singleton (provider előtt fut) — szándékos, NEM módosítandó.
      - `features/workflowDesigner/WorkflowDesignerRedirect.jsx:39` (getClient-változat) — DataProvider-en kívül (legacy URL redirect, App.jsx megjegyzi).
    - **Implementálva**: `WorkflowDesignerPage.jsx` 2 helyen (betöltési useEffect + törölt state-k cikk-ellenőrzés) `useData().databases`-re cserélve; a nem használt `Databases` + `getClient` importok eltávolítva. `OrganizationSettingsModal.jsx` `useData().databases`-re cserélve, `useMemo`/`getClient`/`Databases` importok eltávolítva.
    - Szándékosan NEM érintett: `GroupsRoute.jsx` + `WorkflowDesignerRedirect.jsx` + `AuthContext.jsx` modul-singleton — eltérő lifecycle (DataProvider-en kívül / modul-szint).

- [x] 93. **`WorkflowDesignerRedirect` stale-client vizsgálat**: (2026-04-21)
    - A komponens `App.jsx`-ben **DataProvider-en kívül** van routelve (a `_docs`-ban jelzett „legacy URL redirectek" kategória). Saját `new Databases(getClient())` példányt képez a `features/workflowDesigner/WorkflowDesignerRedirect.jsx:39`-ben.
    - Kérdés: a dual-proxy endpoint rotáció (`EndpointManager` fallback → primary visszakapcsolás) során a `getClient()` által visszaadott client friss-e minden hívásnál, vagy lehet stale `client` a `Databases` példányban? A plugin oldalon az `EndpointManager` cserél — a dashboard oldalán (custom domain) ez nem releváns, de érdemes explicit dokumentálni.
    - **Implementálva** (b) opcióval: kibővített JSDoc-komment a `WorkflowDesignerRedirect.jsx` fájl tetején, amely explicit rögzíti — (1) a komponens DataProvider-en KÍVÜL fut, (2) a dashboard oldalán nincs endpoint-rotáció (`EndpointManager` csak a Plugin dual-proxy-hoz létezik), (3) a `getClient()` modul-szintű AuthContext singleton-t ad, amely a Vite env endpoint-ra áll be a bootstrap-nél és onnan nem változik. Az izoláció biztonságos, nincs stale-client kockázat.
    - Az (a)/(c) alternatívák (áthelyezés DataProvider alá / közös `useAppwriteClient()` hook) mérlegeltük: az (a) overkill lenne (olcsó redirect-hez full DataProvider mount-ot indítana), a (c) külön task (#98) a `GroupsRoute` + `WorkflowDesignerRedirect` kettőshöz.

- [x] 94. **`UsersTab.jsx:131` copy-link dialog → `useCopyDialog` util**: (2026-04-21)
    - A `window.prompt('Másold ki a meghívó linket:', link)` hívás azonos UX-problémákkal küzd (blokkoló, stílusozhatatlan, screen reader), de **nem input** — read-only clipboard fallback egy szerkeszthető szövegmezőben.
    - **Implementálva**: új `components/CopyDialog.jsx` — Promise nélküli `useCopyDialog()` hook a `ConfirmDialog` / `PromptDialog` mintájára (auto-focus + select a `readOnly` input mezőn, „Másolás" gomb újraprobálja a clipboard API-t + siker-toast, manuális Ctrl+C fallback a read-only mezőben). `UsersTab.jsx:handleCopyLink` catch ága `window.prompt` helyett `copyDialog({ title, value, description })` hívást tesz. A `CopyDialog` a meglévő `.confirm-dialog-*` CSS class-okat újrahasznosítja.
    - **Előny**: konzisztens modal-alapú UI a #89 migrációval; mobile-on is használható; screen reader-friendly.

- [x] 95. **`DataContext.jsx:605` value object memoization**: (2026-04-21)
    - A `DataContext` provider `value` objektuma (`<DataContext.Provider value={{ … }}>`) nem `useMemo`-ba volt csomagolva. Minden re-render új objektumot adott, ami a context-consumer-eket ok nélkül triggerelhette. Harden pass #82-#91 közben 2+ új mező került be (`databases`, `storage`), ami a csak ezeket olvasó komponenseknél (pl. `useContributorGroups`, `CreateEditorialOfficeModal`) felesleges re-render-t okozhatott.
    - **Implementálva**: `useMemo(() => ({ …all fields… }), [deps])` a `DataContext.jsx` provider body végén. Deps-listában minden state (publications, articles, layouts, deadlines, validations, workflow, workflows, activePublicationId, isLoading), singleton (databases, storage) és useCallback (fetch/write-through API-k) kifejezetten listázva. A `workflow` maga is `useMemo` eredménye → stabil identitás a workflows/activePublicationId/publications változásáig.
    - **Utólag**: a javasolt provider-szétbontás (data vs. helpers) elhalasztva — a deps-lista ~25 elemes, de most a re-render-ek közül nagyrészt „semmi-változott" típus, tehát a memo költsége elenyésző (shallow refEqual). A szétbontás akkor indokolt, ha a re-render profiling szerint hot-path.

- [x] 96. **`CreateEditorialOfficeModal` workflows prefetch → DataContext** (2026-04-21, (a) opció):
    - A modal a szerkesztőség létrehozáskor megkérdezi az org-szintű workflow-kat (klónozható kiindulópontként). Ez egy önálló `listDocuments` hívás volt, a `useData().workflows` pedig scope-szűrt (az aktív office `editorial_office` + `organization` + `public`) → multi-office admin esetén UX-regressziót okozna, ha a modal csak a cache-re támaszkodna (cross-office `editorial_office` scope-ú workflow-k elvesznének).
    - **Implementálva (a) opcióval**: `DataContext.fetchAllOrgWorkflows(orgId)` új opt-in helper — egyetlen, nem-cache-elt lekérdezés a szervezet ÖSSZES workflow-jára (minden office, minden visibility). Az Appwrite rowSecurity szűri arra, amire a callernek joga van. NEM állít state-et, NEM iratkozik fel Realtime-ra, így a komplexitás az opciónál említett „duplikált Realtime-szinkronizáláshoz" képest nulla. A `CreateEditorialOfficeModal` a helyi `databases.listDocuments` helyett ezt a helpert hívja; az importok (`Databases`, `Query`, `DATABASE_ID`, `COLLECTIONS`) eltávolítva.
    - **Előny**: (1) org-szintű workflow lekérés egy helyen az `organizations`/`workflows` collection-höz tartozó privát, egyszeri flow-khoz; (2) a modal kódja ~25 sorral rövidebb, a try/catch + error-log a helper-ben van; (3) ha a jövőben egy másik org-szintű komponens is a teljes listát kéri (pl. Workflow Library „összes szervezet" nézet), már van közös API.

- [x] 101. **`GroupsRoute` render-beli új `Databases` / `Functions` példányok** (2026-04-21):
    - A `routes/settings/GroupsRoute.jsx:37-38` a render body-ban képzett új Appwrite instance-okat (`new Databases(client)` + `new Functions(client)`) minden render-ciklusban. A `client` maga stabil singleton volt, de a wrapper példányok új objektumok voltak minden render-nél.
    - **Implementálva #102-vel együtt**: a wrapper példányokat a GroupsRoute `getDatabases()` + `getFunctions()` (új AuthContext modul-exportok) váltja le. Az import + `const databases = getDatabases(); const functions = getFunctions();` modul-szintre került (a komponensen KÍVÜL), így a wrapperek valóban singleton-ok, minden render ugyanazt az instance-t használja. A feleslegessé vált `getClient` + `Databases` + `Functions` importok eltávolítva.

- [x] 102. **Közös `getDatabases()` / `getFunctions()` Appwrite szolgáltatás singleton** (2026-04-21):
    - A #92 (2. ütem) és #93 (WorkflowDesignerRedirect) után két call-site maradt, amely DataProvider-en KÍVÜL kezeli az Appwrite Databases példányt: `GroupsRoute.jsx` (settings route) és `WorkflowDesignerRedirect.jsx` (legacy URL redirect). Mindkettő a modul-szintű `getClient()` singleton-t használta + saját `Databases` példány.
    - **Implementálva**: az `AuthContext.jsx`-ben már létező modul-szintű `databases` + `functions` singletonokhoz (korábban csak belső használatra) új public export-ok (`getDatabases()`, `getFunctions()`), a meglévő `getClient()` + `getAccount()` mintájára.
    - **Miért függvény, nem hook**: a hívóknak nem kell React-context, a singleton-ok a bootstrap-nél jönnek létre és onnan nem változnak (nincs endpoint-rotáció a Dashboardon). A függvény forma a komponens-fa tetszőleges pontjáról használható, render-on-kívüli és modul-szintű kontextusból is (ld. `GroupsRoute` modul-szintű `const databases = getDatabases()`).
    - **Fogyasztók (migráció kész)**: `GroupsRoute.jsx` (#101), `WorkflowDesignerRedirect.jsx` (#93 követő).
    - **Szándékosan NEM érintett**: `DataProvider.servicesRef` — a Provider saját lifecycle-je a scope-reset miatt megmarad. Funkcionálisan ekvivalens (mindkettő ugyanarra a modul-szintű `client`-re épül), csak a Provider izoláció marad egyértelmű. `AuthContext.jsx` modul-szintű `const databases/functions` — szándékos, a public export ezekre mutat.

- [ ] 103. **`fetchWorkflow` scope-race guard szimmetria** (2026-04-21, #98 follow-up):
    - A `DataContext.fetchArchivedWorkflows` a #98 harden során kapott `isScopeStale()` closure-guardot + `archivedFetchGenRef` gen-countert (A→B→A race védelem). A `fetchWorkflow` ugyanakkor még mindig „first-fetch wins" jellegű: rapid scope-váltásnál (A → B) az A response, ha késik, felülírhatja B `workflows` state-jét.
    - **Kockázat (pre-existing)**: kis valószínűségű (dupla-fetch védelem + request-in-flight kooperál), de elvi szintjén a #98-cal szimmetrikus bug maradt meg az aktív workflows listán.
    - **Javasolt fix**: ugyanaz a minta mint a #98-nál — zárjuk be a `fetchWorkflow` belsejében az `activeEditorialOfficeIdRef.current` + `activeOrganizationIdRef.current` pillanatot closure-ba, + opcionális `fetchWorkflowGenRef`-ot, és post-await `isStale()` check `setWorkflows`/`seedWorkflowVersions` hívás előtt.
    - **Mikor indokolt**: ha race-problémát figyelünk meg (stale workflows list marad egy scope-váltás után), vagy ha az aktív lista is kap hasonló Realtime dual-list felelősséget (pl. visibility-szűrés dinamikus változása).

- [ ] 104. **`Archivált` tab content loading state** (2026-04-21, #98 follow-up, minor UX):
    - A #98 megoldás eagerly fetcheli az archivált workflow-kat scope-váltáskor. Fetch közben az `archivedWorkflows` üres tömb, tehát a Panel tab-content a `Nincs archivált workflow.` empty state-et mutatja a `Betöltés…` helyett (amit a korábbi lazy fetch mutatott).
    - **Impact**: csak az első scope-váltásnál + lassú hálózatnál látszik, <1 másodperc tipikusan. A tab-címke szám (fő feladat) korrektül megjelenik.
    - **Javasolt fix**: `archivedWorkflowsLoading` boolean state a DataContext-be, `fetchArchivedWorkflows` start-nél `true`, try/catch finally-ben `false`. A Panel content-je: `if (archivedWorkflowsLoading) → 'Betöltés…'` az empty-state előtt.
    - **Mikor indokolt**: ha explicit user feedback érkezik vagy ha a #97-99 scope-nélküli képernyő javításokkal együtt felülvizsgáljuk az üres-állapot UX-et.

#### M. Felhasználói észrevétel

> **Workflow minden pontnál:**
> 1. `/roast` elemzés az adott modulra (kockázatok, overengineering, edge case-ek)
> 2. Kérdések tisztázása
> 3. `/harden` futtatás
> 4. ✅ Kipipálás
 
- [x] 97. **Szervezetváltás**: (2026-04-21)
      Bug: office nélküli új szervezetre (pl. Ringier) váltáskor a régi scope `publications` state-je bennragadt — az `ArticleTable` nem tűnt el és az onboarding splash sosem jelent meg.
      - **Gyökérok**: [DashboardLayout.jsx:102](packages/maestro-dashboard/src/routes/dashboard/DashboardLayout.jsx:102) scope-váltás effect `if (!activeEditorialOfficeId) return;` korai visszatérése. A `ScopeContext` stale-ID validáció `setActiveOffice(null)`-ra állít, ha az új szervezetnek nincs szerkesztősége — a guard ezen az ágon blokkolja a `fetchPublications` / `switchPublication(null)` clear-elést, így a `publications.length > 0` miatt az `isOnboarding` feltétel (`publications.length === 0`) sose teljesül.
      - **Fix**: a guard-return eltávolítva. A `fetchPublications()` null office-ra `setPublications([])`-t ad (DataContext.jsx:87-89), `fetchWorkflow()` null scope-ra `setWorkflows([])`-t ad (DataContext.jsx:283-286), `switchPublication(null)` clearel articles/layouts/deadlines/validations-t. Mind null-tolerant, ezért a belső feltételes guard is redundáns volt.
      - **Harden**: 3-way review (codex / codex adversarial / Claude agent) egyaránt CLEAN egy iterációban. Minden megmaradt megfigyelés pre-existing (pl. `fetchWorkflow` dupla-fetch a DataContext scope-effect és a DashboardLayout effect között) vagy premature future-proofing — a fix scope-ján kívül.

- [x] 98. **Archivált workflow-k száma**: (2026-04-21)
      Bug: `WorkflowLibraryPanel` megnyitáskor az Archivált tab-címke csak `Archivált` (vagy `Archivált (N)` ha N>0) — de az N csak a tab-ra kattintás utáni lazy fetch után töltődött be, nem azonnal.
      - **Gyökérok**: [WorkflowLibraryPanel.jsx:206-208](packages/maestro-dashboard/src/components/workflows/WorkflowLibraryPanel.jsx:206) a `fetchArchived` csak `tab === 'archived'`-re futott; a tab-label `Archivált{tab === 'archived' || archivedCount > 0 ? ` (${archivedCount})` : ''}` conditional feltétele miatt modal-nyitáskor nem látszott szám.
      - **Fix**: archivált workflow-k state központosítva a `DataContext`-be (scope-eager fetch + Realtime dual-list handler). A Panel csak consumer — nincs saját fetch/schema-heal/loading state.
        - [DataContext.jsx:50-54](packages/maestro-dashboard/src/contexts/DataContext.jsx:50) új `archivedWorkflows` + `archivedWorkflowsError` state.
        - [DataContext.jsx:61-74](packages/maestro-dashboard/src/contexts/DataContext.jsx:61) `workflowLatestUpdatedAtRef` (Map `$id → $updatedAt`) — globális version-ref, out-of-order Realtime események stale cross-list upsert-jét blokkolja.
        - [DataContext.jsx:76-80](packages/maestro-dashboard/src/contexts/DataContext.jsx:76) `archivedFetchGenRef` — A→B→A scope-váltás gen-guard a REST response race-re.
        - [DataContext.jsx:337-398](packages/maestro-dashboard/src/contexts/DataContext.jsx:337) `fetchArchivedWorkflows` callback: scope-race + gen guard, filter-only (nem-merge) a REST snapshot-ra, stale cross-list visibility-leak védelem.
        - [DataContext.jsx:946-1007](packages/maestro-dashboard/src/contexts/DataContext.jsx:946) `applyWorkflowEvent` refactor: 6-arg signature (`setWorkflows`, `setArchivedWorkflows`, `versionsMap`), delete törli a versionsMap entry-t, globális stale-check minden event-re, archive↔restore átmenet mindkét listán karbantartott.
        - [WorkflowLibraryPanel.jsx:88](packages/maestro-dashboard/src/components/workflows/WorkflowLibraryPanel.jsx:88) `archivedWorkflows` + `archivedWorkflowsError` destructured from `useData()`; local state/fetch/schema-heal removed.
      - **Harden (3-way review, 4+ iteráció)**:
        - Iter 0 simplify + Maestro audit: magyar WHY-kommentek, import sorrend, nincs BC shim.
        - Iter 1: adversarial MEDIUM (auto-bootstrap on navigation unsafe) → bootstrap eltávolítva a fetch path-ból, user-friendly hibaüzenet helyette; Claude MEDIUM stale-list (fetch hibánál előző scope data) → clear at fetch start.
        - Iter 2: all 3 reviewers flagged scope-race → `isScopeStale()` closure guard post-await.
        - Iter 3: codex P2 cross-list duplicate out-of-order event → `workflowLatestUpdatedAtRef` globális version-check.
        - Iter 4: Claude MEDIUM scope-clear baseline-silence + seedWorkflowVersions undefined guard + komment typos → javítva; adversarial HIGH no-office-to-no-office scope → DashboardLayout `prevScopeKeyRef` (orgId:officeId tuple).
        - Iter 5: mindhárom reviewer flagged `.clear()` races with `fetchWorkflow` seed → `.clear()` eltávolítva (monoton $updatedAt + union `>=` seed elegendő); codex P2 A→B→A race → `archivedFetchGenRef` gen-counter.
        - Iter 6: codex P2 fetch-vs-Realtime race → filter+merge pattern hozzáadva.
        - Iter 7: adversarial HIGH merge preserves out-of-scope items (trust-boundary leak) → merge eltávolítva, filter-only (trade-off: rare mid-flight archive esemény elveszhet, cserébe nincs out-of-scope leak).
      - **Visszatartva** (out-of-scope, pre-existing, vagy tudatos döntés):
        - `fetchWorkflow` scope-race guard hiánya → pre-existing, szimmetrikus fix külön task.
        - `Archivált (0)` unconditioner megjelenítése → task-szándék (mindig látszik a szám).
        - `restoreWorkflow` Realtime-függősége (nincs optimistic local update) → konzisztens az `archiveWorkflow` pattern-nel, Realtime bus megbízható ([dashboard-realtime-bus.md](~/.claude/projects/-Users-imre-sashalmi-Documents-Maestro-Plugin/memory/dashboard-realtime-bus.md)).
        - Legacy `archivedAt` schema auto-heal eltávolítása → iter 1-ben tudatos döntés (admin op nem piggyback navigáción); user-facing üzenet instruálja az owner-t.
        - Loading state a Panel content-re fetch közben → minor UX polish, nem a task része.

- [ ] 99. **Eltérő screen-ek szerkesztőség nélküli szervezeteknél**
      A Ringier-nél és a Marquard-nál is más, más kezdőképernyő látható, pedig egyiknek sincs szerkesztősége. Ez adódhat abból, hogy a Ringier egy frissen létrehozott kiadó a Marquardnak viszont már volt egyszer egy szerkesztősége ami törölve lett, de az viszont szerintem hibás működés, hogy ha nincs szerkesztőség, akkor a workflow gomb kattintható. A Ringier-nél ez disabled.
      ![[Screenshot 2026-04-21 at 21.14.28.png|553]]
      ![[Screenshot 2026-04-21 at 21.14.41.png]]

#### N. UI review

- [ ] N-01. **A Workflow Library Panel modernizálása**
      A @Maestro Web Dashboard/src/components/workflows/WorkflowLibraryPanel.jsx -et szeretném tovább modernizálni. Elsődleges szempont a könnyű használhatóság lenne, ennek felméréséhez használd a Claude Design skilleket (pl. /design-critique) acél, egy kítűnő UX élmény. A láthatósági scope kezelésére is készíthetünk egy speciális UI elemet. A legegyszerűbb megoldás egy olyan gombcsoport lenne (a gombcsoportnak ránézésre egy darab UI elemnek kellene lennie, az én fejemben egy olyan elem van ami úgy néz ki mint egy nagyobb gomb, ami a több elemre van tagolva), aminek az egyes gombjai kétállásúak lennének. Ha benyomom bekapcsol, ha újra benyomom kikapcsol. Így lehetne a scope szűrőt állítani. Ha minden gomb be van nyomva, akkor az felelne meg a mostani Mind nyomógombnak. Természetesen illeszkedjen a mostani design-hez, és tegyük el egy újrafelhasználható elemként, még máshol is használhatjuk a jövőben.
      Az egész dashboardon be kellene állítani egy egységes badge kinézetet, nekem az @Maestro Web Dashboard/src/components/ArticleRow.jsx -ben használt LockLabel megfelelő lenne. A @Maestro Web Dashboard/src/components/workflows/WorkflowLibraryPanel.jsx-ben most használt badge-ek nekem inkább egy gombhoz hasonlítanak.
      Az archivált tab-on lévő workflow-knál érdemes lenne azt is feltüntetni, hogy mikor kerülnek törlésre
      Mind a két tabon a workflow-kat lehessen nézni ikonos nézetben és soros nézetben.
      A tabok váltásánál nincs meg az a modal animáció ami a méretezeésnél működik már a beállítások panelen, ezt szeretném ha mindig megvalósulna.
      Ha bármi olyan változik ami érinti a @Maestro Web Dashboard/design-system.md-t, akkor azokkal frissítsük!



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
