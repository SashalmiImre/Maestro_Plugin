#!/usr/bin/env node
/**
 * Maestro — A.7.1 (ADR 0008 follow-up): a workflow compiled JSON validátor
 * single-source generátora.
 *
 * A `packages/maestro-shared/compiledValidator.js` (ESM) a kanonikus forrás —
 * ezt a Workflow Designer save-flow használja a Dashboardon. A CF deploy
 * (`appwrite functions create-deployment --code functions/invite-to-organization`)
 * NEM oldja fel a workspace yarn linket, ezért az `invite-to-organization`
 * CF-nek saját CommonJS másolatra van szüksége. A korábbi kézi másolat (a
 * `helpers/compiledValidator.js`-ben élt `validateCompiledSlugsInline`)
 * drift-veszélyes volt — ez a script generálja az autoritatív CF-oldali
 * pillanatképet a shared modulból.
 *
 * Használat:
 *   node scripts/build-cf-validator.mjs            # generál + ír
 *   node scripts/build-cf-validator.mjs --check    # generál memóriába,
 *                                                  # diff-eli a fájllal,
 *                                                  # mismatch → exit 1
 *
 * A check-mode CI-mentes drift-guard: a deploy előtt manuálisan futtatva
 * (vagy commit-hookból) jelzi, ha a generált fájl elszállt a forrástól.
 */

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, relative, resolve } from "node:path";
import process from "node:process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

const SOURCE_PATH = resolve(REPO_ROOT, "packages/maestro-shared/compiledValidator.js");
const TARGET_PATH = resolve(
    REPO_ROOT,
    "packages/maestro-server/functions/invite-to-organization/src/helpers/_generated_compiledValidator.js"
);

// A banner és diff-üzenetek számára. Egyetlen út-igazság a `SOURCE_PATH`-ből
// derived, hogy a path-átszervezés ne lépjen drift-be a banner szövegével.
const RELATIVE_SOURCE = relative(REPO_ROOT, SOURCE_PATH);
const REGENERATE_CMD = "yarn build:cf-validator";

const BANNER_LINES = [
    "/**",
    " * AUTO-GENERATED FILE — DO NOT EDIT.",
    ` * Source: ${RELATIVE_SOURCE}`,
    ` * Regenerate: ${REGENERATE_CMD}`,
    " *",
    " * A `packages/maestro-shared/compiledValidator.js` (ESM) a kanonikus forrás. Ez a",
    " * fájl egy CommonJS pillanatkép, hogy az `invite-to-organization` CF deploy-",
    " * időben elérje (a workspace yarn link nem oldódik fel a CF runtime-on). A",
    " * generálást a `scripts/build-cf-validator.mjs` végzi (A.7.1, ADR 0008).",
    " */",
    ""
].join("\n");

// A generated CJS fájl a shared modul teljes mirror-ja — minden exportját
// tükrözi, hogy a `lingeringEsmPatterns[0]` `export` regex a forrás minden
// `export function`-ját elfogja (különben a script csendben nem-CJS-formára
// állna). A wrapper `helpers/compiledValidator.js` szelektíven re-exportálja
// csak a CF tényleg használt függvényt — ez a két határvonal szándékosan
// különálló.
const EXPORTED_NAMES = ["validateCompiledSlugs", "summarizeValidationErrors"];

/**
 * ESM → CJS textuális transzformáció. A shared modul önálló (nincs `import`,
 * nincs `export const`, nincs `export default`, nincs top-level await), ezért
 * a triviális `export function` → `function` csere elég. A post-transform
 * token-guard véd a regresszió ellen: ha valaki később ESM-specifikus
 * szintaxist tesz a forrásba, a generálás fail-closed dob.
 */
function transformToCommonJs(source) {
    let body = source;

    for (const name of EXPORTED_NAMES) {
        const before = body;
        body = body.replace(`export function ${name}`, `function ${name}`);
        if (body === before) {
            throw new Error(
                `[build-cf-validator] A forrásban nem található "export function ${name}" — ` +
                `a shared modul szignatúrája megváltozott, a generátort frissíteni kell.`
            );
        }
    }

    // Post-transform fail-closed: ha bármilyen ESM-specifikus szintaxis
    // visszamarad, jobb kemény hibát dobni, mint csendes futási hibát adni
    // a CF-en (Codex review fail-closed elv, A.7.1).
    const lingeringEsmPatterns = [
        { pattern: /\bexport\s+(?:function|const|let|var|class|default|\{)/, label: "export" },
        { pattern: /\bimport\s+[\s\S]*?from\s+['"]/, label: "import...from" },
        { pattern: /\bimport\s*\(/, label: "dynamic import()" },
        // `import.meta` ESM-only (Codex harden 2026-05-03): egy `const url = import.meta.url`
        // textuálisan átmenne a transzformon, és a CF cold-start parse-hibával hasalna el.
        { pattern: /\bimport\s*\.\s*meta\b/, label: "import.meta" },
        { pattern: /\bawait\s+/, label: "top-level await" }
    ];
    for (const { pattern, label } of lingeringEsmPatterns) {
        if (pattern.test(body)) {
            throw new Error(
                `[build-cf-validator] A transzform után ESM-specifikus token maradt: "${label}". ` +
                `A shared modulnak vanilla ES-szintaxisúnak kell lennie (csak \`export function\`).`
            );
        }
    }

    const exportsBlock =
        "\nmodule.exports = {\n" +
        EXPORTED_NAMES.map(name => `    ${name}`).join(",\n") +
        "\n};\n";

    return BANNER_LINES + body.trimEnd() + "\n" + exportsBlock;
}

async function main() {
    const args = process.argv.slice(2);
    const checkMode = args.includes("--check");

    const sourceText = await readFile(SOURCE_PATH, "utf8");
    const generatedText = transformToCommonJs(sourceText);

    let existing = null;
    try {
        existing = await readFile(TARGET_PATH, "utf8");
    } catch (err) {
        if (err?.code !== "ENOENT") throw err;
    }

    if (checkMode) {
        if (existing === null) {
            console.error(
                `[build-cf-validator] CHECK FAILED: a generált fájl nem létezik (${TARGET_PATH}). ` +
                `Futtasd: ${REGENERATE_CMD}`
            );
            process.exit(1);
        }
        if (existing !== generatedText) {
            console.error(
                `[build-cf-validator] DRIFT — a generált fájl eltér a forrásból generálttól. ` +
                `Futtasd: ${REGENERATE_CMD}`
            );
            process.exit(1);
        }
        console.log("[build-cf-validator] OK — a generált fájl szinkronban van a forrással.");
        return;
    }

    if (existing === generatedText) {
        console.log(`[build-cf-validator] OK — a generált fájl már szinkronban (no-op): ${TARGET_PATH}`);
        return;
    }

    await writeFile(TARGET_PATH, generatedText, "utf8");
    console.log(`[build-cf-validator] OK — generálva: ${TARGET_PATH}`);
}

main().catch(err => {
    console.error(err.stack || err.message || err);
    process.exit(1);
});
