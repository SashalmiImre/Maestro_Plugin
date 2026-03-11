/**
 * @fileoverview Tördelő AI kliens-oldali feldolgozó.
 *
 * Az AI elemzés eredményeinek validálása, Appwrite-ba mentése,
 * és képfájlok feltöltése a Storage bucket-be.
 *
 * @module utils/layoutAIProcessor
 */

import { databases, storage } from "../config/appwriteConfig.js";
import {
    DATABASE_ID,
    LAYOUT_PRECEDENTS_COLLECTION_ID,
    LAYOUT_SCREENSHOTS_BUCKET_ID
} from "../config/appwriteConfig.js";
import { ID } from "appwrite";
import { logError, log } from "./logger.js";

/** Az AI válaszban elfogadott oldaltípusok. */
const VALID_PAGE_TYPES = [
    'leíró', 'szekciós', 'parti', 'női_extra', 'tányér', 'horoszkóp', 'egyéb'
];

/**
 * Validálja az AI elemzés eredményét.
 *
 * @param {object} result - Az AI-tól kapott elemzési JSON.
 * @returns {{ valid: boolean, errors: string[] }} Validálási eredmény.
 */
export function validateAnalysisResult(result) {
    const errors = [];

    if (!result || typeof result !== 'object') {
        return { valid: false, errors: ['Az elemzési eredmény nem objektum'] };
    }

    if (!result.pageType || typeof result.pageType !== 'string') {
        errors.push('Hiányzó vagy érvénytelen pageType');
    } else if (!VALID_PAGE_TYPES.includes(result.pageType)) {
        errors.push(`Ismeretlen pageType: "${result.pageType}"`);
    }

    if (result.columnCount !== undefined && (typeof result.columnCount !== 'number' || result.columnCount < 1)) {
        errors.push('Érvénytelen columnCount');
    }

    if (result.confidence !== undefined && (typeof result.confidence !== 'number' || result.confidence < 0 || result.confidence > 1)) {
        errors.push('Érvénytelen confidence (0-1 közötti szám szükséges)');
    }

    return { valid: errors.length === 0, errors };
}

/**
 * Feltölti a screenshot képet az Appwrite Storage-ba.
 *
 * @param {ArrayBuffer|Blob} imageData - A kép bináris tartalma.
 * @param {string} fileName - A fájl neve (pl. "spread_001.jpg").
 * @returns {Promise<string>} A feltöltött fájl ID-ja.
 */
export async function uploadScreenshot(imageData, fileName) {
    const file = await storage.createFile({
        bucketId: LAYOUT_SCREENSHOTS_BUCKET_ID,
        fileId: ID.unique(),
        file: new File([imageData], fileName, { type: 'image/jpeg' })
    });

    log(`[Layout AI] Screenshot feltöltve: ${fileName} → ${file.$id}`);
    return file.$id;
}

/**
 * Eltárol egy layout precedenst az Appwrite adatbázisban.
 *
 * @param {object} analysisResult - Az AI elemzési eredménye.
 * @param {object} metadata - Kiegészítő metaadatok.
 * @param {string} [metadata.publicationId] - Kiadvány ID.
 * @param {string} [metadata.pageNumbers] - Oldalszámok.
 * @param {string} [metadata.screenshotFileId] - Storage fájl ID.
 * @returns {Promise<object>} A létrehozott dokumentum.
 */
export async function storeLayoutPrecedent(analysisResult, metadata = {}) {
    // Validálás
    const validation = validateAnalysisResult(analysisResult);
    if (!validation.valid) {
        const errorMsg = `Érvénytelen elemzési eredmény: ${validation.errors.join(', ')}`;
        logError('[Layout AI]', errorMsg);
        throw new Error(errorMsg);
    }

    // Kép-szöveg arány kinyerése
    let imageToTextRatio = null;
    if (analysisResult.layoutNotes?.textImageRatio) {
        const match = analysisResult.layoutNotes.textImageRatio.match(/(\d+)_(\d+)/);
        if (match) {
            const imagePercent = parseInt(match[2], 10);
            imageToTextRatio = imagePercent / 100;
        }
    }

    // Tag-ek összegyűjtése a különböző forrásokból
    const tags = [];
    if (analysisResult.colorScheme?.mood) tags.push(analysisResult.colorScheme.mood);
    if (analysisResult.layoutNotes?.structure) tags.push(analysisResult.layoutNotes.structure);
    if (analysisResult.layoutNotes?.gridType) tags.push(analysisResult.layoutNotes.gridType);

    // Nyitókép detektálás
    const hasOpeningImage = Array.isArray(analysisResult.images) &&
        analysisResult.images.some(img =>
            img.role === 'opening' || img.size === 'very_large' || img.size === 'large'
        );

    const data = {
        publicationId: metadata.publicationId || null,
        pageType: analysisResult.pageType,
        pageNumbers: metadata.pageNumbers || analysisResult.pageNumbers || null,
        screenshotFileId: metadata.screenshotFileId || null,
        layoutDescription: JSON.stringify(analysisResult),
        columnCount: analysisResult.columnCount || null,
        imageToTextRatio,
        hasOpeningImage,
        tags,
        analysisModel: 'claude-sonnet-4-20250514',
        confidence: analysisResult.confidence || null
    };

    const document = await databases.createDocument({
        databaseId: DATABASE_ID,
        collectionId: LAYOUT_PRECEDENTS_COLLECTION_ID,
        documentId: ID.unique(),
        data
    });

    log(
        `[Layout AI] Precedens eltárolva: ${data.pageType}, ${data.columnCount || '?'} hasáb ` +
        `(${document.$id})`
    );

    return document;
}

/**
 * Teljes feldolgozás: screenshot feltöltés + precedens mentés.
 *
 * @param {object} analysisResult - Az AI elemzési eredménye.
 * @param {ArrayBuffer|Blob|null} imageData - A kép bináris tartalma (ha van).
 * @param {string} fileName - A fájl neve.
 * @param {object} metadata - Kiegészítő metaadatok (publicationId, pageNumbers).
 * @returns {Promise<object>} A létrehozott precedens dokumentum.
 */
export async function processAndStore(analysisResult, imageData, fileName, metadata = {}) {
    let screenshotFileId = null;

    // Screenshot feltöltés (ha van képadat)
    if (imageData) {
        try {
            screenshotFileId = await uploadScreenshot(imageData, fileName);
        } catch (uploadError) {
            logError('[Layout AI]', `Screenshot feltöltés sikertelen: ${uploadError.message}`);
            // Folytatjuk screenshot nélkül — a precedens még mindig értékes
        }
    }

    // Precedens mentés
    return storeLayoutPrecedent(analysisResult, {
        ...metadata,
        screenshotFileId
    });
}
