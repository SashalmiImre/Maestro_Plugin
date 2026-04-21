/**
 * Maestro Dashboard — OrganizationSettingsModal
 *
 * A BreadcrumbDropdown „Beállítások" menüpontja nyitja meg az aktív
 * szervezet fölött. A tartalom két fülre bomlik (#26 / #27):
 *
 *   - Általános: szervezet neve, szerkesztőségek listája + „+ Új szerkesztőség"
 *     gomb, veszélyes zóna (kaszkád törlés konkrét számokkal).
 *   - Felhasználók: meghívó flow, függő meghívók, szerepkörönként csoportosított
 *     tagok.
 *
 * Az adatlekérést a shell végzi egyszer, majd leosztja a tab-oknak. A pending
 * meghívó listát a UsersTab triggerelheti frissíteni (`onInviteSent`).
 * Az aktív fül localStorage-ben perzisztált (`maestro.orgSettingsActiveTab`).
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Query } from 'appwrite';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { useData } from '../../contexts/DataContext.jsx';
import { useModal } from '../../contexts/ModalContext.jsx';
import { useTenantRealtimeRefresh } from '../../hooks/useTenantRealtimeRefresh.js';
import { DATABASE_ID, COLLECTIONS } from '../../config.js';
import Tabs from '../Tabs.jsx';
import AnimatedAutoHeight from '../AnimatedAutoHeight.jsx';
import GeneralTab from './GeneralTab.jsx';
import UsersTab from './UsersTab.jsx';

const TAB_DEFS = [
    { id: 'general', label: 'Általános' },
    { id: 'users', label: 'Felhasználók' }
];

const ACTIVE_TAB_STORAGE_KEY = 'maestro.orgSettingsActiveTab';

function getStoredTab() {
    try {
        const value = localStorage.getItem(ACTIVE_TAB_STORAGE_KEY);
        if (value && TAB_DEFS.some(t => t.id === value)) return value;
    } catch { /* SSR / quota / parse */ }
    return 'general';
}

/**
 * @param {Object} props
 * @param {string} props.organizationId — a kezelendő szervezet $id-ja
 * @param {string} [props.initialTab] — kezdeti fül override (különben a localStorage)
 */
export default function OrganizationSettingsModal({ organizationId, initialTab }) {
    const { user, organizations } = useAuth();
    const { databases } = useData();
    const { closeModal } = useModal();

    const org = organizations?.find(o => o.$id === organizationId) || null;

    const [activeTab, setActiveTab] = useState(() => initialTab || getStoredTab());

    const [members, setMembers] = useState([]);
    const [pendingInvites, setPendingInvites] = useState([]);
    const [offices, setOffices] = useState([]);
    const [userNameMap, setUserNameMap] = useState(new Map());
    const [callerRole, setCallerRole] = useState(null);
    const [publicationsCount, setPublicationsCount] = useState(0);
    const [articlesCount, setArticlesCount] = useState(0);
    const [isLoading, setIsLoading] = useState(true);
    const [loadError, setLoadError] = useState('');

    // Verseny-védelem: a scope-szűrt Realtime refresh + az explicit reloadInvites
    // egyidejűleg is futhat; csak a legutolsó invocation commit-olja a state-et.
    const loadGenRef = useRef(0);

    function handleTabChange(tabId) {
        setActiveTab(tabId);
        try { localStorage.setItem(ACTIVE_TAB_STORAGE_KEY, tabId); }
        catch { /* quota ignore */ }
    }

    // ─── Adatok betöltése ───────────────────────────────────────────
    const loadData = useCallback(async () => {
        if (!organizationId) {
            setIsLoading(false);
            return;
        }

        setLoadError('');
        const gen = ++loadGenRef.current;
        // Csak az első (mount) betöltésnél jelzünk loading-ot — a Realtime
        // reload közben a régi adatot tartjuk, nincs „Betöltés…" flash.
        // A state-törléseket is elhagyjuk: stale commit esetén a gen-őr szűr.
        if (gen === 1) setIsLoading(true);

        try {
            const [
                membersResult,
                invitesResult,
                officesResult,
                groupMembersResult,
                publicationsHead,
                articlesHead
            ] = await Promise.all([
                databases.listDocuments({
                    databaseId: DATABASE_ID,
                    collectionId: COLLECTIONS.ORGANIZATION_MEMBERSHIPS,
                    queries: [
                        Query.equal('organizationId', organizationId),
                        Query.limit(200)
                    ]
                }),
                databases.listDocuments({
                    databaseId: DATABASE_ID,
                    collectionId: COLLECTIONS.ORGANIZATION_INVITES,
                    queries: [
                        Query.equal('organizationId', organizationId),
                        Query.equal('status', 'pending'),
                        Query.limit(100)
                    ]
                }),
                databases.listDocuments({
                    databaseId: DATABASE_ID,
                    collectionId: COLLECTIONS.EDITORIAL_OFFICES,
                    queries: [
                        Query.equal('organizationId', organizationId),
                        Query.limit(100)
                    ]
                }),
                databases.listDocuments({
                    databaseId: DATABASE_ID,
                    collectionId: COLLECTIONS.GROUP_MEMBERSHIPS,
                    queries: [
                        Query.equal('organizationId', organizationId),
                        Query.limit(500)
                    ]
                }),
                // A kaszkád meghívó dialógushoz csak a total kell — limit(1) + total.
                databases.listDocuments({
                    databaseId: DATABASE_ID,
                    collectionId: COLLECTIONS.PUBLICATIONS,
                    queries: [
                        Query.equal('organizationId', organizationId),
                        Query.limit(1)
                    ]
                }),
                databases.listDocuments({
                    databaseId: DATABASE_ID,
                    collectionId: COLLECTIONS.ARTICLES,
                    queries: [
                        Query.equal('organizationId', organizationId),
                        Query.limit(1)
                    ]
                })
            ]);

            if (gen !== loadGenRef.current) return;

            setMembers(membersResult.documents);
            setPendingInvites(invitesResult.documents);
            setOffices(officesResult.documents.sort(
                (a, b) => (a.name || '').localeCompare(b.name || '', 'hu')
            ));
            setPublicationsCount(publicationsHead.total ?? 0);
            setArticlesCount(articlesHead.total ?? 0);

            const myMembership = membersResult.documents.find(m => m.userId === user?.$id);
            setCallerRole(myMembership?.role || null);

            const nameMap = new Map();
            for (const gm of groupMembersResult.documents) {
                if (!nameMap.has(gm.userId)) {
                    nameMap.set(gm.userId, {
                        name: gm.userName || null,
                        email: gm.userEmail || null
                    });
                }
            }
            setUserNameMap(nameMap);
        } catch (err) {
            if (gen !== loadGenRef.current) return;
            console.error('[OrganizationSettingsModal] Adatok betöltése sikertelen:', err);
            setLoadError('Hiba az adatok betöltésekor.');
        } finally {
            if (gen === loadGenRef.current) setIsLoading(false);
        }
    }, [organizationId, user?.$id, databases]);

    useEffect(() => {
        loadData();
    }, [loadData]);

    // Scope-szűrt Realtime refresh: csak az ehhez az `organizationId`-hez tartozó
    // groups / groupMemberships / organizationInvites event-ek triggerelik a
    // reload-ot (300 ms debounce a hook-ban).
    useTenantRealtimeRefresh({
        scopeField: 'organizationId',
        scopeId: organizationId,
        reload: loadData
    });

    /** Csak a pending invite listát frissítjük (UsersTab-ból új meghívó után). */
    const reloadInvites = useCallback(async () => {
        if (!organizationId) return;
        try {
            const result = await databases.listDocuments({
                databaseId: DATABASE_ID,
                collectionId: COLLECTIONS.ORGANIZATION_INVITES,
                queries: [
                    Query.equal('organizationId', organizationId),
                    Query.equal('status', 'pending'),
                    Query.limit(100)
                ]
            });
            setPendingInvites(result.documents);
        } catch { loadData(); }
    }, [organizationId, databases, loadData]);

    // ─── Render ─────────────────────────────────────────────────────

    if (!organizationId || !org) {
        return (
            <div className="publication-form">
                <div className="form-empty-state">
                    A szervezet nem található vagy törölve lett.
                </div>
                <div className="modal-actions">
                    <button type="button" className="btn-secondary" onClick={closeModal}>
                        Bezárás
                    </button>
                </div>
            </div>
        );
    }

    if (isLoading) {
        return (
            <div className="publication-form">
                <div className="form-empty-state">Betöltés…</div>
            </div>
        );
    }

    return (
        <div className="publication-settings-modal">
            <Tabs tabs={TAB_DEFS} activeTab={activeTab} onTabChange={handleTabChange} />

            <AnimatedAutoHeight>
                <div className="publication-tab-content">
                    {loadError && (
                        <div className="login-error" style={{ marginBottom: 12 }}>{loadError}</div>
                    )}

                    {activeTab === 'general' && (
                        <GeneralTab
                            org={org}
                            callerRole={callerRole}
                            offices={offices}
                            membersCount={members.length}
                            pendingInvitesCount={pendingInvites.length}
                            publicationsCount={publicationsCount}
                            articlesCount={articlesCount}
                        />
                    )}

                    {activeTab === 'users' && (
                        <UsersTab
                            org={org}
                            callerRole={callerRole}
                            members={members}
                            pendingInvites={pendingInvites}
                            userNameMap={userNameMap}
                            onInviteSent={reloadInvites}
                        />
                    )}
                </div>
            </AnimatedAutoHeight>
        </div>
    );
}
