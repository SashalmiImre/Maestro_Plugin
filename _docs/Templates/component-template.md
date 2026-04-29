---
tags: [komponens]
aliases: []
---

# <KomponensNév>

## Cél
Egy mondat. Mit csinál ez? Miért létezik?

## Helye
- **Forrás**: `packages/.../path/file.js[:42]`
- **Tesztek**: ha vannak

## Felület (API)
| Név | Típus | Mit csinál |
|---|---|---|
| `methodA(x)` | (ha class) | ... |

vagy code blokkban:

```js
export function name() { ... }
```

## Kapcsolatok
- **Felhasználói** (ki hívja): [[X]], [[Y]]
- **Függőségei** (mit hív): [[Z]]
- **Eseményei**: emit `xxxChanged`, listen `yyyRequested`

## Gotchas / döntések
- ...
- Részletek: [[Döntések/...]]

## Kapcsolódó
- [[Komponensek/...]]
- [[Hibaelhárítás#...]]
- Memory: `<memo>.md`
