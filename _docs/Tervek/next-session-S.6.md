---
tags: [terv, session-prompt, S-blokk, uxp, sandbox]
target: S.6
created: 2026-05-15
---

# Új session — S.6 UXP plugin sandbox audit (MEDIUM, 1 session)

## Munkakörnyezet

- **Worktree**: `/Users/imre.sashalmi/Documents/Maestro/Plugin/.claude/worktrees/zealous-euler-00c483`

## Cél

ASVS V14 + UXP sandbox best-practices. Az UXP plugin `manifest.json` jelenlegi `"domains": "all"` és `localFileSystem` permissive setting-jei felülvizsgálata. **Defense-in-depth** — még ha az XSS / CSP enforce nem éles is, az UXP-szintű network whitelist limitálja a kompromittált plugin által elérhető endpointokat.

## Scope (5 al-pont)

### S.6.1 — Network domain whitelist

**Cél**: `manifest.json` `network.domains` `"all"` → explicit lista:
- Railway primary: `*.railway.app` vagy `maestro-proxy-production.up.railway.app`
- Emago.hu fallback: `proxy.maestro.emago.hu`
- Appwrite Cloud: `cloud.appwrite.io`
- Appwrite custom domain: `api.maestro.emago.hu`
- Webhook subdomain (ha plugin hívja): `webhook.maestro.emago.hu`

**Fájl**: `packages/maestro-indesign/manifest.json`

### S.6.2 — localFileSystem szűkítés

**Cél**: UXP `requiredPermissions.localFileSystem`:
- `pluginData` (read+write) — config / state
- `documents` (read+write) — InDesign document I/O
- `userDocuments` — csak read, vagy CF-en keresztül write
- `tempFolder` (write) — temporary export

### S.6.3 — `launchProcess.schemes`

**Cél**: `requiredPermissions.launchProcess.schemes`: csak `https` (NEM `http`, NEM `file`, NEM `custom`).

### S.6.4 — UXP auto-update review

**Cél**: Adobe ExMan-szintű auto-update mechanism — explicit verify hogy a Plugin auto-update CSAK Adobe-tanúsított pipeline-on keresztül jön (nem custom CDN), és code-sign validáció megtörténik.

### S.6.5 — Stop-time Codex review

Új jegyzet: `_docs/Komponensek/UXPSandbox.md` — wrap-up.

## Codex pre-review Q-k

**Q1**: `network.domains` egyszerű cseréje regression-risk? A Plugin runtime jelenleg `EndpointManager` singleton-on át hívja a proxy-t — ha a manifest blokkolja a Railway/Emago `.com`-ot, a plugin nem éri el. **Mitigáció**: dev-env-en NE alkalmazd, csak production manifest-ben.

**Q2**: `localFileSystem.userDocuments` szűkítés — ha a plugin user-import-flow-t használ (CSV / JSON import), az `userDocuments` read kell. Audit a Plugin kódbázisát: `grep -rn "userDocuments\|localFileSystem"`.

**Q3**: UXP auto-update — Adobe-tanúsított-e a Maestro plugin? Ha NEM (private distribution), akkor a CDN-based update flow-t kell audit-elni. Default: Adobe ExMan.

**Q4**: A `manifest.json` változások UXP rebuild-et igényelnek (`yarn build`) + plugin újra-deploy-t Adobe Marketplace-re vagy az `xd-plugins` mappába. **Test-flow**: a fejlesztői env-en a UXP Developer Tool-lal load-oljuk, és ellenőrzünk minden kritikus flow-t (login, publication-load, article-edit).

## STOP feltételek

- S.6.4 UXP auto-update Adobe-tanúsított NEM → S.6 partial close, UXP-vendor-specific audit Phase 2 külön iter.
- Plugin rebuild + UXP Developer Tool-load USER-TASK → flag.

## Becsült időtartam

~30-45 perc (4 al-pont kód-szintű + Codex pipeline + /harden + UXPSandbox.md jegyzet).

## Kapcsolódó

- [[Feladatok#S.6]]
- [[Komponensek/SecurityRiskRegister]] R.S.6.x (új sorok ha kell)
- [[Komponensek/SecurityBaseline]] ASVS V14
- [[Tervek/autonomous-session-loop]]
- [[Tervek/user-task-runbook]] (párhuzamos USER-TASK lista)
