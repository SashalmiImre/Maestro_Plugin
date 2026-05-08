/**
 * Maestro Dashboard — InviteModal (ADR 0010 W2 SKELETON)
 *
 * Discord-szerű felugró ablak az új tagok meghívásához. Lecseréli a
 * UsersTab.jsx inline űrlapját (ADR 0010 W2).
 *
 * Mezők:
 *   - E-mail címek (chip-input, max 20, lower-case lefoglalva)
 *   - Role (member / admin, ugyanaz minden címnek)
 *   - Lejárat (1 / 3 / 7 nap, default 7)
 *   - Opcionális üzenet (max 500 karakter)
 *
 * Sikeres kiküldés után:
 *   - A modal nem zárul be — eredmény-listát mutat (per-cím status)
 *   - "Bezárás" gomb → `onInviteSent` callback (a UsersTab pending invites
 *     listáját frissíti)
 *
 * SKELETON — Stitch redesign merge után húzandó be:
 *   1. A `useAuth().createInvite` szignatúra még `(orgId, email, role, message)` —
 *      W2 élesítéskor `expiryDays` paraméterrel bővül. A `// SKELETON:` kommentes
 *      sorokat akkor kell aktiválni.
 *   2. A frontend-batch (10-es Promise.all) lecserélhető egyetlen
 *      `createBatchInvites(orgId, payload)` AuthContext action-re — egy round-trip
 *      a CF-nek, kevesebb network-szám, jobb UX.
 *   3. Stitch dashboard design tokenek (`--bg-base`, `--accent-solid`,
 *      glassmorphism kártya) automatikusan érvényesülnek a `Modal.jsx` portál-
 *      kártya alatt — itt csak az inline `style` placeholder színek jönnek a
 *      meglévő `var(--xx)` változókból.
 *
 * A render KÉT állapotot különböztet meg:
 *   - `results === null`: form (input)
 *   - `results !== null`: per-email status-lista
 */

import React, { useState, useMemo, useEffect, useRef } from 'react';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { useModal } from '../../contexts/ModalContext.jsx';
import { useToast } from '../../contexts/ToastContext.jsx';

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAILS = 20;
const MAX_MESSAGE_LENGTH = 500;
const EXPIRY_OPTIONS = [
    { days: 1, label: '1 nap' },
    { days: 3, label: '3 nap' },
    { days: 7, label: '7 nap' }
];
const FRONTEND_BATCH_SIZE = 10;

function errorMessage(code) {
    if (typeof code !== 'string') return 'Ismeretlen hiba történt.';
    if (code.includes('missing_fields')) return 'Tölts ki minden kötelező mezőt.';
    if (code.includes('invalid_email')) return 'Érvénytelen e-mail cím formátum.';
    if (code.includes('invalid_role')) return 'Érvénytelen szerepkör.';
    if (code.includes('invalid_expiry_days')) return 'Érvénytelen lejárati idő — 1, 3 vagy 7 nap választható.';
    if (code.includes('batch_too_large')) return `Egyszerre maximum ${MAX_EMAILS} e-mail címre küldhetsz meghívót.`;
    if (code.includes('insufficient_permission')) return 'Nincs jogosultságod meghívókat küldeni.';
    if (code.includes('already_member')) return 'A felhasználó már tagja a szervezetnek.';
    if (code.includes('already_invited')) return 'Ehhez az e-mail címhez már van függőben lévő meghívó.';
    if (code.includes('email_send_failed')) {
        return 'A meghívó létrejött, de a kiküldés sikertelen — próbáld újraküldeni a függő meghívók listán.';
    }
    if (code.includes('Failed to fetch') || code.includes('NetworkError')) {
        return 'Hálózati hiba. Ellenőrizd a kapcsolatot, és próbáld újra.';
    }
    return code;
}

/**
 * @param {Object} props
 * @param {string} props.organizationId — a meghívást fogadó szervezet `$id`-ja
 * @param {Function} [props.onInviteSent] — sikeres kiküldés utáni callback
 */
export default function InviteModal({ organizationId, onInviteSent }) {
    const { createBatchInvites } = useAuth();
    const { closeModal } = useModal();
    const { showToast } = useToast();

    // E-mail chip-input state
    const [emailInput, setEmailInput] = useState('');
    const [emails, setEmails] = useState([]);

    // Form fields
    const [role, setRole] = useState('member');
    const [expiryDays, setExpiryDays] = useState(7);
    const [message, setMessage] = useState('');

    // Submission state
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [submitError, setSubmitError] = useState('');
    const [results, setResults] = useState(null); // null | { successCount, failCount, perEmail: [{email, status, error?}] }

    // Mount-tracking — a results rendering után a modal nem zárul be saját erőből,
    // de ha bezárul (closeModal kívülről), a finally-ben futó setIsSubmitting
    // warningot adna. (CreateOrganizationModal mintáját követjük.)
    const isMountedRef = useRef(true);
    useEffect(() => {
        isMountedRef.current = true;
        return () => { isMountedRef.current = false; };
    }, []);

    const errors = useMemo(() => {
        const next = {};
        if (emails.length === 0 && !emailInput.trim()) {
            next.emails = 'Adj meg legalább egy e-mail címet.';
        }
        if (emails.length > MAX_EMAILS) {
            next.emails = `Maximum ${MAX_EMAILS} e-mail cím egyszerre.`;
        }
        if (message.length > MAX_MESSAGE_LENGTH) {
            next.message = `Az üzenet legfeljebb ${MAX_MESSAGE_LENGTH} karakter lehet.`;
        }
        return next;
    }, [emails, emailInput, message]);

    const hasErrors = Object.keys(errors).length > 0;

    // ─── Chip-input handlers ───────────────────────────────────────────────

    function commitEmailChip() {
        const trimmed = emailInput.trim().toLowerCase();
        if (!trimmed) return;
        if (!EMAIL_REGEX.test(trimmed)) {
            setSubmitError(`Érvénytelen e-mail formátum: ${trimmed}`);
            return;
        }
        if (emails.includes(trimmed)) {
            setEmailInput(''); // csendes duplikáció-szűrés
            return;
        }
        if (emails.length >= MAX_EMAILS) {
            setSubmitError(`Maximum ${MAX_EMAILS} e-mail cím egyszerre.`);
            return;
        }
        setEmails([...emails, trimmed]);
        setEmailInput('');
        setSubmitError('');
    }

    function handleEmailKeyDown(e) {
        if (e.key === 'Enter' || e.key === 'Tab' || e.key === ',') {
            e.preventDefault();
            commitEmailChip();
        } else if (e.key === 'Backspace' && !emailInput && emails.length > 0) {
            setEmails(emails.slice(0, -1));
        }
    }

    function removeEmailChip(idx) {
        setEmails(emails.filter((_, i) => i !== idx));
    }

    // ─── Submit ────────────────────────────────────────────────────────────

    async function handleSubmit(e) {
        e.preventDefault();
        // Last-chance commit ha az inputban van még egy be nem chipezett cím
        if (emailInput.trim()) commitEmailChip();
        const finalEmails = emails.length > 0
            ? emails
            : (emailInput.trim() ? [emailInput.trim().toLowerCase()] : []);
        if (finalEmails.length === 0 || hasErrors) return;

        setIsSubmitting(true);
        setSubmitError('');

        // ADR 0010 W2 — egy CF round-trip a teljes batch-re.
        // A backend (createBatchInvites action) iterál 10-es Promise.all
        // csomagokban + per-email auto-send-ekkel. Visszaad egy results
        // tömböt (`{email, status: 'ok'|'error', deliveryStatus?, ...}`).
        try {
            const response = await createBatchInvites(
                organizationId,
                finalEmails,
                role,
                message || undefined,
                expiryDays
            );
            if (!isMountedRef.current) return;
            const perEmail = (response.results || []).map(r => ({
                email: r.email,
                status: r.status,
                error: r.status === 'error' ? errorMessage(r.reason || '') : undefined,
                deliveryStatus: r.deliveryStatus
            }));
            setResults({
                successCount: response.successCount || 0,
                failCount: response.failCount || 0,
                perEmail
            });
            setIsSubmitting(false);
            if ((response.successCount || 0) > 0) {
                showToast(`${response.successCount} meghívó kiküldve.`, 'success');
                if (onInviteSent) {
                    try { await onInviteSent(); } catch { /* non-blocking */ }
                }
            }
        } catch (err) {
            if (isMountedRef.current) {
                setSubmitError(errorMessage(err?.message || err?.code || ''));
                setIsSubmitting(false);
            }
        }
    }

    // ─── Render: results-nézet ─────────────────────────────────────────────

    if (results) {
        return (
            <div className="invite-modal-results">
                <h3 style={{ margin: '0 0 12px 0', fontSize: 16, fontWeight: 600 }}>
                    Kiküldés eredménye
                </h3>
                <div style={{ marginBottom: 16, fontSize: 13 }}>
                    {results.successCount > 0 && (
                        <div style={{ color: 'var(--c-success)' }}>
                            ✓ {results.successCount} sikeres meghívó
                        </div>
                    )}
                    {results.failCount > 0 && (
                        <div style={{ color: 'var(--c-error)' }}>
                            ✗ {results.failCount} sikertelen meghívó
                        </div>
                    )}
                </div>
                <ul style={{
                    listStyle: 'none', padding: 0, margin: 0,
                    maxHeight: 240, overflowY: 'auto'
                }}>
                    {results.perEmail.map((r, i) => (
                        <li key={i} style={{
                            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                            padding: '6px 0', fontSize: 13,
                            borderBottom: '1px solid var(--border)'
                        }}>
                            <span>{r.email}</span>
                            <span style={{
                                color: r.status === 'ok'
                                    ? (r.deliveryStatus === 'failed' ? 'var(--c-error)' : 'var(--c-success)')
                                    : 'var(--c-error)',
                                fontSize: 11
                            }}>
                                {r.status === 'ok'
                                    ? (r.deliveryStatus === 'failed'
                                        ? 'Létrejött, e-mail hiba'
                                        : (r.deliveryStatus === 'sent' ? 'Kiküldve' : 'Létrejött'))
                                    : (r.error || 'Hiba')}
                            </span>
                        </li>
                    ))}
                </ul>
                <div className="modal-actions" style={{ marginTop: 16 }}>
                    <button type="button" className="btn-primary" onClick={closeModal}>
                        Bezárás
                    </button>
                </div>
            </div>
        );
    }

    // ─── Render: form-nézet ────────────────────────────────────────────────

    return (
        <form className="publication-form invite-modal-form" onSubmit={handleSubmit}>

            {/* E-mail chip-input */}
            <div className="form-group">
                <label htmlFor="invite-emails">
                    E-mail címek{' '}
                    <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>
                        (Enter / vessző: új chip, max {MAX_EMAILS})
                    </span>
                </label>
                <div
                    style={{
                        display: 'flex', flexWrap: 'wrap', gap: 6,
                        padding: '6px 8px',
                        background: 'var(--bg-base)',
                        border: '1px solid var(--outline-variant)',
                        borderRadius: 4,
                        minHeight: 36,
                        cursor: 'text'
                    }}
                    onClick={() => document.getElementById('invite-emails')?.focus()}
                >
                    {emails.map((em, i) => (
                        <span key={i} style={{
                            display: 'inline-flex', alignItems: 'center', gap: 4,
                            padding: '2px 8px', borderRadius: 3,
                            background: 'var(--bg-elevated)', fontSize: 12
                        }}>
                            {em}
                            <button
                                type="button"
                                onClick={() => removeEmailChip(i)}
                                style={{
                                    background: 'none', border: 'none', cursor: 'pointer',
                                    color: 'var(--text-muted)', fontSize: 14, lineHeight: 1, padding: 0
                                }}
                                aria-label={`${em} eltávolítása`}
                            >
                                ×
                            </button>
                        </span>
                    ))}
                    <input
                        id="invite-emails"
                        type="email"
                        value={emailInput}
                        onChange={(e) => setEmailInput(e.target.value)}
                        onKeyDown={handleEmailKeyDown}
                        onBlur={commitEmailChip}
                        disabled={isSubmitting || emails.length >= MAX_EMAILS}
                        placeholder={emails.length === 0 ? 'pl. uj.tag@example.com' : ''}
                        style={{
                            flex: '1 1 160px', border: 'none', background: 'transparent',
                            color: 'var(--text-primary)', fontSize: 12, outline: 'none', minWidth: 120
                        }}
                        autoFocus
                    />
                </div>
                {errors.emails && <div className="form-error">{errors.emails}</div>}
            </div>

            {/* Role */}
            <div className="form-group">
                <label htmlFor="invite-role">Szerepkör</label>
                <select
                    id="invite-role"
                    value={role}
                    onChange={(e) => setRole(e.target.value)}
                    disabled={isSubmitting}
                >
                    <option value="member">Tag</option>
                    <option value="admin">Admin</option>
                </select>
            </div>

            {/* Expiry — radio button group */}
            <div className="form-group">
                <label>Lejárat</label>
                <div style={{ display: 'flex', gap: 12, marginTop: 4 }}>
                    {EXPIRY_OPTIONS.map(opt => (
                        <label
                            key={opt.days}
                            style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}
                        >
                            <input
                                type="radio"
                                name="expiry"
                                value={opt.days}
                                checked={expiryDays === opt.days}
                                onChange={() => setExpiryDays(opt.days)}
                                disabled={isSubmitting}
                            />
                            <span style={{ fontSize: 12 }}>{opt.label}</span>
                        </label>
                    ))}
                </div>
            </div>

            {/* Message */}
            <div className="form-group">
                <label htmlFor="invite-message">
                    Üzenet{' '}
                    <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>
                        (opcionális, max {MAX_MESSAGE_LENGTH})
                    </span>
                </label>
                <textarea
                    id="invite-message"
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                    disabled={isSubmitting}
                    maxLength={MAX_MESSAGE_LENGTH}
                    rows={3}
                    placeholder="pl. Üdv a csapatban!"
                    style={{ resize: 'vertical', fontFamily: 'inherit' }}
                />
                {errors.message && <div className="form-error">{errors.message}</div>}
            </div>

            {submitError && (
                <div className="form-error form-error-global">{submitError}</div>
            )}

            <div className="modal-actions">
                <button
                    type="button"
                    className="btn-secondary"
                    onClick={closeModal}
                    disabled={isSubmitting}
                >
                    Mégse
                </button>
                <button
                    type="submit"
                    className="btn-primary"
                    disabled={isSubmitting || hasErrors || (emails.length === 0 && !emailInput.trim())}
                >
                    {isSubmitting
                        ? 'Kiküldés…'
                        : `Meghívó küldése${emails.length > 1 ? ` (${emails.length})` : ''}`}
                </button>
            </div>
        </form>
    );
}
