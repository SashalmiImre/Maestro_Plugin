---
tags: [komponens, uxp, plugin, sandbox, security]
related:
  - "[[Komponensek/SecurityBaseline]]"
  - "[[Komponensek/SecurityRiskRegister]]"
  - "[[Feladatok]]"
---

# UXPSandbox — Plugin manifest hardening + UXP-szintű sandbox

## Kontextus

Az InDesign UXP plugin (`packages/maestro-indesign`) `manifest.json` deklarálja a runtime-permissziókat:
- **localFileSystem** — fájlrendszer hozzáférés (read/write)
- **network.domains** — engedélyezett HTTP/WS host-pattern-ek
- **launchProcess** — external process (`shell.openExternal`) launch

A defense-in-depth elv szerint a UXP-rétegen szűrjük a runtime-permissziókat, hogy egy esetleges XSS/code-injection-bug Plugin-belül NE érhesse el a teljes filesystem-et / minden domain-t.

## S.6 audit (2026-05-15)

### S.6.1 — Network domain whitelist

**Előtte**: `"domains": "all"` — minden HTTP/WS host engedélyezett (Adobe-default).

**Utána**:
```json
"network": {
    "domains": [
        "https://gallant-balance-production-b513.up.railway.app",
        "wss://gallant-balance-production-b513.up.railway.app",
        "https://emago.hu",
        "wss://emago.hu",
        "https://*.emago.hu",
        "wss://*.emago.hu"
    ]
}
```

**Indokol**:
- **Railway primary**: `gallant-balance-production-b513.up.railway.app` — proxy elsődleges (ADR 0001), specific subdomain (NEM `*.up.railway.app` wildcard — Railway-redeploy után manifest-update szükséges, defense-in-depth)
- **emago.hu fallback**: Apache/Passenger proxy + dashboard (`maestro.emago.hu`) + Appwrite custom domain (`api.maestro.emago.hu`) + Resend webhook (`webhook.maestro.emago.hu`) — wildcard `*.emago.hu` fed minden subdomain-t
- **`wss://` explicit** Codex MINOR fix: az Adobe UXP docs szerint a `network.domains` scheme-qualified URL pattern, NEM bare-host. A Realtime WebSocket (`wss://`) NEM engedélyezett bare-host whitelist-tel.

### S.6.2 — localFileSystem szűkítés

**Előtte**: `"localFileSystem": "fullAccess"` — silent broad fs-access user-prompt nélkül.

**Utána**: `"localFileSystem": "request"` — picker-mediated access (user dialog minden new-folder/file-pick).

**Indokol**:
- A Plugin file-access valódi minta: `getFileForOpening({...})` + `getFolder()` user-mediated dialog amúgy is (Publication.jsx:161-231)
- `getEntryWithUrl(fileUrl)` (thumbnailUploader.js:56) — InDesign auto-generated path-ra megy, `request` szinten valószínű prompt felugorhat
- **Defense-in-depth**: XSS Plugin-belül silent `getFileSystemProvider()` access blokkolva

### S.6.3 — `launchProcess.schemes`

**Előtte + utána**: `"schemes": ["https"]` — már OK, NEM-changed.

**Indokol**: `https`-only — `http://` / `file://` / `custom://` blokkolva. `shell.openExternal` csak HTTPS URL-re mehet.

### S.6.4 — UXP auto-update

**Status**: NEM-changed (dokumentum-szintű).

**Indokol**: a Maestro NEM-Adobe Marketplace plugin, hanem manual distribution (`.ccx` fájl). UXP auto-update Adobe ExMan-szintű flow CSAK Marketplace-distributed plugin-eken. **A jelenlegi setup-nál ez out-of-scope** — a frissítések manual deploy-on át mennek (`yarn build` + ExMan package + Slack/share).

**Future-work**: ha a Maestro Marketplace-en bemutatkozik, az auto-update flow audit-elendő (signature verify, version-rollback-policy).

### S.6.5 — Stop-time Codex review

`a77cca7c88b3fce84` MINOR — `network.domains` scheme-qualify javítás alkalmazva.

## Hidden risks (Codex adversarial)

### A1 — Defense-in-depth oversold?

A `network.domains` whitelist a **fetch/WebSocket** API-szinten szűr. Plugin-en belüli XSS:
- ✅ `fetch(...)` whitelisten-kívüli host-ra → UXP-block
- ❌ `require("uxp").shell.openExternal(...)` `https://`-szel — bármely URL-re engedélyezett (a domain-list NEM-applies)
- ❌ `require("uxp").storage.localFileSystem.getEntryWithUrl(...)` — fs-access (NEM-network)

**Acceptable defense-in-depth**, NEM-teljes-isolation. A `localFileSystem: "request"` szűkítés komplementer védelmet ad.

### A2 — `localFileSystem: "request"` UX

Minden first-access-nél user-prompt. A meglévő `getFileForOpening`/`getFolder` dialog mellett potenciálisan plusz prompt. **HYPOTHESIS** (Codex MINOR): a UXP runtime tényleges viselkedése **runtime-smoke-teszttel** verifikálandó (UXP Developer Tool + reload + flow-teszt).

### A3 — Realtime WebSocket (`wss://`)

Codex MINOR fix: a bare-host (`emago.hu`) NEM-engedélyez `wss://`-t. Scheme-qualified entries (`https://emago.hu` + `wss://emago.hu`) együtt kell. **Applied**.

## Smoke-teszt checklist (USER-TASK, deploy után)

1. UXP Developer Tool > Load Plugin > `packages/maestro-indesign/dist/`
2. Login flow → Railway primary endpoint hívás → success
3. Realtime subscribe → WebSocket connect → success (a `wss://` engedélyezett)
4. Publication file-pick → user dialog felugrik (`getFileForOpening`)
5. Thumbnail upload → InDesign auto-path → `getEntryWithUrl` esetleg új prompt (`request`-level)
6. `shell.openExternal('https://maestro.emago.hu/...')` → external browser nyit (engedélyezett scheme)
7. **Negative test**: `fetch('https://evil.example.com/')` Plugin-belül DevTools-on → UXP-block (NEM-fetch)

## Kapcsolódó

- [[Komponensek/SecurityRiskRegister]] R.S.6.x (új sorok ha kell)
- [[Komponensek/SecurityBaseline]] ASVS V14
- [[Feladatok#S.6]]
- [[Döntések/0001-dual-proxy-failover]] (Railway primary + emago.hu fallback domain-pattern)
- [[Tervek/user-task-runbook]] UXP Developer Tool smoke-teszt
