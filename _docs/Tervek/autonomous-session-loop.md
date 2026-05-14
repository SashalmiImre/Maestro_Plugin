---
tags: [terv, automation, session-loop, codex]
status: Active
created: 2026-05-15
related:
  - "[[Komponensek/SessionPreflight]]"
  - "[[Feladatok]]"
---

# Autonomous Session Loop — Meta-routine prompt

> **Cél**: Claude Code-ban a Feladatok.md S blokk al-pontjait progresszíven, autonóm sessionökben lefuttatni. Minden session → új feladat → Codex-pipeline → Harden → commit + push → következő session prompt generálás.

## Munka-séma

```
Új session ─→ Indító prompt (DINAMIKUS, Feladatok.md state-ből)
            ─→ Olvasás (vault + memory)
            ─→ Implementáció (Codex pre + impl + stop-time + verifying)
            ─→ /harden (baseline + adversarial + simplify + verifying)
            ─→ Doku-frissítés (Feladatok + RiskRegister + Komponensek + Napló)
            ─→ Commit + push (2-commit minta: kód + doku)
            ─→ Következő session prompt generálás (.md vault-ba)
            ─→ Session zárás
            
[ismétlés cron-on / kézi /loop / kézi copy-paste]
```

## Trigger-opciók

### A) `/schedule` cron — fully autonóm, külön session-ök

```bash
# Példa cadence: minden hétköznap 9:00 (helyi idő)
/schedule "0 9 * * 1-5" autonomous-loop-tick
```

**Routine prompt** (a `/schedule` skill kéri a setup-on):

```text
Te a Maestro Plugin S blokk autonomous session-loopjának egy iterációja vagy.

LÉPÉSEK:
1. cd /Users/imre.sashalmi/Documents/Maestro/Plugin/.claude/worktrees/zealous-euler-00c483
2. git status (clean kell legyen, kivéve _docs/Komponensek/LoggingMonitoring.md placeholder)
3. git pull origin claude/zealous-euler-00c483 (defenzív, helyi commit-okkal NE törj)
4. Olvasd be:
   - _docs/Feladatok.md (S szekció — keresd a következő `[ ]` open al-pontot priorítás-rendben)
   - _docs/Tervek/next-session-S.X.Y.md (ha létezik, az a következő session konkrét prompt-ja)
   - ~/.claude/projects/-Users-imre-sashalmi-Documents-Maestro-Plugin/memory/MEMORY.md (gyors LLM context)
5. Ha létezik `_docs/Tervek/next-session-*.md` → annak instrukciói szerint dolgozz.
   Ha NEM → válassz a Feladatok.md S szekcióból a következő HIGH prio al-pontot (Open + nem deploy-blocked + nem user-task).
6. Indítsd a feladatot:
   - Codex pre-review (Agent codex:codex-rescue, effort=low)
   - Implementáció a pre-review GO-ja után
   - Codex stop-time review az implementáción
   - Fix-ek (ha kell)
   - Codex verifying review
   - /harden pass (baseline + adversarial + simplify + verifying)
7. Doku-frissítés:
   - _docs/Feladatok.md (al-pont státusz)
   - _docs/Komponensek/<X>.md (érintett komponens)
   - _docs/Komponensek/SecurityRiskRegister.md (R.S.X.Y status)
   - _docs/Naplók/YYYY-MM-DD.md (új daily note, ha még nincs)
8. Commit + push 2-commit mintán (kód + doku, `git -C <WT>` minden hívásra mert a Bash cd nem perszisztens).
9. Generáld a következő session promptját:
   - Keresd a Feladatok.md S szekció KÖVETKEZŐ open al-pontját
   - Írj egy self-contained promptot _docs/Tervek/next-session-S.X.Y.md néven
   - A prompt struktúrája: cél + scope + context + olvasandók + Codex-Q-k + indító lépések
10. Session zárás: 4-5 mondatos jelentés (mit változtattál + commit-SHA-k + következő iteráció prompt-fájlja).

KÖTELEZŐ SZABÁLYOK:
- Worktree mindig: claude/zealous-euler-00c483 (abszolút path)
- Codex pipeline minden kód-érintő al-ponton (pre → impl → stop-time → verifying)
- /harden minden kód-iteráció végén
- Magyar kommentek (kivétel: dashboardon a console.* policy-elfogadott — packages/maestro-dashboard/CLAUDE.md line 39)
- Bash heredoc fájl-íráshoz (Edit/Write cache-bug az incident-listán)
- git -c core.quotepath=false a magyar ékezetes path-ekhez
- subscribeRealtime() használata (NEM közvetlen client.subscribe())
- yarn (NEM npm install)

PUSHBACK SZABÁLY:
- Ha a feladat destruktív cross-tenant / irreverzibilis / production-érintő:
  3-4 mondatos pushback + kockázat-lista, MIELŐTT végrehajtanád.
- Ha a feladat USER-TASK (pl. S.7.5 adversarial 2-tab, S.7.7b deploy):
  Skippeld és a "Next session prompt"-ba írd át user-flagged-ként.

STOP feltételek:
- Branch konfliktus push-on → STOP, jelezd a user-nek
- Codex pipeline 2 iteráció után még BLOCKER → STOP, jelezd
- Feladatok.md S szekció minden HIGH prio Open elfogyott → STOP, jelezd
- Bármely git/Appwrite/Codex hiba → STOP
```

### B) `/loop` self-pace — egy session-en belül, dinamikus pacing

```bash
# Indítsd manuálisan, és a model maga állít time-out-ot iterációk között
/loop "Folytasd a Feladatok.md S szekció autonomous loopot (Tervek/autonomous-session-loop.md szerint)."
```

**Hátrány**: minden iteráció ugyanabban a session-context-ben fut → 200k token context window elfogyhat. ~2-3 iteráció / session realisztikus.

**Előny**: gyorsabb, nincs cron-késés, a context-egyezés jó az iterációk között.

### C) Manuális copy-paste — user-controlled cadence

A felhasználó minden session zárás után megnyit egy új sessiont és bemásolja a vault-ban legutóbb generált `_docs/Tervek/next-session-*.md` tartalmát első prompt-ként.

**Előny**: full user-controlled, megszakítható bármikor.
**Hátrány**: a "loop" manuális.

## A "Next session prompt" formátuma

Minden session zárásakor a vault-ba mentett konkrét következő-session-prompt (`_docs/Tervek/next-session-S.X.Y.md`) struktúrája:

```markdown
---
tags: [terv, session-prompt, S-blokk]
target: S.X.Y
created: YYYY-MM-DD
---

# Új session — S.X.Y <al-pont neve>

## Munkakörnyezet
- Worktree (abszolút): `/Users/imre.sashalmi/.../zealous-euler-00c483`
- Branch: `claude/zealous-euler-00c483`
- PR: <link>

## Cél
1 mondat: mit kell elérni.

## Scope
- File-ok: <lista>
- Új vs meglévő: <X új fájl + Y módosítás>
- Auth-modell: <pl. requireOrgOwner>
- Új env varok: <ha vannak>

## Context (olvasandó)
- _docs/Naplók/YYYY-MM-DD.md (legutóbbi session zárás)
- _docs/Feladatok.md S.X.Y bejegyzés
- _docs/Komponensek/<érintett>.md
- _docs/Döntések/<érintett ADR>.md (ha van)
- Memory: MEMORY.md releváns rész

## Codex pre-review Q-k
- Q1: <specifikus design-Q>
- Q2: ...
- Q3: ...

## Indító lépések
1. `cd <WT>` (abszolút), `git status`, `git log --oneline -5`
2. Read minimum: <fájl-lista>
3. Codex pre-review (effort=low, self-contained briefing)
4. Implementáció a pre-review GO-ja után
5. Codex stop-time → verifying → /harden → doku → commit + push → következő prompt
```

## Korlátozások (transparent)

1. **Production deploy + Appwrite Console verify** USER-TASK marad — autonóm loop NEM tudja megérinteni.
2. **Adversarial 2-tab teszt** (S.7.5) USER-TASK — fejlesztői env-en.
3. **DESIGN-Q user-decision** (a Codex pre-review-ban felmerülő architectural elágazások) STOP feltétel.
4. **Branch konfliktus / Appwrite outage** STOP.
5. **Context window**: `/loop` self-pace mode ~2-3 iteráció után context-fogyás. `/schedule` cron friss sessionökkel ezt megoldja.

## Karbantartás

A meta-routine-prompt **változhat** a projekt fejlődésével. Frissítendő:
- Új worktree / branch név esetén
- Új CLAUDE.md szabály esetén
- Új STOP feltétel esetén (incident-listából)

Memory pointer is jó lenne — egy rövid memo-fájl a `~/.claude/projects/.../memory/`-ben `autonomous-session-loop.md` néven, ami a vault-pointer.

## Kapcsolódó

- [[Komponensek/SessionPreflight]] — minden session első 5 perce
- [[Feladatok]] — S blokk al-pontok
- [[Naplók/2026-05-15]] — meta-routine-prompt létrehozásának napja
