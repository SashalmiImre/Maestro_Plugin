/**
 * Maestro Dashboard — useBlockerConfirm
 *
 * A react-router-dom v6 `useBlocker` és a közös `useConfirm()`
 * integrációja. Amikor a blocker `'blocked'` állapotra vált (a hívó által
 * megadott predikátum trigger-elte), megnyit egy közös ConfirmDialog-ot;
 * a user válasza alapján `blocker.proceed()` (Elhagyom) vagy
 * `blocker.reset()` (Maradok). A `cancelled` flag védi a stale
 * Promise-resolve-ot, ha a blocker közben magától reset-elődik.
 *
 * Két korábbi call-site duplikációját váltja ki:
 * `WorkflowDesignerPage` (workflow dirty-state) és `SettingsPasswordRoute`
 * (jelszómező dirty-state). Az effect deps `[blocker.state, confirm]` —
 * a `blocker` objektum referencia minden render-en új a router v6-ban,
 * deps-be véve blocked-állapotban duplikált confirm modalt nyitna.
 */

import { useEffect } from 'react';
import { useConfirm } from '../components/ConfirmDialog.jsx';

export function useBlockerConfirm(blocker, { title, message, confirmLabel, cancelLabel = 'Maradok', variant = 'danger' }) {
    const confirm = useConfirm();
    useEffect(() => {
        if (blocker.state !== 'blocked') return;
        let cancelled = false;
        (async () => {
            const proceed = await confirm({ title, message, confirmLabel, cancelLabel, variant });
            if (cancelled) return;
            if (proceed) blocker.proceed?.();
            else blocker.reset?.();
        })();
        return () => { cancelled = true; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [blocker.state, confirm]);
}
