/**
 * Maestro Dashboard — OrganizationOrphanedView (D.2.3, 2026-05-09)
 *
 * Egy szervezet `status === 'orphaned'` állapotba kerül, ha az utolsó owner-je
 * törölte magát (`user-cascade-delete` v5+ írja ki a marker-t a [[D.2.2]] szerint).
 * Ez az állapot adat-konzisztencia gap: a tagok nem tudnak permission set-et
 * szerkeszteni, új user-t hívni stb. — az `userHasOrgPermission()` orphan-guard
 * minden `org.*` write-műveletet 403-mal ad vissza.
 *
 * A view NEM redirect (Codex Q3 review): az org látható marad a felhasználó
 * scope-jában, hogy az admin recovery flow (`transfer_orphaned_org_ownership`)
 * azonosítható legyen. A user másik elérhető org-ra válthat, vagy
 * kijelentkezhet.
 */

import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext.jsx';
import { useScope } from '../contexts/ScopeContext.jsx';
import BrandHero from './auth/BrandHero.jsx';

const ADMIN_CONTACT_EMAIL = 'admin@maestro.emago.hu';

// Codex simplify Q10 (2026-05-09): a `orphanedOrg` props redundáns volt — a
// view az `useScope().activeOrganizationId` + `useAuth().organizations`-ból
// maga ki tudja számolni, mely org az árva. A `ProtectedRoute` `<Outlet/>`
// helyett egyszerűen `<OrganizationOrphanedView />`-t renderel.
export default function OrganizationOrphanedView() {
    const { organizations, logout } = useAuth();
    const { activeOrganizationId, setActiveOrganization } = useScope();
    const navigate = useNavigate();

    const orphanedOrg = (organizations || []).find((o) => o.$id === activeOrganizationId);
    if (!orphanedOrg) return null; // defensive: a ProtectedRoute orphan-state nélkül NEM rendereli

    const otherOrgs = (organizations || []).filter(
        (o) => o.$id !== orphanedOrg.$id && o.status !== 'orphaned'
    );

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
                <div className="form-heading">A szervezet adminisztrátor nélkül maradt</div>
                <p className="auth-help">
                    A <strong>{orphanedOrg.name}</strong> szervezet utolsó tulajdonosa törölte
                    a saját fiókját, ezért a szervezet jelenleg árva állapotban van. Új meghívót
                    küldeni, csoportot szerkeszteni vagy egyéb adminisztratív műveletet végrehajtani
                    nem lehetséges, amíg új tulajdonos kerül kijelölésre.
                </p>
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
