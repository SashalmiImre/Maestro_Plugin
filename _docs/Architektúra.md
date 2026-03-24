---
tags: [moc, architektúra]
---

# Architektúra

## Adatfolyam

A rendszer kétcsatornás: React Context (állapot) + MaestroEvent (események).

- [[data-flow-architecture|Adatáramlási architektúra]] — Context → Component renderelési lánc
- [[EVENT_ARCHITECTURE|Esemény architektúra]] — MaestroEvent rendszer, katalógus, szekvencia diagramok
- [[open-file-flow|Fájl megnyitás folyamat]] — Kattintástól a UI frissülésig

## Context Provider hierarchia

```
UserProvider → ConnectionProvider → DataProvider → ValidationProvider → ToastProvider → Main
```

- **DataContext** — Központi adatkezelő (`publications[]`, `articles[]`, `validations[]`)
- **ValidationContext** — Validációs eredmények (rendszer + felhasználói)
- **UserContext** — Auth, session, team membership, labels
- **ConnectionContext** — Online/offline/connecting állapot

## Thumbnail rendszer

- JPEG export ExtendScript-tel → Appwrite Storage feltöltés
- Triggerek: `addArticle`, `documentClosed`, `handlePageNumberChange`
- Link check: missing/out-of-date linkek → export kihagyás + warning toast

## Archiválás

- [[ARCHIVING_TEXT_EXTRACTION|Szövegkinyerés]] — Hibrid AI + szabály-alapú clustering, Union-Find, TXT/XML generálás

## Sürgősség

- [[URGENCY_SYSTEM|Sürgősség-számítás]] — Munkaidő, ünnepnapok, ratio, progresszív színsáv

## Cross-Platform útvonalkezelés

- Kanonikus formátum: `/ShareName/relative/path`
- `MOUNT_PREFIX`: macOS `/Volumes`, Windows `C:/Volumes`
- Konverziós függvények: `toCanonicalPath()`, `toNativePath()`, `toRelativeArticlePath()`, `toAbsoluteArticlePath()`
