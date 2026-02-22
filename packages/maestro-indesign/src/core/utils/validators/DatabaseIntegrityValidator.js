/**
 * @fileoverview Ellenőrzi, hogy az InDesign dokumentum tartalma egyezik-e az adatbázis rekorddal.
 * Speciálisan az Oldaltartomány (Page Range) érvényességét ellenőrzi InDesign szkriptek segítségével.
 */

import { withTimeout } from "../promiseUtils.js";
import { tables, DATABASE_ID, ARTICLES_COLLECTION_ID } from "../../config/appwriteConfig.js";

const { app, ScriptLanguage } = require("indesign");
const { generateExtractPageNumbersInBackground, generateCloseDocumentScript, parsePageRangesResult } = require("../indesign/index.js");

import { ValidatorBase } from "./ValidatorBase.js";
import { MaestroEvent, dispatchMaestroEvent } from "../../config/maestroEvents.js";

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
        const { article, autoCorrect = false } = context;
        if (!article || !article.filePath) {
            return this.failure("Article or file path missing.");
        }

        try {
            // 1. Tényleges oldalszámok lekérése az InDesign-ból (Háttér szkript)
            // Megjegyzés: A generateExtractPageNumbersInBackground már nem zárja be a fájlt,
            // nekünk kell gondoskodnunk róla!
            
            const extractScript = generateExtractPageNumbersInBackground(article.filePath);
            const result = await app.doScript(extractScript, ScriptLanguage.JAVASCRIPT);

            // Dokumentum azonnali bezárása
            const closeScript = generateCloseDocumentScript(article.filePath, false);
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

                // Use loose check (==) because API might return strings for numbers
                mismatch = (dbStart != physStart) || (dbEnd != physEnd);
                
                // Csak akkor állítjuk be a rangeDetails-t, ha tényleg eltérés van
                if (mismatch) {
                    rangeDetails = `Pages: DB(${dbStart}-${dbEnd}) != File(${physStart}-${physEnd})`;
                }
            }

            if (mismatch) {
                const errorMsg = `Page mismatch. ${rangeDetails}`;
                
                if (autoCorrect) {
                     // 3. Adatbázis frissítése, ha kérték
                     console.log(`[DatabaseIntegrityValidator] Auto-correcting ${article.name}...`);
                     const correctedDoc = await withTimeout(
                        tables.updateRow({
                            databaseId: DATABASE_ID,
                            tableId: ARTICLES_COLLECTION_ID,
                            rowId: article.$id,
                            data: {
                                startPage: parsed.startPage,
                                endPage: parsed.endPage,
                                pageRanges: parsed.pageRanges
                                // NE használjunk modifiedByClientId-t, mert az megmarad az adatbázisban
                                // és a realtime kiszűri a jövőbeli frissítéseket!
                            }
                        }),
                        5000,
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
}
