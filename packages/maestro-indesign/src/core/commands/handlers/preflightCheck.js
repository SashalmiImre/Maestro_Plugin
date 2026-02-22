/**
 * @fileoverview Preflight ellenőrzés parancs handler.
 * A "Preflight" gombra kattintáskor fut, futtatja a PreflightValidator-t,
 * és az eredményt elmenti az adatbázisba a useWorkflowValidation hook-on keresztül.
 *
 * Fontos: ez a handler a runAndPersistPreflight függvényt kapja a context-ben,
 * amit a PropertiesPanel ad át a useWorkflowValidation hook-ból.
 */

/**
 * @param {Object} context - { item, publication, user, runAndPersistPreflight }
 * @returns {Promise<{ success: boolean, message?: string, error?: string }>}
 */
export const handlePreflightCheck = async (context) => {
    const { item, runAndPersistPreflight } = context;

    console.log(`[Command] Preflight check for:`, item?.name);

    if (!item || !item.filePath) {
        return { success: false, error: "Nincs érvényes cikk kiválasztva." };
    }

    if (!runAndPersistPreflight) {
        return { success: false, error: "Preflight validáció nem elérhető (hook nincs bekötve)." };
    }

    let result;
    try {
        result = await runAndPersistPreflight(item);
    } catch (err) {
        console.error(`[Command] Preflight check failed:`, err);
        return { success: false, error: `Preflight failed: ${err.message || "Ismeretlen hiba."}` };
    }

    if (!result) {
        return { success: false, error: "Preflight failed: nem érkezett eredmény." };
    }

    // Csatolatlan meghajtó → a hook már mutatott toast-ot, itt nem kell újabb visszajelzés
    if (result.skipped) {
        return { success: false, silent: true };
    }

    if (result.isValid) {
        return { success: true, message: "Preflight: Nincs hiba." };
    }

    // Hibák száma visszajelzéshez
    const errorCount = (result.errors || []).length;
    return {
        success: false,
        error: `Preflight: ${errorCount} hiba található. Részletek a Validáció szekcióban.`
    };
};
