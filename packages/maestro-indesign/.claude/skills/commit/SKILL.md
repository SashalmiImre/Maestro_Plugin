---
name: commit
description: Staged változások commitolása és pusholása. Automatikusan generál commit üzenetet a diff alapján, majd pushol.
model: haiku
allowed-tools: Bash(git:*)
---

# Commit & Push

## Feladat

Commitold és pushöld a módosításokat. Az args-ban megadott üzenetet használd commit message-ként — ha nincs megadva, generálj egyet a diff alapján.

**Args (opcionális):** `$ARGS` — ha meg van adva, ez lesz a commit message.

## Lépések

### 1. Állapot felmérése

Futtasd párhuzamosan:
- `git status --short`
- `git diff --stat HEAD`
- `git log --oneline -5`

### 2. Commit message meghatározása

**Ha `$ARGS` nem üres:** Használd az `$ARGS` tartalmát commit message-ként.

**Ha `$ARGS` üres:** Generálj üzenetet:
- Futtasd: `git diff HEAD` és `git diff --cached`
- Elemezd a változásokat: mi változott, miért
- Stílus: rövid, tömör, **magyarul** — a projekt commit stílusa alapján (pl. `Ghost socket védelem + RecoveryManager _isCancelled flag`)
- Typical formátumok: `feature: rövid leírás`, `fix: rövid leírás`, `docs: rövid leírás`, vagy csak egyszerű leíró mondat típus prefix nélkül

### 3. Staging

Staged-eld az összes módosított tracked fájlt:
```
git add -u
```

Ha vannak untracked fájlok a `git status`-ban, amelyek logikusan a változáshoz tartoznak (nem `.env`, nem `node_modules`, nem `dist/`), add hozzá őket is.

### 4. Commit

```
git commit -m "$(cat <<'EOF'
<commit message itt>

Co-Authored-By: Claude Haiku 4.5 <noreply@anthropic.com>
EOF
)"
```

### 5. Push

Kérdezd le az aktuális branch-et: `git branch --show-current`

Majd pushölj:
```
git push origin <branch>
```

### 6. Eredmény

Jelezd röviden:
- Commit hash (első 7 karakter)
- Commit message
- Push státusz

**Hiba esetén** (pl. pre-commit hook fail, push reject): Jelezd a konkrét hibát, ne próbálkozz újra automatikusan.
