/**
 * Maestro Dashboard — InviteModal (ADR 0010 W2)
 *
 * Discord-szerű felugró ablak az új tagok meghívásához.
 *
 * Mezők:
 *   - E-mail címek (chip-input, max 20, lower-case lefoglalva)
 *   - Role (member / admin) — segmented toggle, NEM dropdown (NEM owner)
 *   - Lejárat (1 / 3 / 7 nap, default 7) — segmented toggle
 *   - Opcionális üzenet (max 500 karakter)
 *
 * Sikeres kiküldés után:
 *   - A modal nem zárul be — eredmény-listát mutat (per-cím status)
 *   - "Bezárás" gomb → `onInviteSent` callback (a UsersTab pending invites
 *     listáját frissíti)
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
const ROLE_OPTIONS = [
    { value: 'member', label: 'Tag',   description: 'Olvasás és szerkesztés a hozzárendelt csoportokban.' },
    { value: 'admin',  label: 'Admin', description: 'Tagok meghívása, csoportok kezelése. Szervezet törlését nem érinti.' }
];
const EXPIRY_OPTIONS = [
    { days: 1, label: '1 nap' },
    { days: 3, label: '3 nap' },
    { days: 7, label: '7 nap' }
];

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

// D.5.4 — egy meghívó kiküldés-státusza humán formában a results-listához.
// `'sent' | 'failed' | 'cooldown' | undefined`. Codex review (2026-05-09):
// a `cooldown` ág akkor jön be, ha a backend idempotens existing-path
// 60 másodpercen belül egy második createInvite hívást kapott — a CF nem
// küld új e-mailt, csak ezzel jelzi.
function deliverySummary(deliveryStatus) {
    switch (deliveryStatus) {
        case 'sent':
            return { label: 'Kiküldve', variant: 'success', tooltip: 'A meghívó e-mail elindult.' };
        case 'failed':
            return { label: 'Létrejött, e-mail hiba', variant: 'error', tooltip: 'A meghívó létrejött, de az e-mail kiküldése sikertelen volt. Próbáld a függő meghívók listán az „Újraküldés" gombbal.' };
        case 'cooldown':
            return { label: 'Cooldown — várj', variant: 'muted', tooltip: 'Egy perccel ezelőtt már mentünk egy meghívót erre a címre. A backend most nem küldött újat — várj fél-egy percet, majd a függő meghívók listán „Újraküldés".' };
        default:
            return { label: 'Létrejött', variant: 'success', tooltip: 'A meghívó rekord létrejött.' };
    }
}

/**
 * Lejárati timestamp számítása az opcióhoz (most + N nap, helyi időzónában).
 * Csak a UI alá-meta címke ("május 17.") megjelenítéséhez — a backend a saját
 * `Date.now() + days * 86400_000`-jét használja.
 */
function expiryDateLabel(days) {
    const d = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
    // hu-HU short month + day, év nélkül (a meghívó max 7 napon belül lejár,
    // év-átlépés rendkívül ritka és a DateTime ott úgyis kontextus-független).
    return d.toLocaleDateString('hu-HU', { month: 'long', day: 'numeric' });
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
    const [results, setResults] = useState(null); // null | { successCount, failCount, perEmail: [...] }

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

    // Az aktuálisan érvényes e-mail darabszám (a CTA dinamikus szövegéhez,
    // pl. „3 meghívó küldése"). Az utolsó nem committed input is beleszámít,
    // ha érvényes formátumú.
    const validEmailCount = useMemo(() => {
        const trimmed = emailInput.trim().toLowerCase();
        const extra = trimmed && EMAIL_REGEX.test(trimmed) && !emails.includes(trimmed) ? 1 : 0;
        return emails.length + extra;
    }, [emails, emailInput]);

    // ─── Chip-input handlers ───────────────────────────────────────────────

    /**
     * Codex review 2026-05-08 MINOR 7 — paste-elt CSV/sortörés-elválasztott
     * lista is splitelődik. A user `a@b.com,c@d.com` vagy több soros paste-ot
     * is bekerítheti egy chip-be — most tokenizálunk vessző/pontosvessző/
     * sortörés/whitespace mentén.
     */
    function commitEmailChip() {
        const raw = emailInput.trim();
        if (!raw) return;
        const tokens = raw.split(/[\s,;]+/).map(t => t.trim().toLowerCase()).filter(Boolean);
        if (tokens.length === 0) return;

        const next = [...emails];
        let invalid = null;
        for (const token of tokens) {
            if (!EMAIL_REGEX.test(token)) {
                invalid = token;
                break;
            }
            if (next.includes(token)) continue; // csendes duplikáció-szűrés
            if (next.length >= MAX_EMAILS) {
                setSubmitError(`Maximum ${MAX_EMAILS} e-mail cím egyszerre.`);
                break;
            }
            next.push(token);
        }

        if (invalid) {
            setSubmitError(`Érvénytelen e-mail formátum: ${invalid}`);
            return;
        }
        if (next.length !== emails.length) {
            setEmails(next);
        }
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

        // Codex review 2026-05-08 MAJOR 5 — szinkron finalEmails számolás.
        // A korábbi `commitEmailChip()` hívás után a `setEmails(...)` async
        // setStateAction NEM érvényesül a current render-ben, így a régi
        // `emails` state-ből számolt `finalEmails` lenyelhette az utolsó
        // chipnek nem commitált címet. Most szinkron-számolás:
        const trimmedInput = emailInput.trim().toLowerCase();
        const finalEmails = [...emails];
        if (trimmedInput) {
            if (!EMAIL_REGEX.test(trimmedInput)) {
                setSubmitError(`Érvénytelen e-mail formátum: ${trimmedInput}`);
                return;
            }
            if (!finalEmails.includes(trimmedInput) && finalEmails.length < MAX_EMAILS) {
                finalEmails.push(trimmedInput);
            }
        }

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
            // Codex baseline review fix (2026-05-09 MINOR): a `successCount`
            // invite-doc létrejöttét (idempotens existing + race-winner is)
            // számolja, NEM a tényleges e-mail kiküldést. A toast szövege
            // ehhez igazítva: `meghívó létrejött` + a `Kiküldés eredménye`
            // részletes panel mutatja a delivery-státuszt per-email.
            const successCount = response.successCount || 0;
            if (successCount > 0) {
                const sentCount = perEmail.filter(r => r.deliveryStatus === 'sent').length;
                const toastMsg = sentCount === successCount
                    ? `${successCount} meghívó kiküldve.`
                    : `${successCount} meghívó létrejött (${sentCount} e-mail elindult — részletek a listán).`;
                showToast(toastMsg, 'success');
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
                <h3 className="invite-modal-results-title">Kiküldés eredménye</h3>
                <div className="invite-modal-results-summary">
                    {results.successCount > 0 && (
                        <span className="invite-modal-results-success">
                            ✓ {results.successCount} sikeres meghívó
                        </span>
                    )}
                    {results.failCount > 0 && (
                        <span className="invite-modal-results-error">
                            ✗ {results.failCount} sikertelen meghívó
                        </span>
                    )}
                </div>
                <ul className="invite-modal-results-list">
                    {results.perEmail.map((r, i) => {
                        const summary = r.status === 'ok' ? deliverySummary(r.deliveryStatus) : null;
                        const variant = summary ? summary.variant : 'error';
                        return (
                            <li key={i} className="invite-modal-results-row">
                                <span className="invite-modal-results-email">{r.email}</span>
                                <span
                                    className={`org-settings-delivery-badge org-settings-delivery-badge--${variant}`}
                                    title={summary ? summary.tooltip : (r.error || 'Hiba')}
                                >
                                    {summary ? summary.label : (r.error || 'Hiba')}
                                </span>
                            </li>
                        );
                    })}
                </ul>
                <div className="modal-actions">
                    <button type="button" className="btn-primary" onClick={closeModal}>
                        Bezárás
                    </button>
                </div>
            </div>
        );
    }

    // ─── Render: form-nézet ────────────────────────────────────────────────

    const submitDisabled = isSubmitting || hasErrors || (emails.length === 0 && !emailInput.trim());

    return (
        <form className="invite-modal-form" onSubmit={handleSubmit}>

            {/* E-mail chip-input */}
            <div className="invite-modal-field">
                <label htmlFor="invite-emails" className="invite-modal-label">
                    E-mail címek
                </label>
                <div
                    className="invite-modal-chip-container"
                    onClick={() => document.getElementById('invite-emails')?.focus()}
                >
                    {emails.map((em, i) => (
                        <span key={i} className="invite-modal-chip">
                            <span>{em}</span>
                            <button
                                type="button"
                                className="invite-modal-chip-remove"
                                onClick={() => removeEmailChip(i)}
                                aria-label={`${em} eltávolítása`}
                            >
                                ×
                            </button>
                        </span>
                    ))}
                    <input
                        id="invite-emails"
                        type="email"
                        className="invite-modal-chip-input"
                        value={emailInput}
                        onChange={(e) => setEmailInput(e.target.value)}
                        onKeyDown={handleEmailKeyDown}
                        onBlur={commitEmailChip}
                        disabled={isSubmitting || emails.length >= MAX_EMAILS}
                        placeholder={emails.length === 0 ? 'pl. uj.tag@example.com' : ''}
                        autoFocus
                    />
                </div>
                <div className="invite-modal-field-hint">
                    <span>{validEmailCount} érvényes · max {MAX_EMAILS}</span>
                    <span className="invite-modal-field-hint-tail">Enter, vessző vagy paste: új chip</span>
                </div>
                {errors.emails && <div className="form-error">{errors.emails}</div>}
            </div>

            {/* Role — segmented control with descriptions */}
            <div className="invite-modal-field">
                <span className="invite-modal-label">Szerepkör</span>
                <div className="invite-modal-role-grid" role="radiogroup" aria-label="Szerepkör">
                    {ROLE_OPTIONS.map(opt => {
                        const isActive = role === opt.value;
                        return (
                            <button
                                key={opt.value}
                                type="button"
                                role="radio"
                                aria-checked={isActive}
                                className={`invite-modal-role-card${isActive ? ' is-active' : ''}`}
                                onClick={() => setRole(opt.value)}
                                disabled={isSubmitting}
                            >
                                <span className="invite-modal-role-card-label">{opt.label}</span>
                                <span className="invite-modal-role-card-desc">{opt.description}</span>
                            </button>
                        );
                    })}
                </div>
                <p className="invite-modal-field-info">
                    Tulajdonos szerepkört csak meglévő admin-nak lehet kiosztani — itt nem elérhető.
                </p>
            </div>

            {/* Expiry — segmented control */}
            <div className="invite-modal-field">
                <span className="invite-modal-label">Meghívó érvényessége</span>
                <div className="invite-modal-expiry-grid" role="radiogroup" aria-label="Lejárat">
                    {EXPIRY_OPTIONS.map(opt => {
                        const isActive = expiryDays === opt.days;
                        return (
                            <button
                                key={opt.days}
                                type="button"
                                role="radio"
                                aria-checked={isActive}
                                className={`invite-modal-expiry-card${isActive ? ' is-active' : ''}`}
                                onClick={() => setExpiryDays(opt.days)}
                                disabled={isSubmitting}
                            >
                                <span className="invite-modal-expiry-card-label">{opt.label}</span>
                                <span className="invite-modal-expiry-card-date">lejár: {expiryDateLabel(opt.days)}</span>
                            </button>
                        );
                    })}
                </div>
            </div>

            {/* Message */}
            <div className="invite-modal-field">
                <label htmlFor="invite-message" className="invite-modal-label">
                    Üzenet <span className="invite-modal-label-optional">(opcionális)</span>
                </label>
                <textarea
                    id="invite-message"
                    className="invite-modal-textarea"
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                    disabled={isSubmitting}
                    maxLength={MAX_MESSAGE_LENGTH}
                    rows={3}
                    placeholder="pl. Üdv a csapatban!"
                />
                <div className="invite-modal-field-hint">
                    <span />
                    <span className="invite-modal-field-hint-tail">{message.length} / {MAX_MESSAGE_LENGTH}</span>
                </div>
                {errors.message && <div className="form-error">{errors.message}</div>}
            </div>

            {submitError && (
                <div className="form-error form-error-global">{submitError}</div>
            )}

            <div className="modal-actions invite-modal-footer">
                <span className="invite-modal-footer-info help-text">
                    Az e-mail Resend-en keresztül érkezik a noreply@maestro.emago.hu címről.
                </span>
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
                    disabled={submitDisabled}
                >
                    {isSubmitting
                        ? 'Kiküldés…'
                        : `${validEmailCount > 0 ? validEmailCount : ''} meghívó küldése`.trim()}
                </button>
            </div>
        </form>
    );
}
