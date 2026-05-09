#!/usr/bin/env node
/**
 * Maestro — H.2 (Phase 2, 2026-05-09): Phase 1.6 orphan-guard helper
 * single-source generátora.
 *
 * A `packages/maestro-shared/orphanGuard.js` (ESM) a kanonikus forrás. A
 * 2 érintett CF-mappa (`set-publication-root-path`, `update-article`) saját
 * CommonJS pillanatképet kap `_generated_orphanGuard.js`-ként, mert az
 * `appwrite functions create-deployment --code` NEM oldja fel a workspace
 * yarn linket (a `node_modules`-on belüli `maestro-shared` symlink a CF
 * runtime-on nem létezik).
 *
 * Minta: `scripts/build-cf-validator.mjs` (A.7.1, ADR 0008). Triviális
 * `export function/const` → `function/const` textuális csere + post-transform
 * token-guard a drift ellen.
 *
 * Használat:
 *   node scripts/build-cf-orphan-guard.mjs            # generál + ír
 *   node scripts/build-cf-orphan-guard.mjs --check    # diff-ellenőrzés (CI-mentes)
 */

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, relative, resolve } from "node:path";
import process from "node:process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

const SOURCE_PATH = resolve(REPO_ROOT, "packages/maestro-shared/orphanGuard.js");
const TARGET_CFS = [
    "packages/maestro-server/functions/set-publication-root-path/src/_generated_orphanGuard.js",
    "packages/maestro-server/functions/update-article/src/_generated_orphanGuard.js"
];

const RELATIVE_SOURCE = relative(REPO_ROOT, SOURCE_PATH);
const REGENERATE_CMD = "yarn build:cf-orphan-guard";

const BANNER_LINES = [
    "/**",
    " * AUTO-GENERATED FILE — DO NOT EDIT.",
    ` * Source: ${RELATIVE_SOURCE}`,
    ` * Regenerate: ${REGENERATE_CMD}`,
    " *",
    " * A `packages/maestro-shared/orphanGuard.js` (ESM) a kanonikus forrás.",
    " * Ez a fájl egy CommonJS pillanatkép, hogy a CF deploy-időben elérhető",
    " * legyen (a workspace yarn link nem oldódik fel a CF runtime-on). A",
    " * generálást a `scripts/build-cf-orphan-guard.mjs` végzi (H.2, 2026-05-09).",
    " */",
    ""
].join("\n");

const EXPORTED_FUNCTIONS = ["isOrgWriteBlocked", "clearOrgStatusCache", "getOrgStatus"];
// Longest-first: az `ORG_STATUS_LOOKUP_FAILED` egyebet `ORG_STATUS` is matchelne
// (prefix-egyezés), ezért ELŐSZÖR a hosszabbat cseréljük.
const EXPORTED_CONSTS = ["ORG_STATUS_LOOKUP_FAILED", "ORG_STATUS"];

function transformToCommonJs(source) {
    let body = source;

    for (const name of EXPORTED_FUNCTIONS) {
        const before = body;
        body = body.replace(`export function ${name}`, `function ${name}`);
        body = body.replace(`export async function ${name}`, `async function ${name}`);
        if (body === before) {
            throw new Error(
                `[build-cf-orphan-guard] A forrásban nem található "export [async] function ${name}" — ` +
                `a shared modul szignatúrája megváltozott, a generátort frissíteni kell.`
            );
        }
    }

    for (const name of EXPORTED_CONSTS) {
        const before = body;
        body = body.replace(`export const ${name}`, `const ${name}`);
        if (body === before) {
            throw new Error(
                `[build-cf-orphan-guard] A forrásban nem található "export const ${name}" — ` +
                `a shared modul szignatúrája megváltozott, a generátort frissíteni kell.`
            );
        }
    }

    // Post-transform fail-closed: ha ESM-specifikus szintaxis visszamarad,
    // jobb kemény hibát dobni, mint csendes runtime-hibát adni a CF-en. A
    // sor-eleji horgony a kommentekben szereplő `export` / `import` szavakat
    // (pl. JSDoc magyarázat) NEM tekinti drift-nek — csak a tényleges
    // top-level statement-eket fogja.
    const lingeringEsmPatterns = [
        { pattern: /^\s*export\s+(?:function|const|let|var|class|default|async|\{)/m, label: "export" },
        { pattern: /^\s*import\s+[\s\S]*?from\s+['"]/m, label: "import...from" },
        { pattern: /^\s*import\s*\(/m, label: "dynamic import()" },
        { pattern: /\bimport\s*\.\s*meta\b/, label: "import.meta" },
        { pattern: /^\s*await\s+/m, label: "top-level await" }
    ];
    for (const { pattern, label } of lingeringEsmPatterns) {
        if (pattern.test(body)) {
            throw new Error(
                `[build-cf-orphan-guard] A transzform után ESM-specifikus token maradt: "${label}". ` +
                `A shared modulnak vanilla ES-szintaxisúnak kell lennie.`
            );
        }
    }

    const exportNames = [...EXPORTED_CONSTS, ...EXPORTED_FUNCTIONS];
    const exportsBlock =
        "\nmodule.exports = {\n" +
        exportNames.map(name => `    ${name}`).join(",\n") +
        "\n};\n";

    return BANNER_LINES + body.trimEnd() + "\n" + exportsBlock;
}

async function processTarget(targetRel, generatedText, checkMode) {
    const targetPath = resolve(REPO_ROOT, targetRel);
    let existing = null;
    try {
        existing = await readFile(targetPath, "utf8");
    } catch (err) {
        if (err?.code !== "ENOENT") throw err;
    }

    if (checkMode) {
        if (existing === null) {
            console.error(
                `[build-cf-orphan-guard] CHECK FAILED: ${targetRel} nem létezik. Futtasd: ${REGENERATE_CMD}`
            );
            return false;
        }
        if (existing !== generatedText) {
            console.error(
                `[build-cf-orphan-guard] DRIFT: ${targetRel} eltér a forrásból generálttól. Futtasd: ${REGENERATE_CMD}`
            );
            return false;
        }
        console.log(`[build-cf-orphan-guard] OK ${targetRel}`);
        return true;
    }

    if (existing === generatedText) {
        console.log(`[build-cf-orphan-guard] OK no-op: ${targetRel}`);
        return true;
    }

    await writeFile(targetPath, generatedText, "utf8");
    console.log(`[build-cf-orphan-guard] OK generálva: ${targetRel}`);
    return true;
}

async function main() {
    const args = process.argv.slice(2);
    const checkMode = args.includes("--check");

    const sourceText = await readFile(SOURCE_PATH, "utf8");
    const generatedText = transformToCommonJs(sourceText);

    let allOk = true;
    for (const target of TARGET_CFS) {
        const ok = await processTarget(target, generatedText, checkMode);
        if (!ok) allOk = false;
    }

    if (!allOk) process.exit(1);
}

main().catch(err => {
    console.error(err.stack || err.message || err);
    process.exit(1);
});
