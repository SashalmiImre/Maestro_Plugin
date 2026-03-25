---
aliases: [TODO, Tasks, Teendők]
tags: [feladatok]
---

# Feladatok

> Ide gyűjtsd a fejlesztési ötleteket, bugokat, teendőket. A Claude Code is olvassa — megbeszéljük, majd kipipáljuk.

## Aktív

- [ ] Csak a tervezőszerkesztők és a művészeti vezetők tudjanak PDF-et írni
- [ ] Teljes kiadvány archiválása a @Maestro InDesign Plugin/src/core/commands/handlers/archiving.js commanddal,  PDF írással amennyiben az összes cikk eljutott az archív state-re. Azt is figyelni kell, hogy a kiadvány összes oldala le legyen fedve, nyilván addig nem tudunk archiválni, amíg nincs meg az összes cikk. Ehhez egy UI-ba illeszkedő gombot kell elhelyezni.
- [ ] A @Maestro InDesign Plugin/src/core/utils/validators/DatabaseIntegrityValidator.js kellene egy funkció ami leellenőrzi, hogy a cikk thumbnail-je elavult e? Ha a thumbnail mentési dátuma korábbi, mint a hozzátartozó InDesign file módosítási dátuma, akkor elavultnak jelölendő. Erre egy validációs error-t kellene dobnia. Az, hogy ez az ellenőrzés mikor fusson le, meg kell beszélnünk.
- [ ] A @Maestro Web Dashboard/src/components/LayoutView.jsx-ban a layout választó dropdown-nál nem látom az összes opció értelmét. Elég lenne szerintem ha csak az aktív layoutok közül lehetne választani. 
- [ ] Ha egy publikáció törlésre kerül, akkor az adatbázisban nem törlődnek a hozzá kapcsolódó, deadline, layout bejegyzések.

## Kész

- [x] Placeholder cikkek a webes felületen is. A kimarad checkboxnak a többi state checkbox mellé kell kerülnie, a helykitöltők mutatásának a saját cikkeim checkbox mellé kell kerülni úgy, ahogy a @Maestro InDesign Plugin/src/ui/features/workspace/FilterBar.jsx-ben van.
- [x] A @Maestro Web Dashboard/index.html-en kellene a fejlécbe egy layout választó dropdown és az abban kiválasztott layutot kirajzolni úgy, hogy ha az adott layouthoz nem tartozik oldal akkor az alap layout oldalát rajzolja, ha tartozik hozzá oldal, akkor pedig értelemszerűen azt.
- [x] A @Maestro Web Dashboard/index.html-en meg kellene oldani, hogy a UI-elemeket ne lehessen nagyítani, kicsinyíteni, természetesen az elrendezés nézetben az oldalakat igen.
- [x] Weben az elrendezés nézetben a zoom sávja együtt mozog az oldalakkal ha scrollozunk.
