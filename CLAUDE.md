# Maestro Plugin — AI Agent Útmutató

> **Te (Claude / AI agent) ezt a fájlt olvasod először.** A részletek máshol vannak — ez a fájl irányít oda.

## Mi ez a projekt
Yarn workspace monorepo. Szerkesztőségi munkafolyamat-platform: InDesign UXP plugin + Web Dashboard + Proxy + Appwrite Cloud backend. Magyar kommentek, magyar dokumentáció.

## Package-ek
| Mappa | Mit csinál | Részletek |
|---|---|---|
| `packages/maestro-indesign` | InDesign UXP plugin (React 18) | [packages/maestro-indesign/CLAUDE.md](packages/maestro-indesign/CLAUDE.md) |
| `packages/maestro-dashboard` | Next.js Web Dashboard | [packages/maestro-dashboard/CLAUDE.md](packages/maestro-dashboard/CLAUDE.md) |
| `packages/maestro-server` | Appwrite Cloud Functions | [packages/maestro-server/CLAUDE.md](packages/maestro-server/CLAUDE.md) |
| `packages/maestro-proxy` | Express CORS/WS proxy | [packages/maestro-proxy/README.md](packages/maestro-proxy/README.md) |

Cross-project hatás táblázat: [WORKSPACE.md](WORKSPACE.md).

## Tudástár belépési pontok (`_docs/`)
A projekt egyben Obsidian vault is — a gyökér `.obsidian/` a vault root, az `_docs/` a fő tudásmappa. Wikilinkek (`[[Note]]`) működnek a `packages/`-be is.

| Kérdés                            | Hova menj                                                                                                                              |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| "Mit jelent X fogalom?"           | [_docs/Szószedet.md](_docs/Szószedet.md)                                                                                               |
| "Hogy néz ki a rendszer?"         | [_docs/Architektúra.md](_docs/Architektúra.md), [_docs/Hálózat.md](_docs/Hálózat.md), [_docs/Munkafolyamat.md](_docs/Munkafolyamat.md) |
| "X komponens belső működése?"     | [_docs/Komponensek/](_docs/Komponensek/) (atomic notes)                                                                                |
| "Volt már ilyen bug? Workaround?" | [_docs/Hibaelhárítás.md](_docs/Hibaelhárítás.md)                                                                                       |
| "Miért így van ez a döntés?"      | [_docs/Döntések/](_docs/Döntések/) (ADR-ek)                                                                                            |
| "Mit csináltunk YYYY-MM-DD-án?"   | [_docs/Naplók/](_docs/Naplók/)                                                                                                         |
| "Miben kell most dolgozni?"       | [_docs/Feladatok.md](_docs/Feladatok.md)                                                                                               |
| "Mit terveztünk?"                 | [_docs/Tervek.md](_docs/Tervek.md)                                                                                                     |

Tudástár index: [_docs/Főoldal.md](_docs/Főoldal.md).

## Fejlesztési alapszabályok (összefoglaló)
- **Session preflight** (kötelező új session első 5 percében): deploy script-ek + konfig fájlok + célhost megértése. Soha ne feltételezz „auto-deploy on git push"-t ellenőrzés nélkül. Részletek: [_docs/Komponensek/SessionPreflight.md](_docs/Komponensek/SessionPreflight.md)
- **Codex co-reflection** (backend / auth / permission / Realtime témákra): BLOCKER észlelés ELŐTT + implementáció UTÁN + stop-time gate. Részletek: [_docs/Komponensek/SessionPreflight.md](_docs/Komponensek/SessionPreflight.md)
- **Komment nyelv**: magyar
- **Logger**: `log()` / `logError()` / `logWarn()` / `logDebug()`. Soha `console.*`
- **Yarn**, nem npm install (workspace)
- **Tilos**: közvetlen `client.subscribe()` a `maestro-dashboard`-ban — `subscribeRealtime()` a `realtimeBus.js`-ből (ld. [_docs/Komponensek/RealtimeBus.md](_docs/Komponensek/RealtimeBus.md))
- **Tilos**: hardkódolt endpoint URL — minden a `EndpointManager` singletonon át (dual-proxy failover)
- További szabályok: [_docs/Fejlesztési szabályok.md](_docs/Fejlesztési%20szabályok.md)

## Mikor mit írj a tudástárba (AI-szabályok)

1. **Új architektúra-szintű döntés** → új ADR a `_docs/Döntések/`-ben (`NNNN-rovid-cim.md`). Frontmatter `status: Proposed`, megvalósítás után `Accepted`. Index frissítés.
2. **Új domain fogalom** → MINDIG bővítsd a `_docs/Szószedet.md`-t (1 sor). Ha komplex (>50 sor leírás kellene): új atomic note `_docs/Komponensek/<Név>.md`. Linkelj a Szószedetből.
3. **Visszatérő bug + workaround** → új H2 entry a `_docs/Hibaelhárítás.md`-be. Tünet → Ok → Megoldás struktúra.
4. **Aznapi munka jegyzete** → `_docs/Naplók/YYYY-MM-DD.md`. Csak ha a felhasználó kéri vagy ha vége egy hosszabb session-nek.
5. **Package-érintő szerkezeti változás** → érintett `packages/<x>/CLAUDE.md` frissítés. Ha cross-package: `WORKSPACE.md`. Ha új domain fogalom: lásd 2.
6. **Auto-memory** (`~/.claude/projects/.../memory/`) → csak rövid (~1 oldal), aktuális állapot, gyors LLM context, dátum + commit hash. Ha egy memó >2 hete érett: emeld be ADR-ré vagy atomic note-tá a vault-ba, memóriában 3 soros pointer.
7. **Soha**: ne duplikáld memory-t és vault-ot (vault a kanonikus). Ne piszkáld a `.obsidian/`-t. Ne írj `.md`-t a `node_modules/`, `dist/`, `.git/` alá. Ne tegyél magyarul `console.log`-ot — `log()` / `logError()` / stb.
8. **Linkelés**: vault-on belül `[[Note]]`. Kódhivatkozás: `fájl:sor` plain markdown link, NEM wikilink.

## Auto-memory ↔ vault
- **Memory** (`~/.claude/projects/.../memory/`): rövid, aktuális állapot, "what is true now", privát Claude memó.
- **Vault** (`_docs/`): érett, gondozott, narratív, csapat olvashatja.
- Kérdéshez: először memory (gyors), ha hiányzik vagy túl régi → vault.
