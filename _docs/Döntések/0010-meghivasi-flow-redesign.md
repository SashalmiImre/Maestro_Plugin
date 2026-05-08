---
tags: [adr]
status: Accepted
date: 2026-05-08
---

# 0010 — Meghívási flow redesign (Discord-szerű modal + Resend e-mail kiküldés)

## Kontextus

A `feature/maestro-redesign` ágon a meghívási flow ([invites.js:167](../../packages/maestro-server/functions/invite-to-organization/src/actions/invites.js#L167)) tartalmaz egy `// FÁZIS 6: itt jön majd a messaging.createEmail() hívás` kommentet. A jelenlegi flow:

1. Admin a `UsersTab.jsx` inline űrlapján e-mail+role+üzenet → `create_invite` CF action.
2. CF visszaadja a tokent, frontend épít linket (`${DASHBOARD_URL}/invite?token=...`), vágólapra másolja.
3. Admin **manuálisan** elküldi a linket Slack-en / e-mailben / kézi módon.

**Hiányosságok:**
- Nincs kiküldött e-mail → admin manuális munka, branding nincs, nyomon követés nincs.
- Az inline űrlap minimális: nincs lejárat-választás, nincs multi-invite, nincs csoport-előzetes-hozzárendelés.
- A meghívó token publikus URL-ben él — szivárgás esetén **nincs IP-szintű brute-force védelem** az `accept_invite` endpoint-on.

A user (2026-05-08) Discord-szerű "Server invite link settings" modal-t kért, részletes beállításokkal és e-mail kiküldéssel. Codex és Claude együtt **roast**-olta a kezdeti tervet — ezzel a refaktor három független részfeladatra bontódott.

## Döntés

**Három független munkapakk** (W2, W3, biztonsági réteg), egy felesleges scope-emelést elvetve (W1).

### W2 — Meghívási modal redesign (frontend + invite collection séma-bővítés)

A `UsersTab.jsx` inline form **lecserélődik** egy modal-ra (`InviteModal.jsx`):

| Mező | Jelenlegi | Új |
|---|---|---|
| E-mail | 1 cím (text input) | Multi-invite (chip-input, max **20** cím) |
| Role | `member`/`admin` (select) | Változatlan |
| Üzenet | textarea (max 500) | Változatlan |
| Lejárat | fix 7 nap | **1 / 3 / 7 (default) nap** (radio) |

**Csoport-előjelölés a meghívási modal-on NEM lesz** — a csoportok továbbra is office-scope-ban élnek (ADR 0002 megőrizve), a meghívott user a csatlakozás után az adott szerkesztőség `EditorialOfficeGroupsTab`-jából kapja a csoport-tagságot.

**Invite collection séma-bővítés** (Appwrite Cloud manuálisan vagy `schemas.js` action-ön át):
- `lastDeliveryStatus` (string, 32, nullable) — `pending | sent | bounced | failed | delivered`
- `lastDeliveryError` (string, 512, nullable)
- `sendCount` (integer, default 0) — hányszor küldtük el az e-mailt
- `lastSentAt` (datetime, nullable)
- `expiresAt` *jelenleg már létezik* — most a CF a frontend-ből kapott `expiryDays` paraméterből számolja (1 / 3 / 7), nem fix `INVITE_VALIDITY_DAYS`-ből.

**`createInvite` CF action bővítés**: `expiryDays` paraméter (1 | 3 | 7 — server-side whitelist), valid_role check változatlan.

### W3 — Resend e-mail provider integráció

**Vendor**: [Resend](https://resend.com), EU régió. Ingyenes plan 3000 e-mail/hó. Feladócím: `noreply@maestro.emago.hu`.

**DNS** (verifikálva 2026-05-08, cpanel-ben az `emago.hu` zónán belül a `maestro` subdomain alatt):
- DKIM TXT: `resend._domainkey.maestro` → publickey
- SPF MX: `send.maestro` → `feedback-smtp.eu-west-1.amazonses.com` priority 10
- SPF TXT: `send.maestro` → `v=spf1 include:amazonses.com ~all`
- DMARC TXT: `_dmarc` (vagy `_dmarc.maestro`) → `v=DMARC1; p=none;`

**Új CF action** (`sendEmail.js` az `actions/` mappán belül):
- `send_invite_email` — Resend SDK hívás (`resend.emails.send({...})`), `RESEND_API_KEY` env var.
- Sikeres küldés → `lastDeliveryStatus='sent'`, `sendCount++`, `lastSentAt=now`.
- Hiba → `lastDeliveryStatus='failed'`, `lastDeliveryError=err.message`.

**Async batch a multi-invite-hez** (`invites.js` `createBatchInvites`):
- Frontend egyszerre 1-20 e-mailt küld be → CF `Promise.all` 10-es batch-ben hívja a `send_invite_email`-t (rate limit barát).
- UI azonnal megjeleníti a "küldés folyamatban..." állapotot, Realtime frissül a `lastDeliveryStatus` mezőre.

**Bounce webhook**:
- Új CF function: `resend-webhook` (külön Cloud Function, public endpoint).
- Resend Dashboard → Webhooks → URL: `https://api.maestro.emago.hu/v1/functions/resend-webhook/executions` (+ HMAC verify).
- Esemény: `email.bounced`, `email.delivered` → invite rekord `lastDeliveryStatus` frissítés.

**E-mail template**:
- HTML + plain text fallback (`templates/invite-email.html` + `.txt`).
- Magyar nyelvű, Stitch dashboard design tokenekhez illeszkedő minimalista dark-theme branded HTML.
- Helyettesítendő placeholderek: `{{organizationName}}`, `{{inviterName}}`, `{{role}}`, `{{customMessage}}`, `{{inviteLink}}`, `{{expiresAt}}`.

### Biztonsági réteg — IP-rate-limit (NEM "X rontás")

A korábbi ötlet — *"X rossz próbálkozás után invalidálódik a meghívó"* — **elvetve**, mert:
1. A 32-byte (256-bit) token bruteforce-olhatatlan → nem token-guess fenyegetés ellen véd.
2. **DoS-vektort nyit**: ha a token kiszivárog, támadó szándékosan érvénytelenítheti a meghívót → a meghívottat teljesen kizárja.
3. A "rontás" definíciója (rossz token / rossz e-mail / Appwrite jelszó-hiba?) bizonytalan — Appwrite `account.create()` flow nincs token-össze-kötve.

**Helyette**: új CF function `accept-invite-rate-limit-guard` middleware (vagy direkt az `accept_invite` action-ön):
- Per IP **5 próbálkozás / 15 perc** az `accept_invite` action-ön (Appwrite Function context X-Forwarded-For header).
- 6. próbálkozásnál → **1 órás IP-block** (egy `ipRateLimitBlocks` Appwrite collection-ön, TTL-szerű mező).
- Admin manuálisan újragenerálhatja a meghívót — a rate limit egy konkrét tokenre nem fagyaszt.
- Aggregat counter (rate window egy `ipRateLimitCounters` collection-ön IP+endpoint-key kombóval).

## Alternatívák

### W1 (groups org-scope migráció) — **ELVETVE**

A felhasználó eredeti tervében szerepelt: a `groups` collection scope-ját office → org-szintre mozgatni, a meghívási modal-on org-szintű csoport-választással.

| Opció | Mellette | Ellene |
|---|---|---|
| **A — Teljes refactor (groups → org-scope)** | Egységes mentális modell | ADR 0002 megfordítása; tenant ACL (ADR 0003) sérül; szerkesztőségi autonómia elvész (Sport vs. Politika eltérő szerepkörök); nagy regressziós felület |
| **B — Scope-flag (`scope: 'org' \| 'office'`)** | Kompromisszum, megőrzi az autonómiát | Két paradigmák párhuzamosan; több if-ág CF-ben |
| **C — Status quo: csoportok office-scope-ban maradnak, meghíváskor csak admin/member** ← **VÁLASZTOTT** | Nincs migráció; ADR 0002+0003+0008 érintetlen; minimális kockázat | Csoport-hozzárendelés nem egy lépésben az invitee-nek |

A user (2026-05-08, üzenet) belegondolás után megerősítette: "valóban lehet, hogy szerkesztőség szinten legyenek különböző jogosultságaik" — tehát C opció.

### Provider választás

| Opció | Mellette | Ellene |
|---|---|---|
| **A — Resend (EU)** ← **VÁLASZTOTT** | Bounce-webhook, EU adatközpont, ingyenes 3000/hó, modern API | Új vendor, DNS rekordok |
| **B — Appwrite Messaging** | Egy stack, nincs új vendor | Bounce-tracking SMTP-relay módban bizonytalan, deliverability tooling minimális |
| **C — SendGrid / Postmark** | Bevált, sok régió | Nem EU-default, drágább |

### Brute-force védelem

| Opció | Mellette | Ellene |
|---|---|---|
| **A — `failedAttempts` mező az invite collection-ön** | Egyszerű implementáció | DoS-vektor (támadó kiégetheti a meghívót); rontás-definíció bizonytalan; Appwrite `account.create()` flow nincs összekötve |
| **B — IP-rate-limit a `accept_invite` endpoint-on** ← **VÁLASZTOTT** | Standard, alacsony hamis-pozitív arány, nincs DoS-vektora | Új collection-ek (`ipRateLimitCounters`, `ipRateLimitBlocks`) |
| **C — Captcha** | Bot-ellenes | UX-rontó, accessibility kérdés |

### Multi-invite skálázás

| Opció | Mellette | Ellene |
|---|---|---|
| **A — Sync küldés (Promise.all)** | Egyszerű, modal lefut 5-10 mp-en belül | 20 e-mailnél 30+ mp UI-blokk |
| **B — CF batch (Promise.all 10-es csomagokban)** ← **VÁLASZTOTT** | Acceptable UI-blokk (5-15 sec), Realtime UI-frissítés progress-szerűen | CF execution time-limit határa |
| **C — Async queue/outbox** | Tetszőleges méret skálázódik | Bonyolult, új cron CF, nem kell most |

## Következmények

### Pozitív
- Branded, kiküldött e-mail → admin manuális munka megszűnik.
- Bounce-tracking → admin látja a lista-szűréseken hogy egy meghívó nem ért célba.
- Discord-szerű modal-UX → követhetőbb, kontrollálhatóbb meghívási folyamat.
- IP-rate-limit → token-leak esetén sem foszt meg a meghívottat.
- ADR 0002 (groups office-scope) érintetlen → nincs regressziós felület.

### Negatív / trade-off
- **Új vendor függőség** (Resend) → ha kiesik, a meghívások e-mail nélkül maradnak (de a `Link másolása` fallback megmarad).
- **DNS-fióton függ** (`emago.hu` cpanel) → ha a domain admin elveszti a hozzáférést, az e-mail-küldés sérül.
- **Új env var** `RESEND_API_KEY` → bekerül az Appwrite Function env-be (titkosítva, nem commit-olható).
- **Új CF function** `resend-webhook` → public endpoint, HMAC-verify kötelező.
- **Schema-drift kockázat**: 4 új mező az `invite-to-organization` collection-ön — Appwrite Cloud-on manuálisan hozzá kell adni, vagy a `schemas.js` action-be is beépíteni.

### Új kötelezettségek
- DNS rekordok karbantartása `emago.hu` zónán (cpanel).
- E-mail template magyar nyelvű karbantartása + későbbi rendszer-szintű lokalizációhoz alap (i18n placeholder-rendszer).
- Bounce-statisztika monitorozása Resend dashboardon (havi limit 3000 e-mail).
- Az `accept_invite` rate-limit window-eit rendszeresen takarítani egy cron CF-fel (vagy TTL-mintával az `ipRateLimitCounters`-en).

## Implementációs status (2026-05-08)

### Kész (W2 + W3 + Security)
1. **ADR + draft munka** (commit `6e22baa`): ADR 0010, e-mail template HTML+text, sendEmail.js skeleton, rateLimit.js skeleton, resend-webhook CF skeleton, InviteModal.jsx skeleton.
2. **W2 backend** (commit `e493bb8`):
   - `helpers/util.js`: `INVITE_VALIDITY_DAYS_OPTIONS [1,3,7]` + `_DEFAULT 7`
   - `actions/invites.js` `createInvite`: `expiryDays` + `customMessage` + auto-send
   - `actions/invites.js` új `createBatchInvites` (max 20, 10-es Promise.all batch)
   - `actions/invites.js` `acceptInvite`: `checkRateLimit('accept_invite')` guard
   - `actions/schemas.js` új `bootstrapInvitesSchemaV2` (4+1 új mező)
   - `actions/schemas.js` új `bootstrapRateLimitSchema` (2 új collection)
3. **W3 backend** (commit `e493bb8`):
   - `package.json`: `resend ^4.0.0` dep
   - `actions/sendEmail.js`: Resend SDK élesítve (skeleton-fallback ha env hiányzik)
   - `main.js`: 5 új ACTION_HANDLER + ctx.req + env bővítés
4. **Frontend** (commit `cabdaaa`):
   - `AuthContext.jsx`: `createInvite expiryDays` + `createBatchInvites` + `resendInviteEmail`
   - `UsersTab.jsx`: modal-launcher gomb + delivery status badge + Újraküldés gomb
   - `InviteModal.jsx`: `createBatchInvites`-re átállítva (1 round-trip)

### Hátralévő (deploy + Appwrite Cloud + Resend webhook)
A részletes lépések: [[Csomagok/meghivasi-flow]] dokumentum.

1. **CF deploy**: `invite-to-organization` (új kóddal) + új `resend-webhook` function
2. **Appwrite Cloud séma-bootstrap**: `bootstrap_invites_schema_v2` + `bootstrap_rate_limit_schema` action-hívások
3. **Env varok**: `DASHBOARD_URL`, `RESEND_API_KEY`, `IP_RATE_LIMIT_*_COLLECTION_ID` az `invite-to-organization`-höz; `RESEND_WEBHOOK_SECRET` az új webhook function-höz
4. **Resend Dashboard → Webhooks**: URL beállítás + secret másolás
5. **End-to-end teszt**: saját Gmail-re küldés + bounce-szimuláció + rate-limit teszt

## Kapcsolódó

- Memory: `meghivasi-flow-redesign.md` (a memória-pointerhez későbbre)
- Komponens: [[Komponensek/InviteModal]] (createolandó), [[Komponensek/UsersTab]] (módosítandó)
- Korábbi ADR-ek: [[0002-fazis2-dynamic-groups]] (groups office-scope megőrizve), [[0008-permission-system-and-workflow-driven-groups]] (`org.member.invite` slug)
- Resend Domain Verification screenshot: 2026-05-08 chat-szál
- DNS setup: cpanel `emago.hu` zóna, 2026-05-08
