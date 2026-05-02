/**
 * Maestro Server — Kaszkád törlés helper-ek (Fázis 1 helper-extract, 2026-05-02).
 *
 * `deleteByQuery` — adott mezőértékhez tartozó dokumentumokat lapozva törli.
 * `cascadeDeleteOffice` — szerkesztőség-szintű kaszkád törlés (publikációk
 *   doc-onként, a többi office-kötött collection deleteByQuery-vel).
 *
 * Mindkét helper fail-closed: az első sikertelen törlés után dob, a hívó
 * ezzel kerüli el a részleges cleanup-ot.
 */

const sdk = require('node-appwrite');
const { CASCADE_BATCH_LIMIT } = require('./constants.js');

/**
 * Egy collection összes, adott mezőértékhez tartozó dokumentumát törli.
 * Lapozással dolgozik, minden batch-et Promise.allSettled-lel párhuzamosít.
 *
 * **Fail-closed**: ha bármely dokumentum törlése sikertelen, a függvény
 * dob a batch feldolgozás után (miután az összes aktuális batch művelet
 * lefutott — nem „all-or-nothing", hanem „fuss amennyi megy, aztán dobj").
 * Ez garantálja, hogy a hívó NEM törli a szülő doc-ot részleges gyerek
 * cleanup után.
 *
 * @param {sdk.Databases} databases
 * @param {string} databaseId
 * @param {string} collectionId
 * @param {string} fieldName — szűrő mező neve (pl. 'editorialOfficeId')
 * @param {string} fieldValue — szűrő mező értéke
 * @returns {Promise<{ found: number, deleted: number }>}
 * @throws {Error} ha bármely dokumentum törlése sikertelen
 */
async function deleteByQuery(databases, databaseId, collectionId, fieldName, fieldValue) {
    let totalFound = 0;
    let totalDeleted = 0;
    const failures = [];

    while (true) {
        const response = await databases.listDocuments(
            databaseId,
            collectionId,
            [
                sdk.Query.equal(fieldName, fieldValue),
                sdk.Query.limit(CASCADE_BATCH_LIMIT)
            ]
        );
        if (response.documents.length === 0) break;

        totalFound += response.documents.length;

        const deleteResults = await Promise.allSettled(
            response.documents.map(doc =>
                databases.deleteDocument(databaseId, collectionId, doc.$id)
            )
        );

        let batchDeleted = 0;
        for (let i = 0; i < deleteResults.length; i++) {
            const result = deleteResults[i];
            if (result.status === 'fulfilled') {
                batchDeleted++;
            } else {
                failures.push({
                    docId: response.documents[i].$id,
                    message: result.reason?.message || String(result.reason)
                });
            }
        }
        totalDeleted += batchDeleted;

        // Ha egy batch egyetlen törlése sem sikerült, a következő listDocuments
        // ugyanazokat a dokumentumokat adná vissza → végtelen ciklus. Kilépünk,
        // a failures lista lejjebb dob.
        if (batchDeleted === 0) break;

        // Ha az utolsó batch nem telt meg, nincs több dokumentum → kilépünk
        // egy felesleges listDocuments hívás nélkül.
        if (response.documents.length < CASCADE_BATCH_LIMIT) break;
    }

    if (failures.length > 0) {
        const err = new Error(
            `deleteByQuery: ${failures.length}/${totalFound} törlés sikertelen a(z) "${collectionId}" collectionben (${fieldName}=${fieldValue}). Első hiba: ${failures[0].message}`
        );
        err.collectionId = collectionId;
        err.failures = failures;
        throw err;
    }

    return { found: totalFound, deleted: totalDeleted };
}

/**
 * Szerkesztőség-szintű kaszkád törlés — a publikációkat doc-onként törli
 * (a cascade-delete CF kapja el a publication.delete event-et és takarítja
 * az articles/layouts/deadlines-t rekurzívan), a többi office-kötött
 * collectiont pedig deleteByQuery-vel iratja ki.
 *
 * NEM törli magát az office dokumentumot — ezt a hívó intézi, hogy a
 * delete_organization ág is ezen a helper-en keresztül takaríthassa
 * az office-ait a saját lépéseiben.
 *
 * **Fail-closed**: bármely lépés hibája esetén dob, és a hívó NEM
 * törölheti az office doc-ot (különben árva gyerekek maradnának).
 * A hívó responsibility, hogy `try/catch`-el kezelje.
 *
 * @returns {Promise<{ publications, workflows, groups, groupMemberships, officeMemberships }>}
 * @throws {Error} ha bármely gyerek dokumentum törlése sikertelen
 */
async function cascadeDeleteOffice(databases, officeId, env, log) {
    const {
        databaseId,
        publicationsCollectionId,
        workflowsCollectionId,
        groupsCollectionId,
        groupMembershipsCollectionId,
        officeMembershipsCollectionId
    } = env;

    // 1) Publikációk — doc-onkénti deleteDocument, hogy a cascade-delete CF
    //    kapja el a publication.delete event-et (articles → layouts → deadlines,
    //    majd article.delete → validations + thumbnails).
    //
    //    Fail-closed: az első sikertelen törlés után azonnal dobunk —
    //    a részleges törlés nem vezethet árva office-szintű cleanup-hoz.
    let pubFound = 0;
    let pubDeleted = 0;
    while (true) {
        const response = await databases.listDocuments(
            databaseId,
            publicationsCollectionId,
            [
                sdk.Query.equal('editorialOfficeId', officeId),
                sdk.Query.limit(CASCADE_BATCH_LIMIT)
            ]
        );
        if (response.documents.length === 0) break;

        pubFound += response.documents.length;

        // Szekvenciális törlés — a cascade-delete CF nehéz munka, ne indítsuk
        // egyszerre 100 párhuzamos kaszkádot, az rate limit-be futna.
        // Az első hiba → throw (fail-closed).
        for (const doc of response.documents) {
            try {
                await databases.deleteDocument(databaseId, publicationsCollectionId, doc.$id);
                pubDeleted++;
            } catch (err) {
                const wrapped = new Error(
                    `cascadeDeleteOffice: publikáció ${doc.$id} ("${doc.name || '?'}") törlése sikertelen: ${err.message}`
                );
                wrapped.cause = err;
                wrapped.collectionId = publicationsCollectionId;
                wrapped.docId = doc.$id;
                throw wrapped;
            }
        }

        if (response.documents.length < CASCADE_BATCH_LIMIT) break;
    }

    // 2) A többi office-kötött collection — parallel deleteByQuery.
    //    Promise.all: ha bármelyik dob, a többi in-flight is befejeződik,
    //    de a wrapper rejection propagál, és NEM jutunk el az office doc
    //    törléséhez.
    const [workflows, groups, groupMemberships, officeMemberships] = await Promise.all([
        deleteByQuery(databases, databaseId, workflowsCollectionId, 'editorialOfficeId', officeId),
        deleteByQuery(databases, databaseId, groupsCollectionId, 'editorialOfficeId', officeId),
        deleteByQuery(databases, databaseId, groupMembershipsCollectionId, 'editorialOfficeId', officeId),
        deleteByQuery(databases, databaseId, officeMembershipsCollectionId, 'editorialOfficeId', officeId)
    ]);

    log(`[CascadeOffice ${officeId}] pubs=${pubDeleted}/${pubFound}, workflows=${workflows.deleted}/${workflows.found}, groups=${groups.deleted}/${groups.found}, groupMemberships=${groupMemberships.deleted}/${groupMemberships.found}, officeMemberships=${officeMemberships.deleted}/${officeMemberships.found}`);

    return {
        publications: { found: pubFound, deleted: pubDeleted },
        workflows,
        groups,
        groupMemberships,
        officeMemberships
    };
}

module.exports = {
    deleteByQuery,
    cascadeDeleteOffice
};
