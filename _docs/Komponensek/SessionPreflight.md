---
tags: [komponens, workflow, devops]
aliases: [SessionPreflight, infra-check]
---

# Session preflight (infra-check)

## Cél
Minden új coding-session **első 5 percében** kötelező infra-ellenőrzés, hogy az AI agent (Claude / Codex) ne tévedjen el a deploy-mechanizmuson és ne dolgozzon olyan ágon, amely nem kerül élesbe push-ra. A 2026-05-09 session ~80%-os kapacitásvesztését váltotta ki a Railway = dashboard auto-deploy téves hipotézis ([[Naplók/2026-05-09]]).

## Mit nézz meg (5 perc, minden új session)

### 1. Deploy script-ek
```bash
cat packages/*/package.json | jq .scripts
```
Listázza a workspace-szintű `deploy`, `build`, `dev` parancsokat. Új csomag- vagy script-bevezetés azonnal látszik.

### 2. Deploy-konfig fájlok
```bash
find . -maxdepth 4 \( -name "railway*" -o -name "*.toml" -o -name "Procfile" -o -name "deploy.sh" \) \
  -not -path "*/node_modules/*" -not -path "*/.git/*"
```
Megmutatja: `railway.json` / `railway.toml` (proxy), `deploy.sh` (dashboard cPanel SSH/SCP), `Procfile` (ha lenne).

### 3. Deploy-célhost megértése
```bash
cat packages/maestro-dashboard/deploy.sh   # cPanel SSH cél
cat packages/maestro-proxy/railway.json    # Railway service
```
**Soha** ne feltételezz „auto-deploy on git push"-t ellenőrzés nélkül.

## Railway MCP setup (D.1.1)

A 2026-05-09 incident mintáját megelőzendően a `maestro-proxy` változtatások MCP-vezérelt deploy + log monitoring-jához:

```bash
# 1) Telepítés (egyszer)
claude mcp add Railway npx @railway/mcp-server

# 2) Auth — a Railway CLI 4.30.5+ tokent használ; ha még nincs:
railway login

# 3) Új session elején (proxy-érintő munkára):
railway link --project successful-mindfulness --service gallant-balance
```

**MCP tools** (Claude session-ből hívható): `deploy`, `service list`, `logs`, `status`, `variables`. **Mikor**: minden új session, ahol proxy-érintő commit várható (CORS, Realtime WS, dual-proxy failover beállítás). **Miért**: a proxy jövőbeli változtatásait és a CF deploy-mintával analóg automatizálással kezelhetjük (Claude MCP-n át deploy + log-ot ellenőrzök, NEM a user manual CLI-ből).

**Deferred (D.1.2)**: Dashboard `deploy.sh` GitHub Actions auto-deploy webhook (push-on-main → SSH → cPanel). SSH-key biztonsági szempont, külön session.

## Aktuális deploy-modell (2026-05-09)

| Csomag | Cél | Trigger | Auto |
|---|---|---|---|
| `maestro-proxy` | Railway (`gallant-balance` service, project `successful-mindfulness`) | `git push` `main`-re | igen |
| `maestro-dashboard` | cPanel (`maestro.emago.hu`) | `./deploy.sh` (SSH/SCP) | **NEM**, manuális |
| `maestro-server` (CF) | Appwrite Cloud | Appwrite MCP `functions_create_deployment` | igen, MCP-n át |
| `maestro-indesign` | UXP `.ccx` build | `yarn package` lokálisan | nem |

**Implikáció**: ha frontend-fixet pusholok, a dashboard NEM frissül élesben, amíg a user (vagy GitHub Actions, ha D.1.2 megvalósul) nem futtatja a `deploy.sh`-t. CF-fixhez Appwrite MCP-deploy kell.

## Codex stop-time gate (D.0 alapelv)

A backend / auth / permission / Realtime témákra **kötelező** Codex co-reflection (`codex:codex-rescue` subagent):

1. **BLOCKER észlelés** → Codex review az implementáció ELŐTT (mi a helyes architektúra?)
2. **Implementáció** → Codex review a kódon (van-e edge case / regresszió?)
3. **Stop-time gate** → Codex stop-time review (visszamaradó issue?)

Mindhárom körre rövid (8–15 mondatos) válasz; NEM mély fix-implementáció subagent-ből. A 2026-05-09 session 11 stop-time iterációja **mindegyik alkalommal valós kockázatot** tárt fel (TOCTOU race, customMessage drift, stale session conflict, list pagination regresszió, runtime user-deletion path, register session order, 409 detection).

**Kivétel**: trivial UX-tweak vagy single-line bugfix elé NEM kell Codex.

## Kapcsolódó
- ADR: [[Döntések/0001-dual-proxy-failover]] (proxy infrastruktúra)
- Napló: [[Naplók/2026-05-09]] (incident: deploy-mechanizmus félreértés)
- MOC: [[Munkafolyamat]] (#Session preflight szekció)
- Feladat: [[Feladatok#D.1 DevOps / MCP setup]] — D.1.1 Railway MCP, D.1.2 GitHub Actions auto-deploy
