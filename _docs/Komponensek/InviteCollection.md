---
tags: [komponens, server, schema]
aliases: [InviteCollection, organizationInvites]
---

# organizationInvites collection

## Cél
A meghívási flow tartalmi adatait tárolja: melyik szervezetbe, kit, milyen szerepkörrel, mikor lejár, és — a [[Döntések/0010-meghivasi-flow-redesign|ADR 0010]] W2 fázis után — a kiküldés státuszát.

## Helye
- **Collection ID**: `organizationInvites`
- **Database ID**: `process.env.APPWRITE_DATABASE_ID`
- **CF read/write**: `invite-to-organization` function
  - [src/actions/invites.js](../../packages/maestro-server/functions/invite-to-organization/src/actions/invites.js) — `createInvite`, `acceptInvite`, `listMyInvites`, `declineInvite`
  - [src/actions/sendEmail.js](../../packages/maestro-server/functions/invite-to-organization/src/actions/sendEmail.js) (skeleton) — `sendInviteEmail`, `sendInviteEmailBatch`

## Sémamezők

### Jelenlegi (élő, főbb)
| Mező | Típus | Default | Index | Megjegyzés |
|---|---|---|---|---|
| `organizationId` | string(36) | — | composite unique `(organizationId, email, status)` | A meghívás célzata (`organization.$id`) |
| `email` | string(320) | — | composite unique | Lower-case lefoglalva (`createInvite` normalizál) |
| `token` | string(64) | — | hash index | `crypto.randomBytes(32).toString('hex')` |
| `status` | string(16) | `pending` | composite unique | `pending \| accepted \| expired \| declined` |
| `role` | string(16) | `member` | — | `member \| admin` (owner kizárva, ld. `actions/invites.js:49`) |
| `expiresAt` | datetime | now + 7 nap | — | `INVITE_VALIDITY_DAYS` × 1 nap |
| `invitedByUserId` | string(36) | — | — | Caller `user.$id` |
| `customMessage` | string(500) | nullable | — | Opcionális üzenet a meghívottnak |

### ADR 0010 W2 bővítés (Proposed)

| Mező | Típus | Default | Megjegyzés |
|---|---|---|---|
| `lastDeliveryStatus` | string(32) | `'pending'` | `pending \| sent \| delivered \| bounced \| failed` |
| `lastDeliveryError` | string(512) | nullable | Resend `error.message` (truncált) |
| `sendCount` | integer | 0 | Hányszor küldtük el az e-mailt (újraküldés tracking) |
| `lastSentAt` | datetime | nullable | Utolsó kiküldés ISO timestampje |

**Jelenlegi `expiresAt` viselkedés-változás (ADR 0010 W2)**:
- Régi: fix `INVITE_VALIDITY_DAYS=7`
- Új: `createInvite` payload `expiryDays` (1 \| 3 \| 7) — szerver-oldali whitelist, default 7
- A `helpers/util.js` `INVITE_VALIDITY_DAYS` konstans helyett `INVITE_VALIDITY_DAYS_OPTIONS = [1, 3, 7]` és `INVITE_VALIDITY_DAYS_DEFAULT = 7`

## Implementáció lépései (ADR 0010 W2)

1. **Appwrite Cloud — séma-bővítés** (manuális vagy `bootstrap_invites_schema` action-ön át):
   ```
   lastDeliveryStatus  string(32)   default='pending'  required=true
   lastDeliveryError   string(512)  default=null       required=false
   sendCount           integer      default=0          min=0  required=true
   lastSentAt          datetime                        required=false
   ```
2. **`actions/invites.js` `createInvite` patch**:
   - `payload.expiryDays` whitelist (`[1, 3, 7]`, default 7) → `expiresAt = now + days*24*60*60*1000`
   - `lastDeliveryStatus='pending'` az `createDocument` payload-ban (új invite-okra)
3. **`actions/sendEmail.js` aktiválás** (W3 fázis): a TODO(W3 live) kommentes Resend SDK call uncomment-elése + `RESEND_API_KEY` env var.
4. **Bounce tracking** (W3 fázis): a `resend-webhook` CF function (külön function) frissíti a `lastDeliveryStatus`-t Resend Svix payload alapján.

## Migráció / backfill
A meglévő invite rekordokon a default-ok érvényesek (`lastDeliveryStatus='pending'`, `sendCount=0`), explicit backfill nem kell. **Ha valaki Appwrite Cloud-on a séma-bővítéskor `required=true`-t állít a `lastDeliveryStatus`-on**, akkor egyszer le kell futtatni egy backfill-et a meglévő rekordokon. Ezt a `bootstrap_invites_schema` action utáni helper script vagy egy egyszerű cli-loop végzi (nincs külön CF action erre).

## Kapcsolódó
- ADR: [[Döntések/0010-meghivasi-flow-redesign]]
- Komponens: [[InviteModal]] (UI), [[InviteRateLimit]] (security)
- Hibaelhárítás: [[Hibaelhárítás#Email kézbesítési hiba pending invite-on]] (W3 után létrehozandó)
