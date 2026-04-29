---
tags: [csomag, dashboard]
aliases: [Web Dashboard]
---

# maestro-dashboard

## Cél
Next.js Web Dashboard a szerkesztőségi adminisztrációhoz: tenant/office menedzsment, csoporttagság, workflow designer, beállítások.

## Részletek
[[packages/maestro-dashboard/CLAUDE]] — teljes architektúra.

## Főbb modulok
- **AuthContext** — bejelentkezés, tenant/office membership, szerep — [[Komponensek/AuthContext]]
- **DataContext** — collection-ek (organizations, editorialOffices, groups, invites) — [[Komponensek/DataContext]]
- **RealtimeBus** — egyetlen megosztott Appwrite Realtime subscription — [[Komponensek/RealtimeBus]]
- **WorkflowDesignerPage** — vizuális workflow szerkesztő, doc-szintű Realtime-mal

## Kapcsolódás a többihez
- **Backend (Appwrite)**: `api.maestro.emago.hu` first-party CNAME-en (Safari ITP miatt) — [[Döntések/0005-dashboard-custom-domain]].
- **Realtime**: kötelezően `subscribeRealtime()`, NEM közvetlen `client.subscribe()` (SLOT 0 bug) — [[Döntések/0004-dashboard-realtime-bus]].
- **Cloud Functions**: tenant ACL műveletek, csoport bootstrap, meghívó kezelés.
- **Plugin**: nincs közvetlen kapcsolat — közös Appwrite collection-ek + Realtime push.

## Gotchas (kiemelt)
- TILOS `client.subscribe()` közvetlenül. Ld. [[Hibaelhárítás#Realtime SLOT 0 routing bug Dashboard]].
- Custom domain visszafordítás (`cloud.appwrite.io`) töri a Safari Realtime-ot. Ld. [[Hibaelhárítás#Safari ITP cookie blokkolás (cross-site)]].

## Build / futtatás
- `yarn install`
- Részletek a package CLAUDE.md-ben.
