---
tags: [terv, session-prompt, S-blokk, xss]
target: S.4
created: 2026-05-15
---

# Új session — S.4 XSS audit (R.S.4.2 + általános)

## Munkakörnyezet

- **Worktree**: `/Users/imre.sashalmi/Documents/Maestro/Plugin/.claude/worktrees/zealous-euler-00c483`
- **Branch**: `claude/zealous-euler-00c483`

## Cél

**R.S.4.2 close**: ImportDialog file size + MIME validation (HIGH). Plus általános XSS-audit a Plugin + Dashboard frontend-en (`dangerouslySetInnerHTML`, `innerHTML`, `eval`, `Function()`, unsafe-output-mintán).

## Scope

### 1. ImportDialog (R.S.4.2 — HIGH, kódoldal close)

Plugin (vagy Dashboard) ImportDialog modal:
- File size cap (~50 MB ajánlott)
- MIME type whitelist (pl. CSV, JSON, XLSX — felhasználói-feltöltés)
- File-content-validation (a MIME header NEM mindig megbízható — pl. JSON `.csv` extension-on)

### 2. Általános XSS-audit

`grep -rn` mintán:
- `dangerouslySetInnerHTML` (React unsafe-output)
- `innerHTML` (DOM-direct)
- `outerHTML`
- `document.write`
- `eval(` / `new Function(`
- `setTimeout(string-arg)` / `setInterval(string-arg)`
- `target="_blank"` `rel="noopener"` nélkül (reverse-tabnabbing)

Plugin + dashboard + shared csomagokban.

### 3. URL-input sanitization

Bárhol user-input megy `<a href=`-be vagy `window.location.href=` — `javascript:` scheme prevent.

## Codex pre-review Q-k

**Q1**: ImportDialog létezik-e jelenleg, vagy halasztott feature? Verify a frontend-on.
**Q2**: File size + MIME cap számértéke (50 MB, 10 MB, vagy más)?
**Q3**: Az XSS-audit grep-szerű — manuális verify vagy automated regex-tool (pl. ESLint security plugin)?

## Becsült időtartam

~45-90 perc (audit + tényleges fix-ek a finding-ok szerint).

## Kapcsolódó

- [[Feladatok#S.4]]
- [[Komponensek/SecurityRiskRegister]] R.S.4.2
- [[Tervek/autonomous-session-loop]]
- [[Naplók/2026-05-15]] 6 iteráció lezárás
