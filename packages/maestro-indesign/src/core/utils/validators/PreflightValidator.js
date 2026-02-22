/**
 * @fileoverview Preflight ellenőrzés InDesign dokumentumokon.
 * A profilt .idpp fájlból tölti be (src/assets/Levil.idpp), vagy fallback-ként
 * a meglévő "Levil" profilt használja az InDesign-ból.
 */

import { ValidatorBase } from "./ValidatorBase.js";
import { executeScript } from "../indesign/indesignUtils.js";
import { generatePreflightScript, parsePreflightResult } from "../indesign/index.js";

/** Plugin assets mappa natív elérési útja (cachelve az első sikeres lekérés után). */
let cachedAssetsPath = null;

/**
 * Visszaadja a plugin assets mappájának natív elérési útját.
 * @returns {Promise<string|null>}
 */
async function getAssetsPath() {
    if (cachedAssetsPath) return cachedAssetsPath;
    try {
        const uxp = require("uxp");
        const pluginFolder = await uxp.storage.localFileSystem.getPluginFolder();
        const assetsFolder = await pluginFolder.getEntry("assets");
        cachedAssetsPath = assetsFolder.nativePath;
        return cachedAssetsPath;
    } catch (e) {
        console.warn("[PreflightValidator] Plugin assets mappa nem elérhető:", e.message);
        return null;
    }
}

export class PreflightValidator extends ValidatorBase {
    constructor() {
        super(ValidatorBase.SCOPES.ARTICLE);
    }

    /**
     * Preflight ellenőrzést futtat a megadott cikk InDesign fájlján.
     *
     * @param {Object} context - { article: Object }
     * @returns {Promise<Object>} Validációs eredmény { isValid, errors[], warnings[], timestamp }
     */
    async validate(context) {
        const { article, options } = context;

        if (!article || !article.filePath) {
            return this.failure("Cikk vagy fájl útvonal hiányzik a preflight ellenőrzéshez.");
        }

        try {
            // 1. Preflight profil .idpp útvonal feloldása
            const assetsPath = await getAssetsPath();
            // Default to "Levil" if not specified
            const profileName = options?.profile || "Levil";
            const profileFile = options?.profileFile || "Levil.idpp";
            
            const profilePath = assetsPath ? `${assetsPath}/${profileFile}` : null;

            // 2. Preflight script generálása és futtatása
            const script = generatePreflightScript(article.filePath, profilePath, profileName);
            const result = await executeScript(script);

            // 2. Eredmény feldolgozása
            const parsed = parsePreflightResult(result);

            if (!parsed.success) {
                return this.failure(`Preflight futtatási hiba: ${parsed.error}`);
            }

            // Csatolatlan meghajtók → preflight kihagyva (hamis pozitívok megelőzése)
            // `skipped` flag jelzi a hooknak, hogy NE frissítse a validációs eredményeket —
            // a korábbi preflight eredmények megmaradnak, a felhasználó toast-ban kap értesítést.
            if (parsed.unmountedDrives && parsed.unmountedDrives.length > 0) {
                return { ...this.failure([]), skipped: true, unmountedDrives: parsed.unmountedDrives };
            }

            // 3. Ha nincs hiba, sikeres
            if (parsed.errorCount === 0) {
                return this.success();
            }

            // 4. Hibák formázása hierarchikus szöveggé
            const formatted = this._formatHierarchical(parsed.items);
            if (formatted) {
                return this.failure(formatted);
            }

            // 5. Fallback: lapos lista
            const flat = this._formatFlat(parsed.items);
            if (flat.length > 0) {
                return this.failure(flat);
            }

            // 6. Végső fallback
            const fallback = parsed.parseError
                ? `Preflight: ${parsed.errorCount} hiba (${parsed.parseError})`
                : `Preflight: ${parsed.errorCount} hiba található`;
            return this.failure(fallback);

        } catch (error) {
            return this.failure(`Preflight kivétel: ${error.message}`);
        }
    }

    /**
     * Hierarchikus formázás a preflight eredményekből.
     *
     * Két formátumot kezel:
     * A) aggregatedResults[2] — lapos: [category, description, page, objectInfo]
     * B) Szintezett adat: [level("1"/"2"/"3"), name, page, ...]
     *
     * Kimenet (többsoros string, szóközökkel jelzett behúzás):
     *   1. oldal
     *       LINKS
     *           Missing link (6)
     *       COLOR
     *           Content is RGB (2)
     *   3. oldal
     *       TEXT
     *           Overset text (1)
     *
     * @param {Array} items - Parsed items from parsePreflightResult
     * @returns {string|null} Formázott szöveg vagy null ha üres
     */
    _formatHierarchical(items) {
        if (!items || items.length === 0) return null;

        const firstVal = String(items[0]?.[0] || "").trim();
        const isLeveled = ["1", "2", "3"].includes(firstVal);

        const pageGroups = isLeveled
            ? this._groupByLevels(items)
            : this._groupByFlat(items);

        if (pageGroups.size === 0) return null;

        // Formázott szöveg összeállítása
        const lines = [];
        const pages = [...pageGroups.keys()].sort((a, b) => Number(a) - Number(b));

        for (const page of pages) {
            lines.push(`${page}. oldal`);
            const catMap = pageGroups.get(page);
            for (const [cat, ruleMap] of catMap) {
                lines.push(`    ${cat}`);
                for (const [rule, count] of ruleMap) {
                    lines.push(`        ${rule} (${count})`);
                }
            }
        }

        return lines.join("\n");
    }

    /**
     * Csoportosítás lapos adatból: [category, description, page, objectInfo]
     * @returns {Map<string, Map<string, Map<string, number>>>} page → category → { description → count }
     */
    _groupByFlat(items) {
        const pageGroups = new Map();

        for (const item of items) {
            const category = (item[0] || "Egyéb").trim();
            const description = (item[1] || "Hiba").trim();
            const page = (item[2] || "?").trim();

            if (!pageGroups.has(page)) pageGroups.set(page, new Map());
            const catMap = pageGroups.get(page);
            if (!catMap.has(category)) catMap.set(category, new Map());
            const descMap = catMap.get(category);
            descMap.set(description, (descMap.get(description) || 0) + 1);
        }

        return pageGroups;
    }

    /**
     * Csoportosítás szintezett adatból: [level("1"/"2"/"3"), name, page, ...]
     * @returns {Map<string, Map<string, Map<string, number>>>} page → category → { rule → count }
     */
    _groupByLevels(items) {
        const pageGroups = new Map();
        let currentCategory = "";
        let currentRule = "";

        for (const item of items) {
            const level = String(item[0] || "").trim();
            const name = (item[1] || "").trim();
            const page = (item[2] || "").trim();

            if (level === "1") {
                currentCategory = name.replace(/\s*\(\d+\)\s*$/, "");
                currentRule = "";
            } else if (level === "2") {
                currentRule = name.replace(/\s*\(\d+\)\s*$/, "");
            } else if (level === "3") {
                const pageKey = page || "?";
                if (!pageGroups.has(pageKey)) pageGroups.set(pageKey, new Map());
                const catMap = pageGroups.get(pageKey);
                const cat = currentCategory || "Egyéb";
                if (!catMap.has(cat)) catMap.set(cat, new Map());
                const ruleMap = catMap.get(cat);
                const rule = currentRule || "Hiba";
                ruleMap.set(rule, (ruleMap.get(rule) || 0) + 1);
            }
        }

        return pageGroups;
    }

    /**
     * Lapos formázás (processResults fallback, oldal nélküli adatok).
     * item = [kategória, leírás, oldal, objektumInfo]
     *
     * @param {Array} items
     * @returns {string[]} Formázott hibaüzenetek tömbje
     */
    _formatFlat(items) {
        return (items || []).map(item => {
            const parts = [];
            if (item[0]) parts.push(item[0]);
            if (item[1]) parts.push(item[1]);
            if (item[2]) parts.push("Oldal: " + item[2]);
            return parts.join(" — ");
        }).filter(Boolean);
    }
}
