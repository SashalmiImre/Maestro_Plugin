---
description: Iterativ hardening pipeline — simplify + codex review + adversarial + Claude review loop, amig CLEAN
argument-hint: '<fajl|modul|scope>'
---

# Harden — Iterativ hardening pipeline

Ciklus: **simplify → 3-way parallel review (codex + adversarial + Claude-subagent) → fix → ujra review**, amig mind a harom review CLEAN vagy a maradek findings explicit out-of-scope.

## Scope

Input `$ARGUMENTS` — fajl(ok), modul ut, vagy git scope (working-tree / branch).
Ha ures: kerdezz ra a scope-ra MIELOTT barmit olvasnal.

## Elofeltetelek

Egyszer, az elejen:

```bash
CODEX_SCRIPT=$(find ~/.claude/plugins/cache -path "*/codex/scripts/codex-companion.mjs" -type f 2>/dev/null | sort -V | tail -1)
[ -n "$CODEX_SCRIPT" ] && [ -f "$CODEX_SCRIPT" ] || { echo "Codex plugin hianyzik — telepitsd: /plugin install codex@openai-codex"; exit 1; }
```

Jegyezd meg a `$CODEX_SCRIPT` erteket a session alatt.

## Pipeline

### Iteration 0 — Simplify + Maestro audit

1. **Simplify pass** — hivd meg a `simplify` skillt a scope-ra. Javitsd a findings-eket (minimal diff).
2. **Maestro audit** — a lenti checklist szerint, `file:line` pontosan. Fix azonnal.

### Iteration 1..N (max 4) — 3-way review loop

Minden iteracio:

**a. Parallel 3-way review** — ket Bash call + egy Agent call EGY message-ben:

```bash
# 1. Codex review
node "$CODEX_SCRIPT" review --wait --scope working-tree
# 2. Codex adversarial-review
node "$CODEX_SCRIPT" adversarial-review --wait --scope working-tree
```

```typescript
// 3. Claude review — Maestro-specifikus szempontok (amit a Codex nem tud)
Agent({
  subagent_type: "general-purpose",
  description: "Claude review for hardening",
  prompt: `Review the current working-tree diff (git diff HEAD) for Maestro Plugin-specific issues a generic reviewer would miss.
Focus:
- CLAUDE.md compliance: magyar WHY-kommentek, nincs BC shim, nincs mock DB, import sorrend (vendor → context → config → utils → components).
- Memory-based konvenciok: timeout chain (10s/8s/5s×3+1.5→3→6s backoff), _subscribedChannels Set, groupSlugs megorzes Realtime-on, tenant ACL (Fazis 2 — team:\${orgId}), dual-proxy failover semantika, canUserMoveArticle (groupSlugs VAGY labels), CF auth H-1 pattern.
- Architektura fit: context sync, recovery chain, kilometermasszázs stale closure, unmount race, scope-valtas.
- Hungarian-edge case-ek: amit egy generic reviewer nem lat (pl. ExtendScript escape, Appwrite Realtime csatorna-nev drift).
Report findings ONLY (no fixes). Format: severity (high/med/low) / file:line / issue. Under 400 words. Ha nincs finding: "STATUS: CLEAN".`
})
```

Timeout: 10 perc / Bash call. Az Agent ~1-2 perc.

**b. Parse** mind a harom kimenetet:
- `STATUS: CLEAN` → adott review tiszta
- Findings: severity / file:line / issue

**c. Exit feltetel**: ha **mind a harom** review CLEAN → ugras a Report-hoz.

**d. Fix** a findings-ra, deduplikaltan:
- Egy fix ami tobb review-ban is szerepel — egyszer javitsd
- Out-of-scope (pl. adat-migracio, kulon feladat) → jegyezd le, ne javitsd
- Konfliktus eseten (codex "legyen validalas" vs claude "nincs ra szukseg framework trust miatt") → a CLAUDE.md / memory az autoritativ

**e. Iteracio limit**: ha 4. iteracio utan sincs CLEAN, listazd az ismetlodo findings-eket mint Visszatartva, es lepj kilepesre.

## Maestro audit checklist (Iteration 0)

Csak olyan ellenorzesek amiket a codex review memoria nelkul nem tud — a tobbit a codex lefedi.

- **Timeout chain konzisztencia**: fetch 10s (pub/art/val) / 8s (layout/deadline); health 5s × 3 + 1.5→3→6s backoff; lock 10s
- **Realtime socket**: `_subscribedChannels` Set tartja a csatornakat, `reconnect()` toroli
- **`groupSlugs` megorzes**: `account` Realtime handler `{...payload, groupSlugs: prev?.groupSlugs || []}`
- **Tenant ACL (Fazis 2)**: `groups`/`groupMemberships`/`organizationInvites` create/update-en `read("team:${orgId}")` + `rowSecurity: true`
- **Dual-proxy failover**: aktiv → masik → offline cascade; fallback-rol auto visszakapcsolas minden recovery-nel
- **Jogosultsag**: `canUserMoveArticle` a `user.groupSlugs` VAGY `user.labels`-t figyeli (egyenrangu)
- **CF auth pattern**: auth check a null-check ELOTT (H-1); 4xx valasz nem leak payload-ot
- **`enrichUserWithGroups` trigger**: login, recovery, `groupMembershipChanged`, `scopeChanged`
- **Kod-higiena (CLAUDE.md)**: magyar WHY-kommentek, dead code / unused import torolve, nincs BC shim, nincs mock DB integrationteszthez, import sorrend (vendor → context/hooks → config → utils → components)

## Fix szabalyok

- Minimal diff — ne refaktoralj ami nincs torve
- Nincs backward-compat shim, nincs feature-add, nincs placeholder / TODO kod
- Nincs `--no-verify`, nincs mock DB integrationteszthez
- Parallel tool call fuggetlen muveletekre
- Belso koddal NEM elofordulo edge case-re NE adj guard-ot
- Root cause fix, ne symptom hiding

## Tilos

- Review-re fokuszalni → `/roast` dolga
- Csak simplify → `simplify` skill dolga (de a pipeline elejen itt is fut)
- Feature hozzaadas / uj absztrakcio
- Kihagyni egy iteraciot "mert nem fontos"

## Report (vegul)

### Scope
- Fajl(ok) / modul / CLAUDE.md / memory-k

### Iteraciok
- **Iter 0** (simplify + Maestro audit): X findings javitva — legfontosabb 3-5 bullet
- **Iter 1** (3-way review): codex N / adversarial M / Claude K findings javitva — legfontosabb 3-5 bullet
- **Iter 2** (3-way review): ...
- ...

### Vegso review status
- `/codex:review`: ✅ CLEAN / ❌ N findings
- `/codex:adversarial-review`: ✅ CLEAN / ❌ N findings
- Claude review (subagent): ✅ CLEAN / ❌ N findings

### Visszatartva
- Amit NEM javitottam + miert (out-of-scope / data migration / kulon feladat)
- Ha 4. iter utan sincs CLEAN: ismetlodo findings listaja

---

Harden-eld: $ARGUMENTS
