// S.2.7 harden MED-1 (2026-05-11) — invite-flow rate-limit scope-konfig.
//
// Az invite-küldési flow 3 scope-ot ütköztet (a `createInvite`/`createBatchInvites`/
// `sendInviteEmail` mind ezt használja):
//   - `invite_send_ip`      (per-IP, 15min/30/1h block)        — anon-spam védelem
//   - `invite_send_user`    (per-callerId, 24h/50/1h block)    — admin abuse cap
//   - `invite_send_org_day` (per-orgId, 24h/200/1h, weight=N)  — Resend cost-cap
//
// A `helpers/rateLimit.js` `evaluateAndConsume(ctx, scopes)` veszi át innen
// a scope-listát és kezeli a sequential-evaluate + parallel-consume flow-t.
// (Simplify-pass Reuse F2: az `evaluateAndConsume` generic, `deleteMyAccount`
// 3.6 hookpoint is használja egyetlen scope-pal.)
//
// Külön fájl-szervezés indok: a `sendEmail.js` és `invites.js` cyclic require-be
// esnek (sendOneInviteEmail-en át), ezért az invite-specifikus scope-meta itt él.

function inviteSendScopes(callerId, organizationId, emailCount) {
    return [
        { endpoint: 'invite_send_ip', tag: 'ip' },
        { endpoint: 'invite_send_user', options: { subject: callerId }, tag: 'user' },
        { endpoint: 'invite_send_org_day', options: { subject: organizationId, weight: emailCount }, tag: 'org' }
    ];
}

module.exports = {
    inviteSendScopes
};
