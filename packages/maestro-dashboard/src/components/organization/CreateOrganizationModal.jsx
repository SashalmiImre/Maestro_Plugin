/**
 * Maestro Dashboard — CreateOrganizationModal (#40)
 *
 * Új szervezet létrehozása a user avatar dropdown „Új szervezet…"
 * menüpontjából. A `bootstrap_organization` CF-fel ellentétben a
 * `create_organization` action NEM idempotens — minden hívás új orgot
 * hoz létre még akkor is, ha a caller már tagja egy meglévőnek.
 *
 * Mezők:
 *   - Szervezet neve (kötelező, max 128 karakter)
 *   - Slug (auto-generált, read-only display — a názból szerver-konzisztens
 *     szabályokkal képződik, ld. `utils/slugify.js`)
 *   - Default office név: "Általános" (rejtett — a user később az Office
 *     Settings-ben átnevezheti #28 alapján)
 *
 * Sikeres létrehozás után:
 *   - Memberships reload
 *   - Scope váltás új org-ra + új office-ra (switchScopeOnSuccess opcionális,
 *     alapértelmezett: igen). A ModalContext scope-auto-close effekt amúgy is
 *     bezárja a modalt a scope váltáskor.
 *   - Success toast
 */

import React, { useState, useMemo, useEffect, useRef } from 'react';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { useModal } from '../../contexts/ModalContext.jsx';
import { useToast } from '../../contexts/ToastContext.jsx';
import { useScope } from '../../contexts/ScopeContext.jsx';
import { slugify } from '../../utils/slugify.js';

const DEFAULT_OFFICE_NAME = 'Általános';
const DEFAULT_OFFICE_SLUG = 'altalanos';

function errorMessage(code) {
    if (typeof code !== 'string') return 'Ismeretlen hiba történt.';
    if (code.includes('missing_fields')) return 'Tölts ki minden kötelező mezőt.';
    if (code.includes('invalid_slug')) return 'A névből generált azonosító érvénytelen — használj betűket vagy számokat.';
    if (code.includes('org_slug_taken')) return 'Ezzel a névvel már létezik szervezet — válassz másik nevet.';
    if (code.includes('office_slug_taken')) return 'A szerkesztőség azonosítója ütközik — próbáld újra.';
    if (code.includes('org_create_failed')) return 'A szervezet létrehozása sikertelen. Próbáld újra.';
    if (code.includes('office_create_failed')) return 'A szervezet létrejött, de a szerkesztőség létrehozása sikertelen. Próbáld újra.';
    if (code.includes('membership_create_failed')) return 'A szervezet létrejött, de a tagság beállítása sikertelen. Frissítsd az oldalt.';
    if (code.includes('groups_create_failed')) return 'A csoportok létrehozása sikertelen. Frissítsd az oldalt.';
    if (code.includes('group_memberships_create_failed')) return 'A csoporttagságok létrehozása sikertelen. Frissítsd az oldalt.';
    if (code.includes('not_authenticated')) return 'Bejelentkezés szükséges.';
    if (code.includes('Failed to fetch') || code.includes('NetworkError')) {
        return 'Hálózati hiba. Ellenőrizd a kapcsolatot, és próbáld újra.';
    }
    return code;
}

/**
 * @param {Object} props
 * @param {boolean} [props.switchScopeOnSuccess=true] — sikeres létrehozás után
 *   az új org + office-ra váltson-e a ScopeContext (alapértelmezett: igen)
 */
export default function CreateOrganizationModal({ switchScopeOnSuccess = true }) {
    const { createNewOrganization } = useAuth();
    const { closeModal } = useModal();
    const { showToast } = useToast();
    const { setActiveOrganization, setActiveOffice } = useScope();

    const [name, setName] = useState('');
    const [touched, setTouched] = useState({});
    const [submitError, setSubmitError] = useState('');
    const [isSubmitting, setIsSubmitting] = useState(false);

    // Lásd CreateEditorialOfficeModal kommentje — a ModalContext scope-auto-
    // close unmountolja a komponenst a setActiveOrganization() után, így a
    // finally-ben futó setIsSubmitting(false) warningot adna.
    const isMountedRef = useRef(true);
    useEffect(() => {
        isMountedRef.current = true;
        return () => { isMountedRef.current = false; };
    }, []);

    const orgSlug = useMemo(() => slugify(name), [name]);

    const errors = useMemo(() => {
        const next = {};
        const trimmed = name.trim();
        if (!trimmed) {
            next.name = 'A név nem lehet üres.';
        } else if (trimmed.length > 128) {
            next.name = 'A név legfeljebb 128 karakter lehet.';
        } else if (!orgSlug) {
            next.name = 'A névből nem generálható azonosító — használj betűket vagy számokat.';
        }
        return next;
    }, [name, orgSlug]);

    const hasErrors = Object.keys(errors).length > 0;

    function markTouched(field) {
        setTouched(prev => (prev[field] ? prev : { ...prev, [field]: true }));
    }

    async function handleSubmit(e) {
        e?.preventDefault?.();
        setTouched({ name: true });
        if (hasErrors || isSubmitting) return;

        setIsSubmitting(true);
        setSubmitError('');

        const trimmedName = name.trim();

        try {
            const response = await createNewOrganization(
                trimmedName,
                orgSlug,
                DEFAULT_OFFICE_NAME,
                DEFAULT_OFFICE_SLUG
            );

            if (response.membershipsReloaded) {
                if (switchScopeOnSuccess && response.organizationId) {
                    // Először az org váltás — a ScopeContext office auto-pick
                    // amúgy is megtalálja az új office-t, de explicit setelve
                    // gyorsabb és determinisztikus.
                    setActiveOrganization(response.organizationId);
                    if (response.editorialOfficeId) {
                        setActiveOffice(response.editorialOfficeId);
                    }
                }
                showToast(`„${trimmedName}" szervezet létrehozva.`, 'success');
            } else {
                showToast(
                    `„${trimmedName}" szervezet létrehozva, de a lista szinkron sikertelen. Frissítsd az oldalt.`,
                    'warning'
                );
            }
            closeModal();
        } catch (err) {
            console.error('[CreateOrganizationModal] Létrehozás hiba:', err);
            if (isMountedRef.current) {
                setSubmitError(errorMessage(err?.code || err?.message || ''));
            }
        } finally {
            if (isMountedRef.current) setIsSubmitting(false);
        }
    }

    return (
        <form className="publication-form" onSubmit={handleSubmit}>
            <div className="form-group">
                <label htmlFor="cno-name">Szervezet neve</label>
                <input
                    id="cno-name"
                    type="text"
                    value={name}
                    onChange={e => setName(e.target.value)}
                    onBlur={() => markTouched('name')}
                    className={touched.name && errors.name ? 'invalid-input' : ''}
                    placeholder="pl. Acme Kiadó"
                    maxLength={128}
                    autoFocus
                />
                {touched.name && errors.name && (
                    <div className="form-error">{errors.name}</div>
                )}
                {orgSlug && !errors.name && (
                    <div className="form-hint">
                        Azonosító: <code>{orgSlug}</code>
                    </div>
                )}
            </div>

            <div className="form-hint">
                Az új szervezetbe automatikusan létrejön egy „{DEFAULT_OFFICE_NAME}"
                szerkesztőség és 7 alapértelmezett csoport. Mindezt később
                átnevezheted, illetve további szerkesztőségeket adhatsz hozzá.
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
                    disabled={isSubmitting || hasErrors}
                >
                    {isSubmitting ? 'Létrehozás…' : 'Létrehozás'}
                </button>
            </div>
        </form>
    );
}
