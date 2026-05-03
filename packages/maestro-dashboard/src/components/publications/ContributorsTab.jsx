/**
 * Maestro Dashboard — ContributorsTab
 *
 * A PublicationSettingsModal „Közreműködők" füle. A plugin ContributorsSection
 * portja. Dinamikus csoportdropdown-ok a `useContributorGroups` hook-ból.
 *
 * A kiadvány `defaultContributors` JSON mezőjét (slug → userId mapping) szerkeszti.
 * Új alapértelmezett személy beállításakor felajánlja a meglévő cikkek
 * smart frissítését — csak azokat a cikkeket érinti, ahol az adott szerepkör
 * értéke még null.
 */

import React, { useState, useCallback, useMemo } from 'react';
import { useData } from '../../contexts/DataContext.jsx';
import { useContributorGroups } from '../../hooks/useContributorGroups.js';
import { useToast } from '../../contexts/ToastContext.jsx';
import { useConfirm } from '../ConfirmDialog.jsx';
import { getContributor, setContributor } from '@shared/contributorHelpers.js';
import { resolvePublicationCompiled } from '@shared/parseCompiledWorkflow.js';

export default function ContributorsTab({ publication }) {
    // A.4.9 (ADR 0008): a kiadvány `compiledWorkflowSnapshot.requiredGroupSlugs[]`
    // sorrendje a kanonikus rendezés a contributor dropdown-okhoz. Ha nincs
    // snapshot (nem-aktivált pub), fallback a `useData().workflows`-ben tárolt
    // `compiled.requiredGroupSlugs[]` az aktuálisan hozzárendelt workflow-ból.
    const { workflows } = useData();
    const orderingSlugs = useMemo(() => {
        const compiled = resolvePublicationCompiled(publication, workflows);
        if (!compiled || !Array.isArray(compiled.requiredGroupSlugs)) return undefined;
        return compiled.requiredGroupSlugs.map((g) => g?.slug).filter(Boolean);
    }, [publication, workflows]);

    const { groups, membersBySlug, loading } = useContributorGroups({ orderingSlugs });
    const { articles, updatePublication, updateArticle } = useData();
    const { showToast } = useToast();
    const confirm = useConfirm();

    // A.4.9 — szűrés contributor dropdown-okhoz:
    //   - csak `isContributorGroup === true` csoportok ajánlhatóak hozzárendelésre
    //   - DE: ha az adott slug-hoz már van meglévő `defaultContributors[slug]`
    //     hozzárendelés (akár archived, akár `isContributorGroup: false`), azt
    //     mutassuk, hogy a felhasználó el tudja távolítani.
    const visibleGroups = useMemo(() => {
        const assignedSlugs = new Set();
        try {
            const dc = publication.defaultContributors
                ? (typeof publication.defaultContributors === 'string'
                    ? JSON.parse(publication.defaultContributors)
                    : publication.defaultContributors)
                : null;
            if (dc && typeof dc === 'object') {
                for (const [k, v] of Object.entries(dc)) {
                    if (v) assignedSlugs.add(k);
                }
            }
        } catch { /* parse failure → only flag-based filter */ }
        return groups.filter((g) => g.isContributorGroup || assignedSlugs.has(g.slug));
    }, [groups, publication.defaultContributors]);

    const [busySlug, setBusySlug] = useState(null);

    const handleChange = useCallback(async (slug, groupName, userId) => {
        const normalized = userId || null;
        const currentValue = getContributor(publication.defaultContributors, slug);
        if (currentValue === normalized) return;

        setBusySlug(slug);
        try {
            const newJson = setContributor(publication.defaultContributors, slug, normalized);
            await updatePublication(publication.$id, { defaultContributors: newJson });

            // Null-ra állításkor nem kérdezünk rá a cikk-frissítésre
            if (!normalized) return;

            const pubArticles = articles.filter((a) => a.publicationId === publication.$id);
            const nullArticles = pubArticles.filter((a) => !getContributor(a.contributors, slug));
            if (nullArticles.length === 0) return;

            const ok = await confirm({
                title: 'Meglévő cikkek frissítése',
                message: `A kiadvány ${nullArticles.length} cikkében nincs még ${groupName} hozzárendelve. Szeretnéd ezeket is beállítani az új alapértelmezett személyre?`,
                confirmLabel: 'Frissítés',
                variant: 'normal'
            });
            if (!ok) return;

            let successCount = 0;
            for (const article of nullArticles) {
                try {
                    const nextJson = setContributor(article.contributors, slug, normalized);
                    await updateArticle(article.$id, { contributors: nextJson });
                    successCount++;
                } catch (err) {
                    console.error(`[ContributorsTab] Cikk frissítés sikertelen (${article.name}):`, err);
                }
            }
            if (successCount > 0) {
                showToast(`${successCount} cikk frissítve.`, 'success');
            }
            if (successCount < nullArticles.length) {
                showToast(
                    `${nullArticles.length - successCount} cikk frissítése sikertelen.`,
                    'warning'
                );
            }
        } catch (err) {
            console.error('[ContributorsTab] Save failed:', err);
            showToast(`Mentés sikertelen: ${err?.message || 'ismeretlen hiba'}`, 'error');
        } finally {
            setBusySlug(null);
        }
    }, [articles, confirm, publication.$id, publication.defaultContributors, showToast, updateArticle, updatePublication]);

    if (loading) {
        return (
            <div className="publication-form">
                <div className="form-empty-state">Csoportok betöltése…</div>
            </div>
        );
    }

    if (visibleGroups.length === 0) {
        return (
            <div className="publication-form">
                <div className="form-empty-state">
                    Nincs olyan közreműködő csoport ebben a szerkesztőségben (a workflow
                    <code>requiredGroupSlugs</code> szerint <code>isContributorGroup: true</code>
                    flag-gel jelölt csoportok jelennek meg itt).
                </div>
            </div>
        );
    }

    return (
        <div className="publication-form">
            {visibleGroups.map((group) => {
                const members = membersBySlug[group.slug] || [];
                const value = getContributor(publication.defaultContributors, group.slug) || '';
                const isArchived = !!group.archivedAt;
                const isLegacy = !group.isContributorGroup; // hozzárendelve van, de a flag már nincs
                return (
                    <div key={group.slug} className="form-group" style={{ opacity: isArchived ? 0.7 : 1 }}>
                        <label htmlFor={`ct-${group.slug}`} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <span>{group.name}</span>
                            {isArchived && (
                                <span style={{
                                    fontSize: 10, color: 'var(--text-muted)',
                                    background: 'var(--bg-base)', padding: '1px 6px',
                                    borderRadius: 3
                                }}>archivált</span>
                            )}
                            {!isArchived && isLegacy && (
                                <span title="Ez a csoport már nincs `isContributorGroup: true` flag-gel a workflow-ban — csak azért látszik, mert van hozzárendelt érték." style={{
                                    fontSize: 10, color: '#FFB85C',
                                    background: 'rgba(255, 184, 92, 0.15)',
                                    padding: '1px 6px', borderRadius: 3
                                }}>nem-contributor</span>
                            )}
                        </label>
                        <select
                            id={`ct-${group.slug}`}
                            className="form-select"
                            value={value}
                            onChange={(e) => handleChange(group.slug, group.name, e.target.value)}
                            disabled={busySlug === group.slug}
                        >
                            <option value="">Nincs hozzárendelve</option>
                            {members.map((m) => (
                                <option key={m.userId} value={m.userId}>
                                    {m.userName || m.userEmail || m.userId}
                                </option>
                            ))}
                        </select>
                    </div>
                );
            })}
        </div>
    );
}
