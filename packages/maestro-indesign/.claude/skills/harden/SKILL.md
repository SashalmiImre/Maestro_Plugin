---
name: harden
description: Többlépcsős minőségi átvizsgálás — Codex review + adversarial review + Claude szintézis + javítás + simplify + verifikáció. Stabilabb, biztonságosabb, egyszerűbb, tisztább kóddá alakítja a staged/munkafájlokat.
allowed-tools: Skill, Read, Edit, Write, Grep, Glob, Bash(git:*), TodoWrite, AskUserQuestion
---

# Harden — Többlépcsős Minőségi Pass

## Cél

A **staged + unstaged** (working-tree) változásokat átvinni egy olyan folyamaton, ami a kódot **stabilabbá, biztonságosabbá, egyszerűbbé és tisztábbá** teszi. A skill **nem generál új feature-t**, csak a meglévő változásokat csiszolja.

**Args (opcionális):** `$ARGS` — ha `branch`, akkor a teljes branch diff-et vizsgálja (`main...HEAD`), egyébként working-tree módban dolgozik. Ha a user konkrét fókuszt ad (pl. `security`, `performance`), ezt továbbadja a 2. fázisnak.

---

## Előkészítés

### 0. Állapot felmérés

Futtasd párhuzamosan:
- `git status --short --untracked-files=all`
- `git diff --shortstat` (unstaged)
- `git diff --shortstat --cached` (staged)
- `git branch --show-current`

Ha **nincs változás** (sem staged, sem unstaged, sem untracked, sem branch diff): jelezd és állj le.

Ha a változás **triviális** (≤ 1-2 fájl, ≤ 20 sor): kérdezd meg `AskUserQuestion`-nel, hogy tényleg akarja-e a teljes harden folyamatot, vagy elég lenne egy sima `/simplify`. **Ajánld először a rövidebb utat.**

### 0/b. Todo lista

Hozd létre a TodoWrite-tal az alábbi feladatokat (így a user látja a progresszt):

1. Codex review (baseline)
2. Codex adversarial review
3. Szintézis + akcióterv
4. Javítások alkalmazása
5. Simplify pass
6. Verifikáló Codex review
7. Összefoglalás

---

## 1. Fázis — Codex review (baseline defektek)

**Miért ez legyen az első:** a defektek és bugok megtalálása olcsó, és nincs értelme a design-ról elmélkedni, ha a kódban bug van.

Hívd meg:
```
Skill(codex:review, args: "--wait")
```

**Megjegyzés:** a `--wait` explicit — így nem kérdez rá, foreground-ban fut. Ha nagy a változás és lassú, váltható `--background`-ra, de akkor meg kell várnod a completion értesítést, mielőtt a 2. fázisra lépsz.

A kimenetet **mentsd el mentálisan** (vagy szükség esetén egy scratch fájlba) — a 3. fázisban szintetizálni fogod.

Jelöld completed-re a todo #1-et.

---

## 2. Fázis — Codex adversarial review (design kihívás)

**Miért most:** a baseline defektek már ismertek; itt a kérdés: a megközelítés maga jó-e? Milyen feltételezéseken áll a kód? Hol törik real-world terhelés alatt?

Hívd meg:
```
Skill(codex:adversarial-review, args: "--wait <user fókusz ha volt>")
```

Ha a user `$ARGS`-ban fókuszt adott (pl. `security`, `race conditions`, `UXP edge cases`), **add tovább** az adversarial review-nak — ez a parancs támogatja az extra focus text-et a flag-ek után.

Mentsd a kimenetet a szintézishez.

Jelöld completed-re a todo #2-t.

---

## 3. Fázis — Claude saját review + szintézis

**Ez a legfontosabb lépés. Itt Claude a gatekeeper — nem egy negyedik review-riport kell, hanem egy döntés.**

### 3.a — Független olvasat

Olvasd át **saját magad** a diff-et (`git diff` + `git diff --cached`) és a módosított fájlok érintett részeit (Read + Grep). Ne hagyatkozz csak a Codex riportokra.

Fókusz:
- **Projekt-specifikus tudás**: a CLAUDE.md-ban leírt minták betartása (magyar kommentek, logger használat, `$updatedAt` elavulás-védelem, `maestroSkipMonitor` minta, cross-platform pathUtils, dual-proxy failover, stb.). A Codex ezeket nem feltétlenül ismeri.
- **MEMORY.md korábbi tanulságok**: ellenőrizd, nem sértettek-e meg korábban rögzített szabályokat.
- **Async/Realtime/recovery edge-case-ek** — UXP-specifikus kockázatok.
- **Jogosultsági rendszer** (workflowPermissions, elementPermissions) — háromszintű védelem betartása.

### 3.b — Szintézis

Állítsd össze a végleges akciótervet. Minden Codex finding-ot kategorizálj:

| Kategória | Mit jelent | Mi történik vele |
|---|---|---|
| **MUST FIX** | Valós bug, biztonsági lyuk, data loss, crash, race condition, jogosultsági lyuk | Javítani a 4. fázisban |
| **SHOULD FIX** | Tisztább / stabilabb kód, nem akut, de érdemes | Javítani, ha olcsó |
| **NOISE** | False positive, projekt-konvenció ismerete nélkül hozott vélemény, stiláris nitpick amit már eldöntöttünk | **Elutasítani**, és röviden indokolni miért |
| **DESIGN QUESTION** | Az adversarial review olyan alap-feltételezést kérdőjelez meg, aminek eldöntése a user hatáskörébe tartozik | **Nem javítjuk automatikusan**, a user-nek jelezzük a 7. fázisban |

A végén jelenítsd meg a user-nek tömören:
- MUST FIX lista (max 1 mondat / item)
- SHOULD FIX lista
- Elutasított NOISE indokolva
- DESIGN QUESTION lista (user döntésre vár)

**Kérdezd meg `AskUserQuestion`-nel, hogy folytathatod-e a javításokat** a MUST + SHOULD lista alapján, és van-e DESIGN QUESTION, amit most akar megbeszélni.

Jelöld completed-re a todo #3-at.

---

## 4. Fázis — Javítások alkalmazása

A jóváhagyott MUST FIX + SHOULD FIX listát végrehajtod az Edit / Write tool-okkal.

**Szabályok:**
- **Ne kapj el új feladatot** — csak a review-ban jelzett konkrét problémákat javítod. Ha közben más problémát látsz, add hozzá a listához, ne kezdd el spontán.
- **Magyar komment**, projekt-stílus, logger használat (`log`/`logError`/`logWarn`/`logDebug` — sosem `console.*`).
- Ne vezess be új függőséget, új absztrakciós réteget, ha a fix nem igényli.
- Minden változtatás után tartsd észben: a 6. fázisban a Codex újra le fogja ezt tesztelni.

Jelöld completed-re a todo #4-et.

---

## 5. Fázis — Simplify pass

A javítások gyakran **új komplexitást** visznek be (extra guard, extra feltétel, duplikált logika). A simplify feladata ezt visszanyírni.

Hívd meg:
```
Skill(simplify)
```

A simplify skill átnézi a változtatásokat reuse, quality, efficiency szempontjából, és **javítja is** a talált problémákat. **Ez szándékos** — a harden folyamat része, hogy a simplify cleanup-ol.

**Figyelem:** ha a simplify olyan változtatást javasol, ami egy **korábbi MUST FIX-et visszavonna**, NE fogadd el — ilyenkor a simplify félreértette a szándékot. Jelezd a user-nek.

Jelöld completed-re a todo #5-öt.

---

## 6. Fázis — Verifikáló Codex review

A javítás + simplify kombináció könnyen tör dolgokat. Ellenőrző kör kell.

Hívd meg újra:
```
Skill(codex:review, args: "--wait")
```

### Döntés a kimenet alapján:

- **Nincs új probléma, vagy csak nitpick**: a folyamat kész, ugrás a 7. fázisra.
- **Új MUST FIX jelenik meg** (pl. a javítás regressziót hozott, vagy a simplify eltört valamit): **vissza a 3. fázisra** (szintézis + javítás). Maximum **1 további iteráció** — ha utána is van MUST FIX, jelezd a user-nek, hogy a változtatás körkörös problémát generált, és kérj döntést.
- **Új SHOULD FIX**: jelezd a user-nek, de ne javítsd automatikusan második körben — túl mély rabbit hole.

Jelöld completed-re a todo #6-ot (esetleg iteráció után).

---

## 7. Fázis — Összefoglalás

Adj tömör jelentést a user-nek:

```
✓ Harden pass lezárva

Javított problémák (N db):
  - [rövid leírás file:line]
  - ...

Simplify által cleanup-olt (N db):
  - ...

Elutasított findings (noise, N db):
  - rövid indoklás

Nyitott DESIGN QUESTION-ök (user döntést vár, N db):
  - rövid leírás + az adversarial review releváns pontja

Verifikáció: [clean / 1 iteráció után clean / stuck — user döntés kell]
```

**NE commitolj automatikusan.** A commit külön user döntés — ajánld fel, hogy a `/commit` skill-lel lehet zárni.

Jelöld completed-re a todo #7-et.

---

## Mikor NE fusson ez a skill

- **Nincs változás**: 0. fázis detektálja, leáll.
- **Work-in-progress félbehagyott kód**: a Codex review ilyenkor zajos, inkább a user fejezze be a feature-t előbb.
- **Dokumentáció-only változás** (`*.md`): a `review-docs` skill a megfelelő eszköz.
- **Pusztán formázási / lint változás**: felesleges — az adversarial review nem fog értelmes dolgot mondani.

Ha bármelyik szerinted fennáll, jelezd a user-nek és kérdezd meg, tényleg akarja-e.
