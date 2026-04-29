---
tags: [csomag, server, cloud-functions]
aliases: [Server, Cloud Functions]
---

# maestro-server

## Cél
Appwrite Cloud Functions backend: minden szerver-oldali művelet (tenant bootstrap, ACL kezelés, meghívó-elfogadás, csoporttagság-mutáció).

## Részletek
[[packages/maestro-server/CLAUDE]] — teljes architektúra.

## Főbb action-ök
- **bootstrap_organization** — új org létrehozásakor 7 default group + groupMembership seeding — [[Döntések/0002-fazis2-dynamic-groups]]
- **invite-to-organization** — meghívó küldése, per-tenant Team létrehozása + doc-szintű ACL — [[Döntések/0003-tenant-team-acl]]
- **add_group_member / remove_group_member** — csoporttagság mutáció
- **backfill_tenant_acl** — legacy adatok ACL utólagos kitöltése

## Kapcsolódás a többihez
- **Plugin (InDesign)**: csak action-trigger.
- **Dashboard**: action-trigger UI-ról (settings → groups → meghívó / tag mutáció).
- **Adatbázis**: Appwrite Database collection-ök (organizations, editorialOffices, groups, groupMemberships, invites, stb.) — Tenant Team ACL [[Döntések/0003-tenant-team-acl]].

## Build / futtatás
- A funkciók `appwrite.json`-ban deklarálva, deploy az `appwrite functions deploy` paranccsal.
- Részletek a package CLAUDE.md-ben.
