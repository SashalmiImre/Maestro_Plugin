---
aliases: [TODO, Tasks, Teendők]
tags: [feladatok]
---

# Feladatok

> Ide gyűjtsd a fejlesztési ötleteket, bugokat, teendőket. A Claude Code is olvassa — megbeszéljük, majd kipipáljuk.

## Aktív




## Kész
### Appwrite Cloud Function-ök — Szerver-oldali üzleti logika

> A kliens-oldali (InDesign plugin / Dashboard) kód jelenleg "becsületalapú" — a jogosultságokat, zárolást és adatintegritást csak a UI ellenőrzi. Közvetlen API hívással ezek megkerülhetők. Az alábbi Cloud Function-ök szerver-oldalon is kikényszerítik a szabályokat.

#### Kritikus — Biztonsági kockázat

- [x] **`validate-workflow-transition`** + **`validate-article-update`** → Összevonva: **`article-update-guard`** Cloud Function. A `config` collection `workflow_config` dokumentumából olvassa a konstansokat (STATE_PERMISSIONS, VALID_TRANSITIONS, TEAM_ARTICLE_FIELD, CAPABILITY_LABELS). A `previousState` mező az articles collection-ben biztosítja az előző állapot ismeretét. `modifiedByClientId = 'server-guard'` sentinel védi a végtelen ciklus ellen.

- [x] **`validate-article-creation`** — Cikk létrehozás szerver-oldali validáció. publicationId ellenőrzés (404 → törlés), state validáció, contributor user létezés ellenőrzés, filePath formátum.

#### Fontos — Adatintegritás

- [x] **`validate-article-update`** — Összevonva az `article-update-guard`-dal (ld. fent).

- [x] **`validate-publication-update`** — Kiadvány módosítás szerver-oldali validáció. Default contributor ID-k ellenőrzése, rootPath kanonikus formátum figyelése.

- [x] **`cascade-delete` bővítés** — MÁR KÉSZ: A `cascade-delete/src/main.js` `deleteThumbnails()` függvénye (94-129. sor) már törli a Storage fájlokat. A publication ág az article törlés re-triggerelésén keresztül kezeli.

#### Alacsony prioritás — Karbantartás

- [x] **`cleanup-orphaned-locks`** — Árva zárolások időszakos takarítása. Schedule: naponta 3:00 UTC. 24h-nál régebbi vagy nem létező owner-ű lockokat feloldja.

- [x] **`migrate-legacy-paths`** — Régi formátumú útvonalak egyszeri batch migrációja. DRY_RUN=true alapértelmezett. Path konverziós logika portolva pathUtils.js-ből.

- [x] **`cleanup-orphaned-thumbnails`** — Árva thumbnail fájlok időszakos takarítása. Schedule: hetente vasárnap 4:00 UTC. Storage ↔ DB összehasonlítás, orphaned fájlok törlése.
- [x] Előfizettem az Appwrite-ra de lett egy új szervezetem. Ebbe az új szervezetbe kellene áthelyezni MCP-vel a másikból a maestro projektet. Állítólag át lehet helyezni, de vigyázni kell mert van egy bug, hogy ha a régi szervezetből kitörlődik a projekt, akkor az újból is eltűnik. Nem tudom, hogy ez van e már javítva. Ha ez megvan, akkor a label-ek elgépelésének megelőzésére tervezett funkció is implementálható.
- [x] Appwrite SDK frissítés 21.5.0 → 24.1.1 (major breaking change). InDesign plugin: appwrite 21.5.0→24.1.1, Dashboard: 16.0.2→24.1.1, Proxy: node-appwrite 22.1.2→23.1.0. Kritikus: realtimeClient.js activeChannels→activeSubscriptions migráció. Összes API hívás object params stílusra átírva.
- [x] A @Maestro Web Dashboard/src/components/LayoutView.jsx-ben a nagyítás százalékos kijelzésének úgy kellene számítódni, hogy az eredeti kép pixelszáma és a megjelenítés pixelszáma közti százalékos arány legyen. Jelenleg azt veszi 100%-nak, ha az adott képernyőméreten a megadott oldalpár-oszlopszám kifér a képernyőre. A kiegészítő információknak is ezen a méreten kellene alap méreten látszódniuk ami 24pt-os lenne.
- [x] A webes felületen olyan, mintha a validátorok eredményeit saját magának generálja a weboldal, pedig az adatbázisból kellene kiolvasnia az egyes cikkekhez tartozó validátor eredményeket.
- [x] Ha be vagyok jelentkezve a webes felületre de a pluginból is szeretnék a @Maestro InDesign Plugin/src/ui/features/workspace/WorkspaceHeader.jsx#98-109 gombbal bejelentkezni, akkor a weben felugrik a bejelentkezés ablak, de nem enged belépni akkor sem, ha helyes bejelentkezési adatokat adok is meg. Valószínűleg az a baj, hogy már van egy aktív session. Lehet az, hogy ezt is vizsgáljuk?
- [x] Teljes kiadvány archiválása a @Maestro InDesign Plugin/src/core/commands/handlers/archiving.js commanddal, PDF írással amennyiben az összes cikk eljutott az archív state-re. Azt is figyelni kell, hogy a kiadvány összes oldala le legyen fedve, nyilván addig nem tudunk archiválni, amíg nincs meg az összes cikk. Ehhez egy UI-ba illeszkedő gombot kell elhelyezni. Szerintem a @Maestro InDesign Plugin/src/ui/features/workspace/WorkspaceHeader.jsx lenne a megfelelő, de csak akkor jelenjen meg ha az előbbi feltételek teljesülnek.
- [x] Csak a tervezőszerkesztők és a művészeti vezetők tudjanak PDF-et írni a commandsávban lévő gomb segítségével
- [x] Ha egy publikáció törlésre kerül, akkor az adatbázisban nem törlődnek a hozzá kapcsolódó, deadline, layout bejegyzések. — Refaktorálva: `cascade-delete` Cloud Function (`maestro-server/functions/cascade-delete/src/main.js`) mind az article mind a publication deletion eventekre
- [x] WorkspaceHeader szűrők menüpont elrejtése properties panel nézetben (`isPropertiesView` prop + feltételes renderelés)
- [x] MAESTRO lock felirat villanás javítása: optimistic update a `DocumentMonitor.verifyDocumentInBackground()`-ban — a SYSTEM lock azonnal megjelenik a helyi state-ben a DB hívás előtt
- [x] Thumbnail validáció: hiányzó és elavult oldalkép figyelmeztetés (`DatabaseIntegrityValidator.checkThumbnailStaleness()`, `documentClosed` + `documentSaved` triggerek, `VALIDATION_SOURCES.THUMBNAIL`)
- [x] Placeholder cikkek a webes felületen is. A kimarad checkboxnak a többi state checkbox mellé kell kerülnie, a helykitöltők mutatásának a saját cikkeim checkbox mellé kell kerülni úgy, ahogy a @Maestro InDesign Plugin/src/ui/features/workspace/FilterBar.jsx-ben van.
- [x] A @Maestro Web Dashboard/index.html-en kellene a fejlécbe egy layout választó dropdown és az abban kiválasztott layutot kirajzolni úgy, hogy ha az adott layouthoz nem tartozik oldal akkor az alap layout oldalát rajzolja, ha tartozik hozzá oldal, akkor pedig értelemszerűen azt.
- [x] A @Maestro Web Dashboard/index.html-en meg kellene oldani, hogy a UI-elemeket ne lehessen nagyítani, kicsinyíteni, természetesen az elrendezés nézetben az oldalakat igen.
- [x] Weben az elrendezés nézetben a zoom sávja együtt mozog az oldalakkal ha scrollozunk.
