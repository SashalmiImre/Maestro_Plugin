/**
 * Maestro Dashboard — OrganizationOrphanedView (D.2.3, 2026-05-09)
 *
 * Egy szervezet "fagyasztott" állapotba kerül két scenárió szerint:
 *  - `status === 'orphaned'` — az utolsó owner törölte magát
 *    (`user-cascade-delete` v5+ írja ki a marker-t a [[D.2.2]] szerint),
 *    recovery a `transfer_orphaned_org_ownership` action-nel.
 *  - `status === 'archived'` — admin szándékos archiválás
 *    (jövőbeli admin-flow; backend write-blocked).
 *
 * Mindkét állapotban az `userHasOrgPermission()` orphan-guard 403-mal ad
 * vissza minden `org.*` write-műveletet — ez a view UI-szinten tisztázza
 * a helyzetet a "minden gomb 403"-os zavar megelőzéséhez.
 *
 * A view NEM redirect (Codex Q3 review): az org látható marad a felhasználó
 * scope-jában, hogy az admin recovery flow azonosítható legyen. A user másik
 * elérhető (NEM fagyasztott) org-ra válthat, vagy kijelentkezhet.
 */

import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext.jsx';
import { useScope } from '../contexts/ScopeContext.jsx';
import BrandHero from './auth/BrandHero.jsx';

const ADMIN_CONTACT_EMAIL = 'admin@maestro.emago.hu';

// Codex simplify Q10 (2026-05-09): a `orphanedOrg` props redundáns volt — a
// view az `useScope().activeOrganizationId` + `useAuth().organizations`-ból
// maga ki tudja számolni, melyik org a fagyasztott. A `ProtectedRoute`
// `<Outlet/>` helyett egyszerűen `<OrganizationOrphanedView />`-t renderel.
//
// TODO(D-blokk follow-up — shared `orgStatus` modul): a `FROZEN_STATUSES` Set
// és a per-status copy duplikálja a backend `ORG_STATUS` + `isOrgWriteBlocked()`
// helpereket (`packages/maestro-server/.../permissions.js`). Egy következő
// session emelje a `ORG_STATUS` const-pack-et `packages/maestro-shared/`-be
// (a `compiledValidator` build-pipeline mintáját követve), és a frontend +
// 3 érintett CF váltson erre.
const FROZEN_STATUSES = new Set(['orphaned', 'archived']);

const STATUS_COPY = {
    orphaned: {
        heading: 'A szervezet adminisztrátor nélkül maradt',
        explain: (name) =>
            `A ${name} szervezet utolsó tulajdonosa törölte a saját fiókját, ezért a szervezet jelenleg árva állapotban van. Új meghívót küldeni, csoportot szerkeszteni vagy egyéb adminisztratív műveletet végrehajtani nem lehetséges, amíg új tulajdonos kerül kijelölésre.`
    },
    archived: {
        heading: 'A szervezet archivált állapotban van',
        explain: (name) =>
            `A ${name} szervezet archivált állapotban van. Új meghívót küldeni, csoportot szerkeszteni vagy egyéb adminisztratív műveletet végrehajtani nem lehetséges, amíg vissza nem aktiválják.`
    }
};

export default function OrganizationOrphanedView() {
    const { organizations, logout } = useAuth();
    const { activeOrganizationId, setActiveOrganization } = useScope();
    const navigate = useNavigate();

    const orgList = organizations || [];
    const frozenOrg = orgList.find((o) => o.$id === activeOrganizationId);
    if (!frozenOrg) return null; // defensive: a ProtectedRoute frozen-state nélkül NEM rendereli

    // A filter minden fagyasztott státuszt kizár (orphaned + archived) — ne
    // ajánljunk váltást olyan orgra, ami szintén write-blocked.
    const otherOrgs = orgList.filter(
        (o) => o.$id !== frozenOrg.$id && !FROZEN_STATUSES.has(o.status)
    );

    const copy = STATUS_COPY[frozenOrg.status] || STATUS_COPY.orphaned;
    const heading = copy.heading;
    const explanation = copy.explain(frozenOrg.name);

    async function handleLogout() {
        await logout();
        navigate('/login', { replace: true });
    }

    function handleSwitch(orgId) {
        setActiveOrganization(orgId);
        // A scope váltás után a ProtectedRoute újra-renderel az új active org-gal,
        // és (ha az `active`) az `<Outlet />` jön vissza.
    }

    return (
        <div className="login-container">
            <BrandHero />
            <div className="login-card auth-error-card">
                <div className="form-heading">{heading}</div>
                <p className="auth-help">{explanation}</p>
                <p className="auth-help" style={{ marginTop: 12 }}>
                    A helyreállításért fordulj a Maestro üzemeltetőhöz:{' '}
                    <a href={`mailto:${ADMIN_CONTACT_EMAIL}`}>{ADMIN_CONTACT_EMAIL}</a>
                </p>

                {otherOrgs.length > 0 && (
                    <>
                        <div style={{ marginTop: 20, marginBottom: 8, fontSize: 13, fontWeight: 600 }}>
                            Másik elérhető szervezeted:
                        </div>
                        <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                            {otherOrgs.map((o) => (
                                <li key={o.$id} style={{ padding: '6px 0' }}>
                                    <button
                                        type="button"
                                        className="auth-link auth-link-button"
                                        onClick={() => handleSwitch(o.$id)}
                                    >
                                        {o.name}
                                    </button>
                                </li>
                            ))}
                        </ul>
                    </>
                )}

                <div className="auth-bottom-link" style={{ marginTop: 20 }}>
                    <button
                        type="button"
                        className="auth-link auth-link-button"
                        onClick={handleLogout}
                    >
                        Kijelentkezés
                    </button>
                </div>
            </div>
        </div>
    );
}
