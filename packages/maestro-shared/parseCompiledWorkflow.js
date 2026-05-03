/**
 * Maestro Shared — Compiled workflow JSON parsing helper.
 *
 * A `workflows` és `publications.compiledWorkflowSnapshot` mező egyaránt
 * stringként tárolt JSON az Appwrite collection-ben. A frontend több helye
 * (Dashboard `GroupRow`, `ContributorsTab`, `GeneralTab`,
 * `EmptyRequiredGroupsDialog`, és Plugin runtime) olvassa, és minden helyen
 * azonos defenzív try/catch-csel parse-olja. Ez a helper a kanonikus
 * belépési pont — null-ra esik vissza, ha az input nem objektum / nem
 * érvényes JSON.
 */

/**
 * Egy `compiled` mező (string vagy object) -> plain object | null.
 *
 * Array-ket explicit elutasítja: a `compiled` egy struktúrált objektum
 * (`states[]`, `transitions[]`, `requiredGroupSlugs[]`, …) — egy nyers
 * array soha nem érvényes, ezért fail-closed null-ra esik (különben a
 * downstream `compiled.requiredGroupSlugs` undefined lenne és a hívó
 * `Array.isArray` check átengedné egy szellem-érvényes payloadként).
 *
 * @param {string|Object|null|undefined} value
 * @returns {Object|null}
 */
export function parseCompiledWorkflow(value) {
    if (!value) return null;
    if (typeof value === 'object') {
        return Array.isArray(value) ? null : value;
    }
    if (typeof value !== 'string') return null;
    try {
        const parsed = JSON.parse(value);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
        return parsed;
    } catch {
        return null;
    }
}

/**
 * Publikáció + workflow lookup → érvényes `compiled` JSON. Először a
 * `publication.compiledWorkflowSnapshot` (futó pub kanonikusa) próbálja, és
 * ha az nincs / parse-olhatatlan, fallback-elünk a workflow doc `compiled`
 * mezőjére. Ha egyik sem érhető el, null.
 *
 * @param {Object} publication - A `publications` doc
 * @param {Array<Object>} workflows - A `useData().workflows` lista
 * @returns {Object|null}
 */
export function resolvePublicationCompiled(publication, workflows) {
    const fromSnapshot = parseCompiledWorkflow(publication?.compiledWorkflowSnapshot);
    if (fromSnapshot) return fromSnapshot;
    const wf = Array.isArray(workflows)
        ? workflows.find((w) => w?.$id === publication?.workflowId)
        : null;
    return parseCompiledWorkflow(wf?.compiled);
}
