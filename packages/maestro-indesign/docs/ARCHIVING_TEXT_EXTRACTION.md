# Archívum — Szövegkinyerési logika

> **Státusz**: Implementálva és élesben. Finomhangolásokkor frissítendő.
> **Implementáció**: `src/core/utils/indesign/archivingScripts.js` (adatgyűjtés) + `src/core/utils/archivingProcessor.js` (feldolgozás) + `src/core/commands/handlers/archiving.js` (hibrid AI/fallback orchestráció)

---

## Terminológia

| Fogalom | Definíció |
|---------|-----------|
| **Folyamatos szövegblokk** | 2+ szövegdobozból álló egység, ahol a szöveg átfolyik egyikből a másikba (InDesign threading — közös `parentStory`). |
| **Logikai szövegblokk** | 2+ szövegdobozból álló egység, ahol a szövegek **nem** folynak át egymásba, mégis egyazon anyaghoz tartoznak: közelségük (proximity) vagy logikailag összekötő grafikai elem kapcsolja össze őket. |
| **Logikailag összekötő grafikai elem** | Kép-, négyszög-, kör- vagy amorf grafikai elem, amelynek **tényleges területével** ≥80%-os átfedésben lévő szövegdobozok egyazon anyaghoz tartoznak. Csak a szövegdoboznál Z-orderben **alatta** lévő elem számít összekötőnek (pl. háttér-téglalap). |
| **Anyag** | Szövegblokkok összessége; az archiválás alapegysége. Egy `.indd` fájlban akár 10–15 különálló anyag is lehet. |
| **Story** | InDesign-ból kinyert, `storyId` alapján deduplikált szövegegység (threading-en belül egyetlen egységként kezelve). |

---

## Olvasási sorrend

Természetes olvasási sorrend: **bal felső → jobbra → lefelé** (jobb alsó sarok felé).

Rendezési kulcsok: **spread → Y koordináta → X koordináta**.

A spread-en belül a bal és jobb oldal **együtt** kezelendő — a két oldal határán átnyúló elemek
összeköthetnek szövegdobozokat mindkét oldalon.

---

## Vizsgálati mélység (Z-order)

Minden vizsgálatot az **összes layer-en** kell elvégezni, a legfelső rétegtől (legkisebb
layer-index) a legalsóig (legnagyobb layer-index).

Ha egy logikailag összekötő grafikai elem megtalálható egy adott szövegdoboz **alatt** bármely
layer-en, és az elem területével a szövegdoboz ≥80%-ban átfed, az a szövegdobozok csoportjához
köti az összes többi hasonlóan átfedő szövegdobozt is.

Ez a kapcsolat **tranzitív**: ha A↔X és B↔X (azonos összekötő), akkor A–B is egyazon anyaghoz kerül.

---

## Szövegtípusok

### Betűméret-hierarchia (csökkenő sorrendben)

| Szint | Típus | XML tag | Jellemző |
|-------|-------|---------|---------|
| 1 | Cím | `<CIM>` | Legnagyobb betűméret az anyagban |
| 2 | Lead | `<LEAD>` | |
| 3a | Közcím | `<KOZCIM>` | Kenyérszövegen **belül** jelenik meg, nem önálló doboz |
| 3b | Kiemelés | `<KIEMELES>` | Önálló szövegdoboz, betűmérete **nagyobb** mint a keretes szövegé |
| 3c | Keretes cím | `<KERETES_CIM>` | A keretes blokk első paragrafusa |
| 4a | Kenyérszöveg | `<KENYERSZOVEG>` | |
| 4b | Keretes szöveg | `<KERETES_SZOVEG>` | `<KERETES>` blokkon belül |
| 5 | Kredit | `<KEPALAIRAS>` | Fotó / illusztráció hivatkozás |

### Jellemző karakterszám-tartományok

| Típus | Karakterszám | Megjegyzés |
|-------|-------------|------------|
| Cím | 10–40 | |
| Lead | 50–150 | |
| Közcím | 20–40 | Nagy mennyiségű szöveget tör meg; kenyérszövegen belül különálló bekezdés |
| Kiemelés | 20–100 | Önálló szövegdoboz |
| Keretes cím | 20–40 | |
| Kenyérszöveg | 200–10 000 | |
| Kredit | 30–100 | |

> **Megjegyzés**: A karakterszám-tartományok közelítő értékek, csak nagyságrendet mutatnak.
> Az osztályozás elsősorban betűméret-arányokon és InDesign bekezdésstílus-neveken alapul.

---

## Hibrid klaszterezési architektúra

Az archiválás két lépcsős, hibrid megközelítéssel dolgozza fel a szövegkereteket:

```
archiving.js handler
  │
  ├─ 1. InDesign adatgyűjtés (ExtendScript)
  │    └─ generateExtractArticleDataScript(inddPath) → JSON
  │
  ├─ 2. _processWithAIFallback(rawData) — AI klaszterezés
  │    │
  │    ├─ prepareStoriesForAI(rawData)
  │    │    └─ storyId alapú deduplikálás, súlyozott avgFs, első 200 char, bounds
  │    │
  │    ├─ POST /api/cluster-article → proxy (Groq Llama 3.3 70B, 15s timeout, GROQ_API_KEY env)
  │    │    └─ visszatér: { clusters: [{ storyIds, types }] }
  │    │
  │    ├─ ha OK → buildOutputFromAIClusters(rawData, aiResponse)
  │    │
  │    └─ ha hiba/timeout → processArticleData(rawData) [FALLBACK]
  │         └─ Union-Find szabály-alapú klaszterezés
  │
  ├─ 3. generateSaveTextFilesScript(...)
  │    └─ InDesign: TXT + XML fájlok kiírása
  │
  └─ 4. generateCopyInddScript(...)
       └─ InDesign: INDD fájl másolása az __ARCHIV/INDD/ mappába
```

### AI klaszterezés (elsődleges útvonal)

A proxy szerver (`maestro-proxy/server.js`) `/api/cluster-article` endpointja:
- Fogadja a story summarykat (pozíció, betűméret, szövegtöredék, storyId)
- Elküldi Groq Llama 3.3 70B-nek magyar prompt-tal (GROQ_API_KEY env var szükséges, groq-sdk kliens)
- Visszaadja a klasztereket és típusosztályozást: `{ clusters: [{ storyIds, types }] }`

**Előny mozaik layoutoknál**: Az AI szemantikailag érti a szövegek összetartozását — ahol a szabály-alapú közelség-küszöb (~30pt) hibásan összeolvasztaná a független mini-cikkeket, az AI képes elkülöníteni őket.

**Fallback feltételek** (automatikus visszaesés szabály-alapúra):
- Proxy nem elérhető (hálózati hiba, timeout > 15s)
- AI endpoint HTTP hiba (4xx, 5xx)
- Üres clusters válasz

### Szabály-alapú klaszterezés (fallback)

Az összetartozó szövegdobozokat **Union-Find** algoritmus csoportosítja, az alábbi prioritási
sorrendben:

#### 1. Threading (folyamatos szövegblokk)

Azonos `parentStory`-val rendelkező keretek (szöveg átfolyik köztük) egyazon anyaghoz
tartoznak.

#### 2. Térbeli közelség (logikai szövegblokk)

Ha két szövegdoboz befoglaló téglalapjainak minimális távolsága **< 30 pt** és azonos
spreaden találhatók, egyazon anyaghoz tartoznak. Nincs guard — minden közeli keret
összekapcsolódik.

#### 3. Grafikai összekötő — konzervatív merge

Ha egy grafikai elem **tényleges területével** ≥80%-os átfedésben van egy szövegdobozzal,
és az elem Z-orderben **alatta** van (mélyebb layer-en vagy azonos layer-en belül mélyebb
pozícióban), akkor összekötőnek tekintjük.

**Konzervatív szabály**: Az összekötő csak akkor vonja össze a klasztereket, ha
**≤ 5 különálló** (proximity + threading által már létrehozott) klasztert érint.
Ha egy grafikai elem > 5 klasztert érintene → háttérelemnek minősül és nem von össze.

Ez az elv layout-függetlenül működik: egy **valódi összekötő lokális** (néhány szomszédos
szövegtömböt köt össze), míg egy **háttérelem globális** (az oldal legtöbb klaszterét
érintené).

Az átfedés számítása típus szerint:

| Grafikai elem típusa | Átfedési számítás |
|---------------------|-------------------|
| Téglalap | Bounding box átfedési terület / szövegdoboz területe |
| Ovális / kör | A szövegdoboz középpontja az ellipszis belsejében van-e |
| Sokszög / amorf | **Tényleges terület**: Shoelace-formula (polygon terület) + Sutherland-Hodgman clipping (polygon–téglalap metszet) |

> **Megjegyzés**: Az InDesign Group-tagság **nem** vizuális jel, ezért a szabály-alapú
> klaszterezésben nem vesz részt. Az AI útvonal semantikailag értelmezi a csoportosítást.

---

## Típusosztályozás

### Layout-típus automatikus felismerése (szabály-alapú fallback)

Az összes szövegdoboz klaszterezése után:

- **Hosszú szöveges mód**: Ha egy anyag tartalmazza a teljes dokumentum karakterszámának
  **>40%-át** → globális osztályozás az egész dokumentumra.
- **Fragmentált mód** (pl. celebrity-mozaik): Ha nincs domináns anyag → anyagonkénti
  önálló osztályozás.

### Hosszú szöveges mód — globális osztályozás

Az összes story betűméret-arányai és karakterszámai alapján, a kenyérszöveg `avgFs`-éhez
viszonyítva:

| Típus | Betűméret-feltétel | Karakterszám-feltétel |
|-------|-------------------|-----------------------|
| Kenyérszöveg | — | Legtöbb karakter |
| Cím | ≥ 150% body `avgFs` | < 250 karakter |
| Lead | ≥ 120% body `avgFs` | 40–800 karakter |
| Keretes | — | Első bekezdés rövid (<100 kar.) és kiemelkedő betűméretű |
| Képaláírás/Kredit | — | < 120 karakter |

A bekezdésstílus-neve felülírhatja a heurisztikát (ld. Stílusnév-hint táblázat).

### Fragmentált mód — klaszterenkénti osztályozás

Minden klaszter önálló `<ELEM>` blokkot alkot az XML-ben.

| Típus | Feltétel |
|-------|---------|
| Cím | Stílusnév-hint, vagy a klaszterben legnagyobb `avgFs`, ha ≥15%-kal nagyobb a másodiknál |
| Kiemelés | Önálló story, 20–100 kar., `avgFs` ≥ 120% body, nem keretes szerkezetű |
| Keretes | Első bekezdés rövid + kiemelkedő betűméretű (keretes cím jelzése) |
| Kenyérszöveg | ≥ 150 karakter, nem keretes |
| Kredit/Képaláírás | < 150 karakter, nem kiemelés |

### Stílusnév-hint táblázat

Az InDesign bekezdésstílus-neve alapján a rendszer azonosítja a típust (felülírja a heurisztikát):

| Stílusnév-minta | Típus |
|-----------------|-------|
| `CIM`, `TITLE`, `HEAD`, `FEJL`, `RUBR` | Cím |
| `LEAD`, `BEVEZET`, `INTRO` | Lead |
| `KÉP`, `CAPTION`, `FOTO` | Kredit/Képaláírás |
| `KERET`, `BOX`, `SIDEBAR` | Keretes |
| `KÖZC`, `SUBHEAD`, `ALC` | Közcím (kenyérszövegen belül) |

---

## XML kimenet struktúra

### Hosszú szöveges mód

```xml
<?xml version='1.0' encoding='UTF-8'?>
<article>
  <CIM>Főcím szövege</CIM>
  <LEAD>Bevezető szöveg...</LEAD>
  <KENYERSZOVEG>Hosszú testszöveg...</KENYERSZOVEG>
  <KOZCIM>Alcím a szöveg közepén</KOZCIM>
  <KENYERSZOVEG>Folytatás...</KENYERSZOVEG>
  <KERETES>
    <KERETES_CIM>Keretes doboz címe</KERETES_CIM>
    <KERETES_SZOVEG>Keretes szöveg tartalma</KERETES_SZOVEG>
  </KERETES>
  <KEPALAIRAS>Fotó: Szerző neve</KEPALAIRAS>
</article>
```

### Fragmentált mód (mozaik) — AI és szabály-alapú egyaránt

```xml
<?xml version='1.0' encoding='UTF-8'?>
<article>
  <ELEM>
    <CIM>Celebrity neve</CIM>
    <KENYERSZOVEG>Rövid szöveg a celeb-ről...</KENYERSZOVEG>
  </ELEM>
  <ELEM>
    <CIM>Másik celebrity neve</CIM>
    <KIEMELES>Kiemelés szövege</KIEMELES>
    <KENYERSZOVEG>Szöveg...</KENYERSZOVEG>
  </ELEM>
</article>
```

---

## Proxy endpoint — `/api/cluster-article`

**Cím**: `POST {proxyBase}/api/cluster-article`

**Kérés payload**:
```json
{
  "stories": [
    {
      "storyId": "story_123",
      "text": "Első 200 karakter...",
      "fontSize": 24.0,
      "styleName": "CIM",
      "bounds": [10, 10, 50, 200],
      "pageIdx": 0,
      "charCount": 45
    }
  ]
}
```

**Válasz**:
```json
{
  "clusters": [
    {
      "storyIds": ["story_123", "story_456"],
      "types": {
        "story_123": "CIM",
        "story_456": "KENYERSZOVEG"
      }
    }
  ]
}
```

**Típus értékek**: `CIM`, `LEAD`, `KENYERSZOVEG`, `KEPALAIRAS`, `KERETES`, `KOZCIM`, `KIEMELES`

**Fallback**: Ha az endpoint nem elérhető (501 — nincs API kulcs konfigurálva) vagy hiba lép fel, a plugin automatikusan a szabály-alapú `processArticleData()` függvényre esik vissza.

---

## Implementációs állapot

| Funkció | Állapot |
|---------|---------|
| Spread-tudatos bejárás | ✅ Implementálva |
| Rekurzív Group-bejárás | ✅ Implementálva |
| Threading detektálás | ✅ Implementálva |
| Konzervatív grafikai összekötő (≤5 klaszter merge) | ✅ Implementálva |
| Stílusnév-hint osztályozás | ✅ Implementálva |
| Betűméret-arány osztályozás (CÍM, LEAD, KENYÉRSZÖVEG, KERETES, KÖZCÍM) | ✅ Implementálva |
| Logikailag összekötő elem — téglalap (bounding box) | ✅ Implementálva |
| Logikailag összekötő elem — ovális (középpont-ellenőrzés) | ✅ Implementálva |
| Logikailag összekötő elem — Z-order feltétel | ✅ Implementálva |
| Logikailag összekötő elem — polygon tényleges terület (Shoelace + Sutherland-Hodgman) | ✅ Implementálva |
| KIEMELÉS típus (`<KIEMELES>` tag) | ✅ Implementálva |
| Hibrid architektúra (InDesign csak adatgyűjt, plugin dolgoz fel) | ✅ Implementálva |
| AI klaszterezés (Groq Llama 3.3 70B, proxy endpoint, GROQ_API_KEY) | ✅ Implementálva |
| AI fallback szabály-alapúra (timeout, hiba, üres válasz) | ✅ Implementálva |
| Story deduplikálás storyId alapján (AI előkészítés) | ✅ Implementálva |
| Kredit önálló típus (jelenleg KEPALAIRAS) | 🔄 Jövőbeli finomhangolás |
