#!/usr/bin/env node
/**
 * Maestro — S.13.3 Phase 2.1 build-generator a CF response helpers-hez.
 *
 * A `packages/maestro-shared/piiRedaction.js` + `responseHelpers.js` (ESM)
 * a kanonikus forrás. A CF deploy (`appwrite functions create-deployment`)
 * NEM oldja fel a workspace yarn linket, ezért minden CF-nek saját CommonJS
 * másolatra van szüksége — ez a script generálja a `_generated_*.js`
 * pillanatképeket. S.7.7b `build-cf-validator.mjs` precedens.
 *
 * Használat:
 *   node scripts/build-cf-response-helpers.mjs            # generál + ír
 *   node scripts/build-cf-response-helpers.mjs --check    # drift-guard
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

const SHARED_DIR = resolve(REPO_ROOT, "packages/maestro-shared");
const FUNCTIONS_DIR = resolve(REPO_ROOT, "packages/maestro-server/functions");

// A CF-ek listája, amelyek a generált CommonJS portokat használják.
// Phase 2.0a/b/c után 3 CF; Phase 2.2 bővíti.
const TARGET_CFS = [
    "update-article",
    "validate-publication-update",
    "user-cascade-delete"
];

// Modul-konfig: minden shared modul az exportjaival és path-eltolódásával.
// Az `imports` map a transzform számára: a forrás ESM `import`-jait CommonJS
// `require`-re cseréli a megadott target-path-szal.
const MODULES = [
    {
        sourceFile: "piiRedaction.js",
        targetName: "_generated_piiRedaction.js",
        exportedNames: [
            "redactEmail",
            "redactTokenLast4",
            "redactString",
            "redactValue",
            "redactArgs",
            "isRedactionDisabled",
            "wrapLogger"
        ],
        imports: {}
    },
    {
        sourceFile: "responseHelpers.js",
        targetName: "_generated_responseHelpers.js",
        exportedNames: [
            "fail",
            "okJson",
            "createRecordError",
            "stripSensitive",
            "normalizeReason"
        ],
        imports: {
            "./piiRedaction.js": "./_generated_piiRedaction.js"
        }
    }
];

const REGENERATE_CMD = "yarn build:cf-response-helpers";

function makeBanner(sourceFile) {
    const relSource = relative(REPO_ROOT, resolve(SHARED_DIR, sourceFile));
    return [
        "/**",
        " * AUTO-GENERATED FILE — DO NOT EDIT.",
        ` * Source: ${relSource}`,
        ` * Regenerate: ${REGENERATE_CMD}`,
        " *",
        " * A kanonikus ESM forrás CommonJS pillanatképe. CF deploy-időben a",
        " * workspace yarn link NEM oldódik fel, ezért minden CF saját másolatot",
        " * tart. Generálás: scripts/build-cf-response-helpers.mjs (S.13.3 Phase 2.1).",
        " */",
        ""
    ].join("\n");
}

/**
 * ESM → CJS textuális transzformáció. A `responseHelpers.js`-ben az
 * `import { X } from './piiRedaction.js'` mintát CommonJS `require`-re
 * cseréli (path rewrite: `./_generated_piiRedaction.js`). Az `export function`-ot
 * `function`-ra. Post-transform fail-closed lingering-ESM check.
 */
function transformToCommonJs(source, modConfig) {
    let body = source;

    // 1) ESM `import { ... } from '<path>'` → CommonJS `const { ... } = require('<rewrittenPath>')`.
    //    A `modConfig.imports` map adja a path rewrite-ot. Egyetlen `import` line
    //    minta (default: csak named imports, NEM `import * as`, NEM `import X from`).
    for (const [originalPath, rewrittenPath] of Object.entries(modConfig.imports)) {
        const importRegex = new RegExp(
            `import\\s*\\{([^}]+)\\}\\s*from\\s*['"]${originalPath.replace(/[.\\/]/g, '\\$&')}['"];?`,
            "g"
        );
        const before = body;
        body = body.replace(importRegex, (_match, names) => {
            const cleaned = names.trim();
            return `const { ${cleaned} } = require('${rewrittenPath}');`;
        });
        if (body === before) {
            throw new Error(
                `[build-cf-response-helpers] Nem található "import { ... } from '${originalPath}'" minta a ${modConfig.sourceFile}-ben — ` +
                `az imports-config eltért a forrás valóságától.`
            );
        }
    }

    // 2) `export function NAME` → `function NAME` minden exportált névre.
    for (const name of modConfig.exportedNames) {
        const before = body;
        body = body.replace(`export function ${name}`, `function ${name}`);
        if (body === before) {
            throw new Error(
                `[build-cf-response-helpers] A forrásban nem található "export function ${name}" — ` +
                `a shared modul szignatúrája megváltozott, a generátort frissíteni kell.`
            );
        }
    }

    // 3) Trailing `export { X, Y }` minta (responseHelpers.js használja).
    //    Ez a CJS-formában már nem kell — drop.
    body = body.replace(/^\s*export\s*\{[^}]+\};?\s*$/gm, "");

    // 4) Post-transform fail-closed: ha bármilyen ESM-specifikus szintaxis
    //    visszamarad, jobb kemény hibát dobni mint csendes futási hibát.
    const lingeringEsmPatterns = [
        { pattern: /\bexport\s+(?:function|const|let|var|class|default|\{)/, label: "export" },
        { pattern: /\bimport\s+[\s\S]*?from\s+['"]/, label: "import...from" },
        { pattern: /\bimport\s*\(/, label: "dynamic import()" },
        { pattern: /\bimport\s*\.\s*meta\b/, label: "import.meta" },
        { pattern: /\bawait\s+/, label: "top-level await" }
    ];
    for (const { pattern, label } of lingeringEsmPatterns) {
        if (pattern.test(body)) {
            throw new Error(
                `[build-cf-response-helpers] A transzform után ESM-specifikus token maradt: "${label}" (${modConfig.sourceFile}). ` +
                `A shared modulnak vanilla ES-szintaxisúnak kell lennie.`
            );
        }
    }

    // 5) CJS-export blokk.
    const exportsBlock =
        "\nmodule.exports = {\n" +
        modConfig.exportedNames.map(name => `    ${name}`).join(",\n") +
        "\n};\n";

    return makeBanner(modConfig.sourceFile) + body.trimEnd() + "\n" + exportsBlock;
}

async function generateOne(cfName, modConfig, checkMode) {
    const sourcePath = resolve(SHARED_DIR, modConfig.sourceFile);
    const targetPath = resolve(FUNCTIONS_DIR, cfName, "src", modConfig.targetName);

    const sourceText = await readFile(sourcePath, "utf8");
    const generatedText = transformToCommonJs(sourceText, modConfig);

    let existing = null;
    try {
        existing = await readFile(targetPath, "utf8");
    } catch (err) {
        if (err?.code !== "ENOENT") throw err;
    }

    if (checkMode) {
        if (existing === null) {
            return { ok: false, kind: "missing", targetPath };
        }
        if (existing !== generatedText) {
            return { ok: false, kind: "drift", targetPath };
        }
        return { ok: true, kind: "match", targetPath };
    }

    if (existing === generatedText) {
        return { ok: true, kind: "noop", targetPath };
    }

    await writeFile(targetPath, generatedText, "utf8");
    return { ok: true, kind: "written", targetPath };
}

async function main() {
    const args = process.argv.slice(2);
    const checkMode = args.includes("--check");

    const results = [];
    for (const cfName of TARGET_CFS) {
        for (const modConfig of MODULES) {
            const result = await generateOne(cfName, modConfig, checkMode);
            results.push({ cfName, mod: modConfig.targetName, ...result });
        }
    }

    if (checkMode) {
        const failures = results.filter(r => !r.ok);
        if (failures.length > 0) {
            for (const f of failures) {
                const rel = relative(REPO_ROOT, f.targetPath);
                console.error(`[build-cf-response-helpers] CHECK FAILED (${f.kind}): ${rel}`);
            }
            console.error(`Futtasd: ${REGENERATE_CMD}`);
            process.exit(1);
        }
        console.log(
            `[build-cf-response-helpers] OK — minden ${results.length} fájl szinkronban (` +
            `${TARGET_CFS.length} CF × ${MODULES.length} modul).`
        );
        return;
    }

    const written = results.filter(r => r.kind === "written").length;
    const noop = results.filter(r => r.kind === "noop").length;
    console.log(
        `[build-cf-response-helpers] OK — ${written} írva, ${noop} no-op (összesen ${results.length}).`
    );
}

main().catch(err => {
    console.error(err.stack || err.message || err);
    process.exit(1);
});
