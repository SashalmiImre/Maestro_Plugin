/**
 * @fileoverview Ellenőrzi, hogy az InDesign dokumentum tartalma egyezik-e az adatbázis rekorddal.
 * Speciálisan az Oldaltartomány (Page Range) érvényességét ellenőrzi InDesign szkriptek segítségével.
 */

import { withTimeout } from "../promiseUtils.js";
import { storage } from "../../config/appwriteConfig.js";
import { callUpdateArticleCF } from "../updateArticleClient.js";
import { BUCKETS } from "maestro-shared/appwriteIds.js";

const { app, ScriptLanguage } = require("indesign");
const { generateExtractPageNumbersInBackground, generateCloseDocumentScript, parsePageRangesResult } = require("../indesign/index.js");

import { ValidatorBase } from "./ValidatorBase.js";
import { MaestroEvent, dispatchMaestroEvent } from "../../config/maestroEvents.js";
import { getFileTimestamp } from "../indesign/indesignUtils.js";

import { log, logWarn } from "../logger.js";

/** Tolerancia a thumbnail feldolgozási időre (export + upload) */
const THUMBNAIL_STALENESS_TOLERANCE_MS = 5000;

export class DatabaseIntegrityValidator extends ValidatorBase {
    constructor() {
        super(ValidatorBase.SCOPES.ARTICLE);
    }

    /**
     * Ellenőrzi, hogy a fizikai InDesign fájl oldalszámai egyeznek-e az adatbázis rekorddal.
     * Ha eltérést talál, képes AUTOMATIKUSAN JAVÍTANI (frissíteni az adatbázist), ha konfigurálva van.
     * 
     * @param {Object} context - { article: Object, autoCorrect: boolean }
     */
    async validate(context) {
        const { article, autoCorrect = false, absoluteFilePath } = context;
        if (!article || !article.filePath) {
            return this.failure("Article or file path missing.");
        }

        // Abszolút útvonal használata (ExtendScript File() nem tud relatívat feloldani)
        const filePath = absoluteFilePath || article.filePath;

        try {
            // 1. Tényleges oldalszámok lekérése az InDesign-ból (Háttér szkript)
            // Megjegyzés: A generateExtractPageNumbersInBackground már nem zárja be a fájlt,
            // nekünk kell gondoskodnunk róla!

            const extractScript = generateExtractPageNumbersInBackground(filePath);
            const result = await app.doScript(extractScript, ScriptLanguage.JAVASCRIPT);

            // Dokumentum azonnali bezárása
            const closeScript = generateCloseDocumentScript(filePath, false);
            await app.doScript(closeScript, ScriptLanguage.JAVASCRIPT);

            if (!result || result.startsWith("ERROR")) {
                return this.failure(`Could not read file metadata: ${result}`);
            }

            const parsed = parsePageRangesResult(result);

            if (!parsed.success) {
                return this.failure(`Could not parse page ranges: ${parsed.error}`);
            }
            
            // 2. Összehasonlítás az ADATBÁZISSAL (context.article)
            const dbRanges = article.pageRanges;
            const physRanges = parsed.pageRanges;

            let mismatch = false;
            let rangeDetails = "";

            // Ha mindkét oldalon megvan a pageRanges (JSON string), akkor ezt használjuk a pontosabb ellenőrzéshez
            if (dbRanges && physRanges) {
                // Először egyszerű string összehasonlítás (gyors)
                if (dbRanges !== physRanges) {
                    // Ha stringként nem egyezik, megpróbáljuk objektumként összevetni (whitespace/sorrend miatt)
                    try {
                        const dbObj = typeof dbRanges === 'string' ? JSON.parse(dbRanges) : dbRanges;
                        const physObj = typeof physRanges === 'string' ? JSON.parse(physRanges) : physRanges;
                        
                        // Újra stringesítjük szabványosan, hogy összehasonlítható legyen
                        const dbNorm = JSON.stringify(dbObj);
                        const physNorm = JSON.stringify(physObj);

                        if (dbNorm !== physNorm) {
                            mismatch = true;
                            rangeDetails = `Ranges: DB(${dbNorm}) != File(${physNorm})`;
                        }
                    } catch (e) {
                         // Ha nem valid JSON valamelyik, akkor string eltérés miatt mismatch van
                         mismatch = true;
                         rangeDetails = "Invalid JSON in pageRanges comparison";
                    }
                }
            } else {
                // Fallback: Ha nincs pageRanges, marad a start/end (Legacy mód)
                const dbStart = article.startPage;
                const dbEnd = article.endPage;
                
                const physStart = parsed.startPage;
                const physEnd = parsed.endPage;

                // Explicit Number konverzió — az API string-eket is küldhet
                mismatch = (Number(dbStart) !== Number(physStart)) || (Number(dbEnd) !== Number(physEnd));
                
                // Csak akkor állítjuk be a rangeDetails-t, ha tényleg eltérés van
                if (mismatch) {
                    rangeDetails = `Pages: DB(${dbStart}-${dbEnd}) != File(${physStart}-${physEnd})`;
                }
            }

            if (mismatch) {
                const errorMsg = `Page mismatch. ${rangeDetails}`;
                
                if (autoCorrect) {
                     // 3. Adatbázis frissítése, ha kérték — az update-article CF-en keresztül
                     log(`[DatabaseIntegrityValidator] Auto-correcting ${article.name}...`);
                     const correctedDoc = await callUpdateArticleCF(
                        article.$id,
                        {
                            startPage: parsed.startPage,
                            endPage: parsed.endPage,
                            pageRanges: parsed.pageRanges
                        },
                        "DatabaseIntegrityValidator: autoCorrect"
                    );

                    // Overlap validáció kiváltása a frissített adatokkal
                    if (typeof window !== 'undefined') {
                        dispatchMaestroEvent(MaestroEvent.pageRangesChanged, {
                            article: correctedDoc
                        });
                    }

                    // A correctedArticle-t a hook fogja felhasználni az optimistic update-hez
                    const validationResult = this.success([`Fixed mismatch: ${errorMsg}`]);
                    validationResult.correctedArticle = correctedDoc;
                    return validationResult;
                }
                
                return this.failure(errorMsg);
            }

            return this.success();

        } catch (error) {
            return this.failure(`Integrity check exception: ${error.message}`);
        }
    }

    /**
     * Ellenőrzi a cikk thumbnail állapotát: hiányzik-e vagy elavult-e.
     * Hiányzó thumbnail (null, üres, érvénytelen JSON) esetén figyelmeztetést ad.
     * Ha létezik, összehasonlítja a fájl módosítási dátumát a thumbnail feltöltési idejével.
     *
     * @param {Object} article - A cikk objektum (thumbnails mező szükséges).
     * @param {string} absoluteFilePath - A fájl abszolút natív útvonala.
     * @returns {Promise<string|null>} Figyelmeztetés szövege, vagy null ha friss / nem ellenőrizhető (Storage hiba).
     */
    async checkThumbnailStaleness(article, absoluteFilePath) {
        const MISSING_MSG = 'Hiányzó thumbnailek: a cikkhez nem tartozik oldalkép.';

        try {
            // Thumbnails JSON feldolgozása — hiányzó thumbnail is warning
            if (!article.thumbnails) return MISSING_MSG;

            let thumbnails;
            try {
                thumbnails = typeof article.thumbnails === 'string'
                    ? JSON.parse(article.thumbnails)
                    : article.thumbnails;
            } catch {
                return MISSING_MSG;
            }

            if (!Array.isArray(thumbnails) || thumbnails.length === 0) return MISSING_MSG;

            // Első thumbnail ellenőrzése (mind egyszerre generálódnak, elég egyet nézni)
            const firstFileId = thumbnails[0]?.fileId;
            if (!firstFileId) return MISSING_MSG;

            // Párhuzamosan: Storage metaadat + fájl módosítási idő
            const [storageFile, fileModified] = await Promise.all([
                withTimeout(
                    storage.getFile({ bucketId: BUCKETS.THUMBNAILS, fileId: firstFileId }),
                    5000,
                    "checkThumbnailStaleness: storage.getFile"
                ).catch(err => {
                    logWarn(`[DatabaseIntegrityValidator] Storage getFile hiba (${firstFileId}):`, err?.message);
                    return null;
                }),
                getFileTimestamp(absoluteFilePath)
            ]);

            if (!storageFile || !fileModified) return null;

            const thumbnailCreated = new Date(storageFile.$createdAt).getTime();
            if (isNaN(thumbnailCreated)) return null;

            // Összehasonlítás toleranciával
            if (fileModified > thumbnailCreated + THUMBNAIL_STALENESS_TOLERANCE_MS) {
                const fileDate = new Date(fileModified).toLocaleString('hu-HU');
                const thumbDate = new Date(thumbnailCreated).toLocaleString('hu-HU');
                return `Elavult thumbnailek: a fájl módosítva ${fileDate}, a thumbnail generálva ${thumbDate}.`;
            }

            return null;
        } catch (error) {
            logWarn("[DatabaseIntegrityValidator] Thumbnail staleness check hiba:", error?.message);
            return null;
        }
    }
}
