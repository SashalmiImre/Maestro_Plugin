/**
 * Maestro Dashboard — Workflow visibility helpers
 *
 * A 3-way láthatósági szabály (public / organization / editorial_office) szerver-
 * és kliens oldali szűrését egyetlen forrásból származtatja. Ha a szabály
 * változik, CSAK itt kell módosítani — a `fetchWorkflow` (aktív), a
 * `runArchivedQuery` (archivált) és a Realtime `isVisible` gate ugyanezt
 * a helpert használja.
 *
 * A legacy fallback (`visibility IS NULL` → `editorial_office`) két helyen kap
 * egyenrangú kezelést: a server-side `Query.or`-ban és a kliens oldali
 * `isWorkflowInScope`-ban is — így a régi, visibility nélküli doc-ok konzisztensen
 * látszanak mind a REST lekérésben, mind a Realtime push-on.
 */

import { Query } from 'appwrite';
import {
    WORKFLOW_VISIBILITY,
    WORKFLOW_VISIBILITY_DEFAULT
} from '@shared/constants.js';

/**
 * Normalizált láthatósági érték — a null/undefined legacy dokumentumokat
 * az alapértelmezett (`editorial_office`) szintre konvertálja.
 * @param {{ visibility?: string|null }} wf
 * @returns {string}
 */
export function getWorkflowVisibility(wf) {
    return wf?.visibility || WORKFLOW_VISIBILITY_DEFAULT;
}

/**
 * Szerver-oldali Appwrite Query tömb az aktuális scope-ban látható workflow-khoz.
 * Az `archived` opcióval az aktív (default) és az archivált nézet egyaránt
 * ugyanezt a láthatósági ágat használja — a hívó csak a `Query.isNotNull` /
 * `Query.isNull('archivedAt')` különbséget kezeli.
 *
 * @param {Object} params
 * @param {string} params.organizationId
 * @param {string} params.editorialOfficeId
 * @param {boolean} [params.archived=false] — true esetén csak az archivált doc-ok
 * @returns {Array} Query expressions (Query.or + archivedAt szűrő)
 */
export function buildWorkflowVisibilityQueries({ organizationId, editorialOfficeId, archived = false }) {
    return [
        Query.or([
            Query.equal('visibility', WORKFLOW_VISIBILITY.PUBLIC),
            Query.and([
                Query.equal('visibility', WORKFLOW_VISIBILITY.ORGANIZATION),
                Query.equal('organizationId', organizationId)
            ]),
            Query.and([
                Query.equal('visibility', WORKFLOW_VISIBILITY.EDITORIAL_OFFICE),
                Query.equal('editorialOfficeId', editorialOfficeId)
            ]),
            // Legacy fallback: `visibility IS NULL` → `editorial_office` szintként kezelve
            Query.and([
                Query.isNull('visibility'),
                Query.equal('editorialOfficeId', editorialOfficeId)
            ])
        ]),
        archived ? Query.isNotNull('archivedAt') : Query.isNull('archivedAt')
    ];
}

/**
 * Kliens-oldali láthatósági predikátum (Realtime handler + utólagos kliens
 * szűrés). Ugyanazt a 3-way szabályt követi, mint a `buildWorkflowVisibilityQueries`
 * szerver-oldali ága, így echo-payload-okra konzisztens döntést ad.
 *
 * @param {Object} workflow — Appwrite doc
 * @param {Object} scope
 * @param {string} scope.organizationId
 * @param {string} scope.editorialOfficeId
 * @returns {boolean}
 */
export function isWorkflowInScope(workflow, { organizationId, editorialOfficeId }) {
    const visibility = getWorkflowVisibility(workflow);
    if (visibility === WORKFLOW_VISIBILITY.PUBLIC) return true;
    if (visibility === WORKFLOW_VISIBILITY.ORGANIZATION) {
        return workflow.organizationId === organizationId;
    }
    // EDITORIAL_OFFICE + legacy null → office-egyezés
    return workflow.editorialOfficeId === editorialOfficeId;
}
