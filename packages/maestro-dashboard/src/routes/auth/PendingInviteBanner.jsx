/**
 * Maestro Dashboard — PendingInviteBanner
 *
 * Tájékoztató banner a /login és /register oldalakon, ha a felhasználó egy
 * meghívási linken keresztül érkezett (`/invite?token=...` → `InviteRoute`
 * a tokent localStorage-ba menti, és átirányít a /register-re).
 *
 * Cél: a user pontosan tudja, hogy a meghívóhoz tartozó e-mail-címet kell
 * megadnia, különben az `accept_invite` action a regisztráció után
 * `email_mismatch` hibával elutasít. (ADR 0010 W2 UX-ergonómia.)
 *
 * SZÁNDÉKOSAN nem csinálunk publikus token→e-mail lookup CF-action-t —
 * Codex review (2026-05-08) BLOCKER-rel jelölte az ehhez tartozó PII-
 * szivárgási kockázatot. A banner csak akkor jelenik meg, ha a token a
 * localStorage-ban van (azaz a user a saját böngészőjéből indított a
 * meghívási linken). Semmilyen token-tartalmat nem mutatunk.
 *
 * `STORAGE_KEY` egyezik az `InviteRoute.jsx`-ben definiálttal — kis
 * duplikáció (3 helyen él), de egy közös util-modul ennyiért overkill.
 */

import React from 'react';

const STORAGE_KEY = 'maestro.pendingInviteToken';

export function hasPendingInvite() {
    try {
        return Boolean(localStorage.getItem(STORAGE_KEY));
    } catch {
        return false;
    }
}

export default function PendingInviteBanner() {
    if (!hasPendingInvite()) return null;
    return (
        <div
            role="status"
            style={{
                marginBottom: 16,
                padding: '12px 14px',
                background: 'var(--bg-elevated, rgba(91, 140, 255, 0.08))',
                border: '1px solid var(--accent-solid, #5b8cff)',
                borderRadius: 8,
                fontSize: 13,
                lineHeight: 1.5,
                color: 'var(--text-primary, #e6e8ec)'
            }}
        >
            <strong style={{ display: 'block', marginBottom: 4 }}>
                📩 Meghívást kaptál a Maestro-ra
            </strong>
            Add meg az e-mail címet, amelyre a meghívó érkezett — más címmel a
            regisztráció után nem tudod elfogadni a meghívást.
        </div>
    );
}
