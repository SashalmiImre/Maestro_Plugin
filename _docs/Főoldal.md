---
aliases: [Home, Kezdőlap]
tags: [moc]
---

# Maestro — Dokumentáció

> Szerkesztőségi munkafolyamat-kezelő rendszer: InDesign plugin + Web Dashboard + Proxy + Appwrite Cloud.

## Rendszer áttekintés

[[WORKSPACE|Workspace leírás]] — monorepo struktúra, package-ek, függőségi gráf.

| Package | Leírás |
|---------|--------|
| [[packages/maestro-indesign/README\|maestro-indesign]] | InDesign UXP plugin |
| [[packages/maestro-dashboard/CLAUDE\|maestro-dashboard]] | Web Dashboard (Next.js) |
| [[packages/maestro-proxy/README\|maestro-proxy]] | CORS/WebSocket proxy |

## Témakörök

- [[Architektúra]] — Adatfolyam, kontextusok, komponens-hierarchia
- [[Hálózat]] — Proxy, Realtime, recovery, failover
- [[Munkafolyamat]] — Állapotgép, jogosultságok, validáció
- [[Fejlesztési szabályok]] — Kódstílus, elnevezés, hozzájárulás

## Tudástár modulok

- [[Komponensek/index|Komponensek]] — atomic notes a domain-fogalmakhoz
- [[Döntések/index|Döntések (ADR)]] — architektúra-szintű döntések
- [[Naplók/index|Naplók]] — daily notes
- [[Csomagok/index|Csomagok]] — package overview-k
- [[Hibaelhárítás]] — ismert problémák és workaround-ok
- [[Tervek]] — folyamatban lévő tervek és nyitott design-kérdések
- [[Feladatok]] — aktuális teendők (rövid lista, érett tartalom az ADR-ekbe / atomic note-okba költözik)

## Archívum

- [[archive/README|Archívum áttekintő]] — `_docs/archive/`: korábbi WORKFLOW_*.md verziók (történeti referencia)

## Referencia

- [[Szószedet]] — Fogalmak és rövidítések
- [[packages/maestro-indesign/CLAUDE|CLAUDE.md (InDesign)]] — Teljes architektúra útmutató
- [[packages/maestro-dashboard/CLAUDE|CLAUDE.md (Dashboard)]] — Dashboard architektúra
- [[packages/maestro-indesign/CONTRIBUTING|CONTRIBUTING.md]] — Fejlesztési szabványok

## AI Kontextus

A `CLAUDE.md` fájlok a Claude Code számára készültek. Nem Obsidian-ra optimalizáltak, de az architektúra legteljesebb leírását tartalmazzák.
