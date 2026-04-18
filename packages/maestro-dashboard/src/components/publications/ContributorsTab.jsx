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

import React, { useState, useCallback } from 'react';
import { useData } from '../../contexts/DataContext.jsx';
import { useContributorGroups } from '../../hooks/useContributorGroups.js';
import { useToast } from '../../contexts/ToastContext.jsx';
import { useConfirm } from '../ConfirmDialog.jsx';
import { getContributor, setContributor } from '@shared/contributorHelpers.js';

export default function ContributorsTab({ publication }) {
    const { groups, membersBySlug, loading } = useContributorGroups();
    const { articles, updatePublication, updateArticle } = useData();
    const { showToast } = useToast();
    const confirm = useConfirm();

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

    if (groups.length === 0) {
        return (
            <div className="publication-form">
                <div className="form-empty-state">
                    Nincs csoport ebben a szerkesztőségben.
                </div>
            </div>
        );
    }

    return (
        <div className="publication-form">
            {groups.map((group) => {
                const members = membersBySlug[group.slug] || [];
                const value = getContributor(publication.defaultContributors, group.slug) || '';
                return (
                    <div key={group.slug} className="form-group">
                        <label htmlFor={`ct-${group.slug}`}>{group.name}</label>
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
