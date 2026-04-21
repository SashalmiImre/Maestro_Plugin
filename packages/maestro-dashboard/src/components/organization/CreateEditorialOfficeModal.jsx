/**
 * Maestro Dashboard — CreateEditorialOfficeModal
 *
 * Új szerkesztőség létrehozása egy meglévő szervezeten belül.
 * Az OrganizationSettingsModal Általános tab-jának „+ Új szerkesztőség"
 * gombja nyitja meg.
 *
 * Mezők:
 *   - Név (kötelező)
 *   - Workflow (opcionális — a szervezet bármely office-ának workflow-ja klónozható)
 *
 * Sikeres létrehozáskor: toast + automatikus scope váltás az új office-ra
 * (amennyiben a caller ezt kérte), majd a modal bezárul.
 */

import React, { useState, useMemo, useEffect, useRef } from 'react';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { useData } from '../../contexts/DataContext.jsx';
import { useModal } from '../../contexts/ModalContext.jsx';
import { useToast } from '../../contexts/ToastContext.jsx';
import { useScope } from '../../contexts/ScopeContext.jsx';

function errorMessage(code) {
    if (typeof code !== 'string') return 'Ismeretlen hiba történt.';
    if (code.includes('missing_fields')) return 'Tölts ki minden kötelező mezőt.';
    if (code.includes('invalid_name')) return 'A név nem lehet üres és nem haladhatja meg a 128 karaktert.';
    if (code.includes('insufficient_role')) return 'Nincs jogosultságod új szerkesztőség létrehozásához.';
    if (code.includes('not_a_member')) return 'Nem vagy tagja a szervezetnek.';
    if (code.includes('office_slug_taken')) return 'A névhez generált azonosító ütközik — próbáld más névvel.';
    if (code.includes('source_workflow_not_found')) return 'A kiválasztott workflow már nem elérhető.';
    if (code.includes('source_workflow_scope_mismatch')) return 'A kiválasztott workflow másik szervezethez tartozik.';
    if (code.includes('source_workflow_fetch_failed')) return 'A kiválasztott workflow lekérése sikertelen. Próbáld újra.';
    if (code.includes('office_create_failed')) return 'A szerkesztőség létrehozása sikertelen. Próbáld újra.';
    if (code.includes('office_membership_create_failed')) return 'A szerkesztőség létrejött, de a tagság létrehozása sikertelen. Próbáld újra.';
    if (code.includes('group_memberships_create_failed')) return 'A csoporttagságok létrehozása sikertelen. Próbáld újra.';
    if (code.includes('groups_create_failed')) return 'A csoportok létrehozása sikertelen. Próbáld újra.';
    if (code.includes('Failed to fetch') || code.includes('NetworkError')) {
        return 'Hálózati hiba. Ellenőrizd a kapcsolatot, és próbáld újra.';
    }
    return code;
}

/**
 * @param {Object} props
 * @param {string} props.organizationId — a szülő szervezet $id-ja
 * @param {boolean} [props.switchScopeOnSuccess=true] — sikeres létrehozás után
 *   az új office-ra váltson-e a ScopeContext (alapértelmezett: igen)
 */
export default function CreateEditorialOfficeModal({ organizationId, switchScopeOnSuccess = true }) {
    const { createEditorialOffice, reloadMemberships } = useAuth();
    const { fetchAllOrgWorkflows } = useData();
    const { closeModal } = useModal();
    const { showToast } = useToast();
    const { setActiveOffice } = useScope();

    const [name, setName] = useState('');
    const [sourceWorkflowId, setSourceWorkflowId] = useState('');
    const [workflows, setWorkflows] = useState([]);
    const [workflowsLoading, setWorkflowsLoading] = useState(true);
    const [touched, setTouched] = useState({});
    const [submitError, setSubmitError] = useState('');
    const [isSubmitting, setIsSubmitting] = useState(false);

    // Mounted guard — a ModalContext scope-auto-close effekt a nyitott modalt
    // unmountolja, mikor a `setActiveOffice(newId)` átvált. A `finally` blokkban
    // futó `setIsSubmitting(false)` unmounted komponensen React warningot adna.
    // Why: React 18 Strict Mode dev-ben szimulált mount/unmount/mount szekvenciát
    // futtat — ha csak cleanup-ban állítanánk false-ra, az első szimulált unmount
    // után a ref véglegesen false maradna, a guardok hamisan skipelnék a setXXX-et.
    const isMountedRef = useRef(true);
    useEffect(() => {
        isMountedRef.current = true;
        return () => { isMountedRef.current = false; };
    }, []);

    // Org-szintű workflow lista (cross-office klón forrás). A scope-szűrt
    // `useData().workflows` helyett a `fetchAllOrgWorkflows` opt-in helper —
    // multi-office admin is látja más office `editorial_office` scope-ú workflow-it.
    // A try/finally a `workflowsLoading` flag-et akkor is felszabadítja, ha a helper
    // szinkron hibát dob (provider-bug, stale ref) — a modal nem marad loading-ban.
    useEffect(() => {
        let cancelled = false;
        (async () => {
            setWorkflowsLoading(true);
            try {
                const sorted = await fetchAllOrgWorkflows(organizationId);
                if (!cancelled) setWorkflows(sorted);
            } catch (err) {
                if (!cancelled) {
                    console.warn('[CreateEditorialOfficeModal] workflow lista hiba:', err);
                    setWorkflows([]);
                }
            } finally {
                if (!cancelled) setWorkflowsLoading(false);
            }
        })();
        return () => { cancelled = true; };
    }, [fetchAllOrgWorkflows, organizationId]);

    // ─── Validáció ──────────────────────────────────────────────────────────
    const errors = useMemo(() => {
        const next = {};
        if (!name.trim()) next.name = 'A név nem lehet üres.';
        else if (name.trim().length > 128) next.name = 'A név legfeljebb 128 karakter lehet.';
        return next;
    }, [name]);

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

        try {
            const response = await createEditorialOffice(
                organizationId,
                name.trim(),
                sourceWorkflowId || undefined
            );

            // Memberships frissítése — a ScopeContext auto-pick és a GeneralTab
            // office-lista attól függ, hogy a useAuth().editorialOffices tartalmazza
            // az új rekordot. Ha a reload elbukott, NEM váltunk scope-ot a friss
            // ID-ra (a ScopeContext stale-protection amúgy is visszadobná) — a
            // user egy figyelmeztetést kap, hogy a létrehozás sikeres, de a lista
            // szinkron nem sikerült.
            const membershipsReloaded = await reloadMemberships();

            if (membershipsReloaded) {
                if (switchScopeOnSuccess && response.editorialOfficeId) {
                    setActiveOffice(response.editorialOfficeId);
                }
                showToast(`„${name.trim()}" szerkesztőség létrehozva.`, 'success');
            } else {
                showToast(
                    `„${name.trim()}" szerkesztőség létrehozva, de a lista szinkron sikertelen. Frissítsd az oldalt.`,
                    'warning'
                );
            }
            closeModal();
        } catch (err) {
            console.error('[CreateEditorialOfficeModal] Létrehozás hiba:', err);
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
                <label htmlFor="ceo-name">Név</label>
                <input
                    id="ceo-name"
                    type="text"
                    value={name}
                    onChange={e => setName(e.target.value)}
                    onBlur={() => markTouched('name')}
                    className={touched.name && errors.name ? 'invalid-input' : ''}
                    placeholder="pl. Nők Lapja"
                    maxLength={128}
                    autoFocus
                />
                {touched.name && errors.name && (
                    <div className="form-error">{errors.name}</div>
                )}
            </div>

            <div className="form-group">
                <label htmlFor="ceo-workflow">Workflow (opcionális)</label>
                <select
                    id="ceo-workflow"
                    className="form-select"
                    value={sourceWorkflowId}
                    onChange={e => setSourceWorkflowId(e.target.value)}
                    disabled={workflowsLoading || workflows.length === 0}
                >
                    <option value="">
                        {workflowsLoading
                            ? 'Workflow-k betöltése…'
                            : workflows.length === 0
                                ? '— Nincs elérhető workflow —'
                                : '— Workflow nélkül —'}
                    </option>
                    {workflows.map(wf => (
                        <option key={wf.$id} value={wf.$id}>{wf.name}</option>
                    ))}
                </select>
                <div className="form-hint">
                    Ha workflow-t választasz, a compiled JSON klónozódik az új szerkesztőség
                    alá. Később a Workflow tab-on módosítható vagy lecserélhető.
                </div>
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
