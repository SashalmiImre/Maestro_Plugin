---
tags: [terv, session-prompt, S-blokk, auth]
target: S.12
created: 2026-05-15
---

# Új session — S.12 Auth/Session/Access (R.S.12.4 close + R.S.12.1+R.S.12.2 user-task flag)

## Munkakörnyezet

- **Worktree**: `/Users/imre.sashalmi/Documents/Maestro/Plugin/.claude/worktrees/zealous-euler-00c483`

## Cél

3 R-id S.12 alatt — eltérő természetűek:

| R-id | Cél | Természet |
|---|---|---|
| R.S.12.1 | Password policy audit (Appwrite Console settings) | **USER-TASK** — Console-on policy-beállítás |
| R.S.12.2 | MFA admin-szerepre nem kötelező | **USER-TASK** — Console-on MFA-policy + admin label-bind |
| R.S.12.4 | `localStorage.maestro.activeEditorialOfficeId` logout cleanup gap | **CODE-ONLY** — frontend |

A code-only al-pont: **S.12.4** — `AuthContext.logout()` mintán a localStorage tisztítása.

## Scope (S.12.4)

A `localStorage.maestro.activeEditorialOfficeId` (plus esetleg más `maestro.*` kulcsok) **logout után megmaradnak** a böngészőben. Egy következő user a SHARED böngészőn (kávézó / public PC) a logout-olt user `activeEditorialOfficeId`-jét örökli → potenciális tenant-kontamináció.

Fix:
1. `AuthContext.logout()` flow VÉGÉN `localStorage.removeItem('maestro.activeEditorialOfficeId')` + minden `maestro.*` prefixű kulcs törlése (general `localStorage` iter).
2. **Defense-in-depth**: a login-flow elején is `localStorage.removeItem(...)` (preventing carryover from a different user-session on the same browser).

### Plugin (UXP environment)

UXP-n nincs `localStorage` ugyanúgy — a Plugin Appwrite SDK persistence-e különböző. **Verify**: a Plugin UserContext logout-flow + persistence-tisztítás. Ha NINCS, S.12.4-en Plugin-szintű al-pont halasztott.

## Codex pre-review Q-k

**Q1**: Csak `maestro.activeEditorialOfficeId` vagy minden `maestro.*` prefix?
Default: **minden `maestro.*`** — defense-in-depth. Lehet, hogy más kulcsok is léteznek (theme-preference, last-opened-publication stb.).

**Q2**: `removeItem` vs `clear()`?
Default: **`removeItem` per-key** — nem akarunk más app-state-et törölni (NEM-maestro kulcsok pl. extension-szintű).

**Q3**: Login-flow defense-in-depth?
Default: **GO** — egy különböző user-credentials-szel bejelentkező user NE örökölje a previous user maestro-state-et.

## STOP feltételek

- S.12.1 + S.12.2 USER-TASK → SKIP + flag a Feladatok.md-ben.
- Plugin localStorage equivalence verify-hez Plugin UserContext olvasás — ha komplexitás → halasztott.

## Becsült időtartam

~30 perc (frontend AuthContext logout-flow patch + dashboard verify; plugin halasztott külön al-ponttal).

## Kapcsolódó

- [[Feladatok#S.12]]
- [[Komponensek/SecurityRiskRegister]] R.S.12.1 + R.S.12.2 + R.S.12.4
- [[Tervek/autonomous-session-loop]]
