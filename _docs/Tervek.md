Egy átfogóbb leírást szeretnék a Maestro működéséről adni neked. Ha ellentmondást vagy logikátlanságot találsz, esetleg más a véleményed valamiről, beszéljük meg, a végleges terv után a részfeladatokat a megfelelő logikai sorrendben vezessük fel a [[Feladatok]]-ba. 


#### **Jogosultsági rendszer**
- Jogosultsági rendszernek két nagyobb csoportja is lenne: dashboard jogosultságok, workflow jogosultságok. 
- Ezeken a nagyobb csoportokon belül kellene az egyes jogosultság-opciókat is logikai csoportokba szervezni a könnyebb átláthatóság és a kezelhetőség érdekében. 
- Ha megvannak a csoportokba szervezett jogosultság-opciók ezeket úgy lehetne a regisztrált felhasználókhoz rendelni, hogy a felhasználó-csoportokat képzünk, amikhez hozzá rendelhetjük az egyes jogosultság-csoportokat amiken belül kiválaszthatjuk az egyes jogosultság-opciókat.
- A dashboard felhasználó-jogosultságok (logikai csoportokba szedve) a jelenlegi működést kell, hogy lefedjék (a fejlesztések előrehaladtával változhatnak, erre is fel kellene készülni).
- A dashboard felhasználó-jogosultságokat is most kell meghatároznunk.
- A workflow felhasználó-csoportokat lehet definiálni az a dashboard felületén az egyes szerkesztőségeknél, és szintén itt, a szerkesztőségeknél lehet beolvasni a workflow-kat amiket a szerkesztőség használ, és ezek is hozzák magukkal a működésükhöz szükséges felhasználó-csoportokat. 


#### Workflow kezelés

> Implementálva 2026-04-20: lásd [[Döntések/0006-workflow-lifecycle-scope]]. A workflow self-contained entitás, 3-state visibility (`editorial_office` / `organization` / `public`), soft-delete + napi cron hard-delete, doc-szintű ACL, breadcrumb chip + publication-assignment-os `WorkflowLibraryPanel`, idegen workflow read-only + Duplikál & Szerkeszt CTA.


#### *Parancsok és validátorok
- A parancsok és validátorok közös, dinamikus extension-rendszerre épülnek: minden új parancs/validátor egy DB-ben tárolt **InDesign ExtendScript** szkript, amit a plugin runtime betölt és futtat.
- A kód kizárólag InDesign ExtendScript lehet — vagyis olyan, ami amúgy is futhatna InDesign szkriptként. Nem kell külön JS sandbox, mert az ExtendScript runtime a meglévő, kontrollált környezet (a beépített parancsok és validátorok is így futnak).
- Az extension egy DB doc (új `workflowExtensions` collection a workflow-k mintájára), mezői: név, slug (egyedi szerkesztőségen belül), kind (`validator` | `command`), scope (`article` | `publication`), kód (ExtendScript forrás), opcionális paraméter-séma, láthatósági scope (mint a workflow-knál: szerkesztőség / kiadó), archiválás.
- Az extension kódjának egyetlen kötött szerződést kell követnie: globális `maestroExtension(input)` függvény, ami JSON-ben kapja a kontextust (cikk, opciók, kiadvány-gyökér), és JSON-ben adja vissza az eredményt — validátornál `{ isValid, errors[], warnings[] }`, parancsnál `{ success, error?, message? }`.
- A workflow Designerben a beépített és a custom extension-ök egyetlen választható listában jelennek meg; a workflow JSON `validations` / `commands` mezőiben a custom hivatkozás `ext.<slug>` prefixszel megy (nincs új mező a sémában).
- A kiadvány aktiválásakor a workflow snapshot mellé az **extension-snapshot** is rögzül (a használt custom-ok kódja + metaadata) — futó kiadvány alól nem módosítható a viselkedés.
- Phase 0 (MVP): csak `validator` és `command` kind, csak `article` scope, admin-only CRUD, egyszerű textarea editor + alap szintaxis-validáció (nincs Monaco), nincs marketplace.
- Phase 1+: publikáció-scope extension, ExtendScript-oldali Maestro SDK (logger / fájlhozzáférés helper), 3rd-party közzététel, marketplace, jogosultsági integráció (a fenti felhasználó-jogosultsági rendszer extension-szintű kibővítése).
- Megvalósításkor a részletes architektúra-vázlat (adatmodell, plugin runtime dispatch, snapshot stratégia, fájl-térkép, kockázatok) ADR-be kerül ([[Döntések/0007-workflow-extensions]]) + atomic note a kontraktról ([[Komponensek/WorkflowExtension]]).


#### **Dashboard UI redesign**

Alapvetően a Stitch által létrehozott irányt megfelelőnek találom, a te észrevételeidet szeretném a sajátjaimmal kiegészíteni.

**Megőrzendő:** világos és sötét téma kezelése továbbra is kell — mindkét variánst meg kell tartani (Editorial OS dark + light megfelelője).

**Általános benyomás:** a dark „Editorial OS" identitás iránya jó (No-Line szabály, tonal layering, state badge pattern a helyén). Stitch projekt: `1419785137701042796`, 5 screen áttekintve 2026-04-22-én. A Table View két variánsa közül a **v2 markánsan jobb UX-ileg**, érdemes erre építeni.

**Table View** (v2 irányra építeni):
- *Kiemelendő:* relatív idő labelek átveendők (`Ma 09:00`, `Holnap 12:00`, `Péntek 10:00`).
- Cikkcím alatt subtitle (rovat / típus) — jó info-density.
- Ikonos HUD + „MŰVELETEK" label tisztább.
- „CSAK SAJÁT" uppercase toggle felesleges — sentence case elég.
- Nav címkék magyarosítandók (a generált screen-en angolok voltak).
- A sidebar a valós 5 itemmel jelenjen meg: Cikkek / Layout / Workflow / Felhasználók / Beállítások (a generált 7 helyett).
- State badge-ekről hiányzik a soft glow drop-shadow — visszahozandó (ne lapos solid pill).
- Alsó HUD ne legyen zsúfolt, kijelölésszám is látsszon.

**Flatplan:**
- A layout kódok egybetűsek (A, B, C, D…) — nem „Section A/B/C" tab.
- Cover spread vizuális hangsúly OK (helyes editorial döntés).
- A spread-kártyák kerettelenebbek legyenek a No-Line szabály szerint.
- Alsó progress bar (`17/48 oldal · 8%`) jó forma.

**Workflow Designer** (a legerősebb screen):
- Háromosztat (paletta + canvas + properties sidebar) tartandó.
- Selected node accent ring, edge label-ek, minimap, danger action OK.
- Magyar palette címkék (ÁLLAPOTOK / SZEREPLŐK / VALIDÁCIÓK) OK.
- Canvas kissé üres volt — a kért 7 állapotból csak 5 jelent meg a generálásnál.

**Publication Settings modal** (a leggyengébb iteráció):
- Coverage bar, tab active underline, warning tile OK.
- Hiányzik a kért **timeline vizualizáció** — csak az „Ütemezés áttekintése" fejléc van, alatta üres.
- A 3. kártya warning státusza túl visszafogott, nem olvasható első ránézésre.

**Hiányzó / regenerálandó screenek:**
- Login flow.
- Workflow Library Panel (korábbi N-01 task → [[Komponensek/WorkflowLibrary]]).
- Organization Settings / Editorial Office Groups Matrix.
- Create Publication modal.

**Javasolt következő iteráció:**
1. Table View regenerálás v2 irányban (relatív idő + subtitle + ikonos HUD).
2. Publication Settings modal újragenerálása timeline-nal.
3. Flatplan: layout kódok javítása.
4. Light theme variáns generálása a megerősített dark v2 base-ről (`apply_design_system` a legjobb screenekre).
5. A fenti hiányzó screenek generálása.

> Megj.: a Workflow Designer Fázis 0-hoz külön Stitch projekt (`6473627341647079144`) is van — annak részletes annotációi és „Eltérés a tervtől" észrevételei a [[workflow-designer/stitch-screens/README|stitch-screens]] mappában olvashatók. Az itteni Dashboard UI redesign attól független iteráció.
