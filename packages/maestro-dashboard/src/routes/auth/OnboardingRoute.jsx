/**
 * Maestro Dashboard — OnboardingRoute (B.5 — éles 4-collection write)
 *
 * Az `/onboarding` route. Az első belépéskor itt hoz létre a user új
 * organization-t és editorial office-t (4-collection write az AuthContext
 * `createOrganization`-on keresztül), VAGY ha a localStorage tartalmaz
 * pending invite tokent, fel tudja ajánlani a meghívó elfogadását
 * (`acceptInvite()` → `invite-to-organization` CF accept ág).
 *
 * Ha az új org létrejött, a ScopeContext aktívvá teszi → navigate('/').
 *
 * Kijelentkezés gomb a card alján marad — escape hatch, ha a user
 * mégsem akarja most ezt a flow-t.
 *
 * B.5 review javítások (2026-04-07):
 * - Form konvenció: a többi auth route-hoz igazodva `form-group` + `login-error`
 *   class-okat használjuk (az előző `auth-form` / `form-label` / `auth-error`
 *   class-ok nem léteztek a styles.css-ben → a form unstyled volt).
 * - Slug mezők HTML5 `pattern` attribútuma pontosan a szerver-oldali
 *   `SLUG_REGEX`-hez igazítva, hogy a kliens validáció ne legyen lazább.
 * - `errorMessage()` kibővítve az összes CF hibakóddal.
 * - Submit előtti ellenőrzés: a `slugify()` után üres slugok lokálisan
 *   elakadnak (pl. ha a user csak emojit vagy nem-ASCII karaktert ír).
 */

import React, { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { useScope } from '../../contexts/ScopeContext.jsx';

const PENDING_INVITE_KEY = 'maestro.pendingInviteToken';

// A szerver-oldali szabály tükre — invite-to-organization CF SLUG_REGEX.
// Anchor-ok nélkül, mert a HTML5 `pattern` attribútum implicit ^/$-ra zár.
const SLUG_PATTERN = '[a-z0-9]+(-[a-z0-9]+)*';
const SLUG_REGEX = new RegExp(`^${SLUG_PATTERN}$`);

/**
 * Slug-ifikálás a szerver-oldali `SLUG_REGEX`-kompatibilis kimenettel:
 * kisbetű + ékezet eltávolítás, minden nem-alfanumerikus karakter-szekvencia
 * egyetlen kötőjellé, elöl/hátul levágva, max 64 karakter.
 *
 * Mivel a `+` kvantor már összevonja a duplakötőjelet, a kimenet mindig
 * megfelel az `^[a-z0-9]+(-[a-z0-9]+)*$` mintának (ha a bemenet nem üres).
 */
function slugify(text) {
    return (text || '')
        .toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // ékezet eltávolítás
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 64)
        .replace(/-+$/, ''); // a slice után esetlegesen visszamaradt záró kötőjel
}

/**
 * Magyar hibaüzenet a CF/Appwrite hibakódokhoz. A CF minden ismert
 * `reason` értékét lefedjük, hogy a user ne „Ismeretlen hiba"-t kapjon.
 */
function errorMessage(err) {
    const code = err?.code || err?.message || '';
    if (typeof code !== 'string') return 'Ismeretlen hiba történt. Próbáld újra.';

    // ── Bootstrap + általános szerver-oldali ellenőrzések
    if (code.includes('missing_fields')) return 'Tölts ki minden kötelező mezőt.';
    if (code.includes('invalid_slug')) {
        return 'A slug csak kisbetűt, számot és kötőjelet tartalmazhat, és nem kezdődhet/végződhet kötőjellel.';
    }
    if (code.includes('invalid_email')) return 'Érvénytelen e-mail cím formátum.';
    if (code.includes('invalid_role')) return 'Érvénytelen szerepkör.';
    if (code.includes('invalid_action')) return 'Ismeretlen művelet. (Fejlesztői hiba.)';
    if (code.includes('invalid_payload')) return 'Érvénytelen kérés formátum.';
    if (code.includes('invalid_response')) return 'A szerver válasza feldolgozhatatlan volt. Próbáld újra.';

    // ── Slug ütközések (bootstrap action)
    if (code.includes('org_slug_taken')) return 'Már létezik szervezet ezzel a slug-gal. Válassz másikat.';
    if (code.includes('office_slug_taken')) return 'Már létezik szerkesztőség ezzel a slug-gal. Válassz másikat.';
    if (code.includes('document_already_exists') || /\bunique\b/i.test(code)) {
        return 'Már létezik szervezet ezzel a slug-gal. Válassz másikat.';
    }

    // ── Bootstrap szerver-oldali hibák
    if (code.includes('org_create_failed')) return 'A szervezet létrehozása sikertelen. Próbáld újra.';
    if (code.includes('membership_create_failed')) return 'A tagság létrehozása sikertelen. Próbáld újra.';
    if (code.includes('office_create_failed')) return 'A szerkesztőség létrehozása sikertelen. Próbáld újra.';
    if (code.includes('office_membership_create_failed')) return 'A szerkesztőségi tagság létrehozása sikertelen. Próbáld újra.';
    if (code.includes('bootstrap_failed')) return 'A szervezet létrehozása sikertelen. Próbáld újra.';

    // ── Invite create (Fázis 6 admin UI-ból hívva)
    if (code.includes('not_a_member')) return 'Nem vagy tagja ennek a szervezetnek.';
    if (code.includes('insufficient_role')) return 'Nincs jogod meghívót küldeni ebben a szervezetben.';

    // ── Invite accept
    if (code.includes('invite_not_found')) return 'A meghívó nem található. Lehet, hogy hibás a link.';
    if (code.includes('invite_not_pending')) return 'Ezt a meghívót már elfogadták vagy visszavonták.';
    if (code.includes('invite_expired')) return 'A meghívó lejárt. Kérj egy újat az adminisztrátortól.';
    if (code.includes('email_mismatch')) return 'Ez a meghívó egy másik e-mail címre szól. Jelentkezz be a megfelelő fiókkal.';
    if (code.includes('caller_lookup_failed')) return 'Nem sikerült a felhasználó adatait ellenőrizni. Próbáld újra.';

    // ── Auth / session
    if (code.includes('not_authenticated') || code === 'unauthenticated') {
        return 'A munkamenet lejárt. Jelentkezz be újra.';
    }
    if (code.includes('missing_token')) return 'Hiányzik a meghívó token. Nyisd meg újra a meghívó linket.';

    // ── Hálózat
    if (code.includes('Failed to fetch') || code.includes('NetworkError')) {
        return 'Hálózati hiba. Ellenőrizd a kapcsolatot, és próbáld újra.';
    }

    return err?.message || 'Ismeretlen hiba történt. Próbáld újra.';
}

export default function OnboardingRoute() {
    const { user, logout, createOrganization, acceptInvite } = useAuth();
    const { setActiveOrganization, setActiveOffice } = useScope();
    const navigate = useNavigate();

    // Pending invite token a localStorage-ből
    const [pendingToken, setPendingToken] = useState(() => {
        try { return localStorage.getItem(PENDING_INVITE_KEY); } catch { return null; }
    });

    // Form state
    const [orgName, setOrgName] = useState('');
    const [orgSlug, setOrgSlug] = useState('');
    const [orgSlugTouched, setOrgSlugTouched] = useState(false);
    const [officeName, setOfficeName] = useState('');
    const [officeSlug, setOfficeSlug] = useState('');
    const [officeSlugTouched, setOfficeSlugTouched] = useState(false);

    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState('');

    // Auto slug generálás, ha a felhasználó még nem nyúlt hozzá a slug mezőhöz
    useEffect(() => {
        if (!orgSlugTouched) setOrgSlug(slugify(orgName));
    }, [orgName, orgSlugTouched]);

    useEffect(() => {
        if (!officeSlugTouched) setOfficeSlug(slugify(officeName));
    }, [officeName, officeSlugTouched]);

    const handleLogout = useCallback(async () => {
        await logout();
        navigate('/login', { replace: true });
    }, [logout, navigate]);

    const handleSubmit = useCallback(async (e) => {
        e.preventDefault();
        setError('');

        const trimmedOrgName = orgName.trim();
        const trimmedOfficeName = officeName.trim();
        const trimmedOrgSlug = orgSlug.trim();
        const trimmedOfficeSlug = officeSlug.trim();

        if (!trimmedOrgName || !trimmedOfficeName) {
            setError('Tölts ki minden kötelező mezőt.');
            return;
        }
        if (!trimmedOrgSlug || !trimmedOfficeSlug) {
            setError('A slug mezők nem lehetnek üresek. Használj kisbetűt, számot és kötőjelet.');
            return;
        }
        if (!SLUG_REGEX.test(trimmedOrgSlug) || !SLUG_REGEX.test(trimmedOfficeSlug)) {
            setError('A slug csak kisbetűt, számot és kötőjelet tartalmazhat, és nem kezdődhet/végződhet kötőjellel.');
            return;
        }

        setSubmitting(true);
        try {
            const result = await createOrganization(
                trimmedOrgName,
                trimmedOrgSlug,
                trimmedOfficeName,
                trimmedOfficeSlug
            );
            // Az új org+office aktívvá tétele
            setActiveOrganization(result.organizationId);
            setActiveOffice(result.editorialOfficeId);
            navigate('/', { replace: true });
        } catch (err) {
            console.warn('[OnboardingRoute] createOrganization sikertelen:', err);
            setError(errorMessage(err));
        } finally {
            setSubmitting(false);
        }
    }, [orgName, orgSlug, officeName, officeSlug, createOrganization, setActiveOrganization, setActiveOffice, navigate]);

    const handleAcceptInvite = useCallback(async () => {
        if (!pendingToken) return;
        setError('');
        setSubmitting(true);
        try {
            const result = await acceptInvite(pendingToken);
            setActiveOrganization(result.organizationId);
            // Office aktiválás itt nem történik — az invite csak org-ra szól;
            // a B.7 plugin DataContext fogja az első office-t aktívvá tenni,
            // vagy a Fázis 6 admin UI ad külön office-választót.
            setPendingToken(null);
            navigate('/', { replace: true });
        } catch (err) {
            console.warn('[OnboardingRoute] acceptInvite sikertelen:', err);
            setError(errorMessage(err));
            // Ha a token hibás vagy lejárt, töröljük localStorage-ből, hogy ne ragadjon
            if (err?.code && (err.code.includes('invite_not_found') ||
                              err.code.includes('invite_expired') ||
                              err.code.includes('invite_not_pending') ||
                              err.code.includes('email_mismatch'))) {
                try { localStorage.removeItem(PENDING_INVITE_KEY); } catch { /* nem baj */ }
                setPendingToken(null);
            }
        } finally {
            setSubmitting(false);
        }
    }, [pendingToken, acceptInvite, setActiveOrganization, navigate]);

    const handleDismissInvite = useCallback(() => {
        try { localStorage.removeItem(PENDING_INVITE_KEY); } catch { /* nem baj */ }
        setPendingToken(null);
        setError('');
    }, []);

    return (
        <div className="login-card">
            <div className="form-heading">Üdv a Maestro-nál, {user?.name}</div>

            {pendingToken && (
                <>
                    <p className="auth-info">
                        Egy meghívó vár az elfogadásodra. Kattints az alábbi gombra a csatlakozáshoz.
                    </p>
                    <button
                        type="button"
                        className="login-btn"
                        onClick={handleAcceptInvite}
                        disabled={submitting}
                    >
                        {submitting ? 'Folyamatban...' : 'Meghívó elfogadása'}
                    </button>
                    <button
                        type="button"
                        className="auth-link-button"
                        onClick={handleDismissInvite}
                        disabled={submitting}
                    >
                        Inkább új szervezetet hozok létre
                    </button>
                    {error && <div className="login-error">{error}</div>}
                </>
            )}

            {!pendingToken && (
                <form onSubmit={handleSubmit}>
                    <p className="auth-help">
                        Még nincs szervezeted. Hozz létre egyet, és add hozzá az első szerkesztőséget.
                    </p>

                    <div className="form-group">
                        <label htmlFor="onb-org-name">Szervezet neve</label>
                        <input
                            id="onb-org-name"
                            type="text"
                            value={orgName}
                            onChange={(e) => setOrgName(e.target.value)}
                            disabled={submitting}
                            required
                            autoFocus
                            maxLength={128}
                        />
                    </div>

                    <div className="form-group">
                        <label htmlFor="onb-org-slug">Szervezet slug</label>
                        <input
                            id="onb-org-slug"
                            type="text"
                            value={orgSlug}
                            onChange={(e) => { setOrgSlug(e.target.value); setOrgSlugTouched(true); }}
                            disabled={submitting}
                            required
                            pattern={SLUG_PATTERN}
                            maxLength={64}
                            title="Csak kisbetű, szám és kötőjel. Nem kezdődhet/végződhet kötőjellel."
                        />
                    </div>

                    <div className="form-group">
                        <label htmlFor="onb-office-name">Szerkesztőség neve</label>
                        <input
                            id="onb-office-name"
                            type="text"
                            value={officeName}
                            onChange={(e) => setOfficeName(e.target.value)}
                            disabled={submitting}
                            required
                            maxLength={128}
                        />
                    </div>

                    <div className="form-group">
                        <label htmlFor="onb-office-slug">Szerkesztőség slug</label>
                        <input
                            id="onb-office-slug"
                            type="text"
                            value={officeSlug}
                            onChange={(e) => { setOfficeSlug(e.target.value); setOfficeSlugTouched(true); }}
                            disabled={submitting}
                            required
                            pattern={SLUG_PATTERN}
                            maxLength={64}
                            title="Csak kisbetű, szám és kötőjel. Nem kezdődhet/végződhet kötőjellel."
                        />
                    </div>

                    <button type="submit" className="login-btn" disabled={submitting}>
                        {submitting ? 'Létrehozás...' : 'Szervezet létrehozása'}
                    </button>

                    {error && <div className="login-error">{error}</div>}
                </form>
            )}

            <button
                type="button"
                className="auth-link-button"
                onClick={handleLogout}
                disabled={submitting}
            >
                Kijelentkezés
            </button>
        </div>
    );
}
