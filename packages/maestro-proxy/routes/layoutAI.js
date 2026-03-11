/**
 * @fileoverview Tördelő AI endpoint-ok.
 *
 * Magazinoldal screenshot-ok elemzése Claude Vision API-val.
 * A stíluskönyv PDF minden hívásnál csatolva van a prompthoz,
 * így az AI a teljes tipográfiai kontextusból dolgozik.
 *
 * Env vars:
 *   ANTHROPIC_API_KEY — Claude API kulcs (kötelező)
 *   LAYOUT_STYLE_GUIDE_PATH — Stíluskönyv PDF útvonala (opcionális, default: assets/stiluskonyv.pdf)
 *
 * @module routes/layoutAI
 */

const express = require('express');
const multer = require('multer');
const Anthropic = require('@anthropic-ai/sdk').default;
const fs = require('fs');
const path = require('path');
const { SYSTEM_PROMPT, buildUserPrompt } = require('../prompts/layoutAnalysis');

const router = express.Router();

// Multer konfiguráció — memóriában tároljuk a feltöltött képet (max 10 MB)
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
        if (allowed.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error(`Nem támogatott fájlformátum: ${file.mimetype}`));
        }
    }
});

/**
 * Betölti a stíluskönyv PDF-et base64-ként.
 * Cache-eli az első betöltés után (a PDF nem változik futás közben).
 *
 * @returns {{ data: string, mediaType: string } | null} Base64 PDF adat vagy null, ha nem elérhető.
 */
let cachedStyleGuide = null;
function loadStyleGuide() {
    if (cachedStyleGuide) return cachedStyleGuide;

    const pdfPath = process.env.LAYOUT_STYLE_GUIDE_PATH
        || path.join(__dirname, '..', 'assets', 'StoryStylebook2020.pdf');

    try {
        if (!fs.existsSync(pdfPath)) {
            console.warn(`[Layout AI] Stíluskönyv nem található: ${pdfPath}`);
            return null;
        }

        const pdfBuffer = fs.readFileSync(pdfPath);
        cachedStyleGuide = {
            data: pdfBuffer.toString('base64'),
            mediaType: 'application/pdf'
        };

        console.log(`[Layout AI] Stíluskönyv betöltve: ${pdfPath} (${(pdfBuffer.length / 1024).toFixed(0)} KB)`);
        return cachedStyleGuide;
    } catch (error) {
        console.error(`[Layout AI] Stíluskönyv betöltési hiba: ${error.message}`);
        return null;
    }
}

/**
 * Meghívja a Claude Vision API-t egy kép elemzéséhez.
 *
 * @param {Anthropic} client - Anthropic SDK kliens.
 * @param {Buffer} imageBuffer - A kép bináris tartalma.
 * @param {string} imageMimeType - A kép MIME típusa.
 * @param {object} options - Elemzési opciók (pageNumbers, pageTypeHint).
 * @returns {Promise<object>} A strukturált elemzési eredmény.
 */
async function analyzeImage(client, imageBuffer, imageMimeType, options = {}) {
    const imageBase64 = imageBuffer.toString('base64');
    const userPrompt = buildUserPrompt(options);

    // Összeállítjuk a content tömböt: stíluskönyv PDF + kép + szöveges prompt
    const content = [];

    // Stíluskönyv PDF csatolása (ha elérhető)
    const styleGuide = loadStyleGuide();
    if (styleGuide) {
        content.push({
            type: 'document',
            source: {
                type: 'base64',
                media_type: styleGuide.mediaType,
                data: styleGuide.data
            }
        });
    }

    // Magazinoldal kép
    content.push({
        type: 'image',
        source: {
            type: 'base64',
            media_type: imageMimeType,
            data: imageBase64
        }
    });

    // Szöveges prompt
    content.push({
        type: 'text',
        text: userPrompt
    });

    const response = await client.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4096,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content }]
    });

    // Válasz kinyerése
    if (!response.content || !Array.isArray(response.content) || response.content.length === 0) {
        throw new Error('Üres válasz a Claude API-tól');
    }

    const textBlock = response.content.find(block => block.type === 'text');
    if (!textBlock || typeof textBlock.text !== 'string') {
        throw new Error('Nem található szöveges válasz a Claude API-tól');
    }

    // JSON kinyerése — markdown code block kezelés
    const responseText = textBlock.text;
    const jsonMatch = responseText.match(/```(?:json)?\s*([\s\S]*?)```/);
    const jsonStr = jsonMatch ? jsonMatch[1].trim() : responseText.trim();

    let parsed;
    try {
        parsed = JSON.parse(jsonStr);
    } catch (parseError) {
        console.error('[Layout AI] JSON parse hiba:', responseText.substring(0, 500));
        throw new Error('Érvénytelen JSON válasz az AI-tól');
    }

    // Alap validálás
    if (!parsed.pageType || typeof parsed.pageType !== 'string') {
        throw new Error('Hiányzó vagy érvénytelen pageType az AI válaszban');
    }

    // Token-használat logolása
    if (response.usage) {
        console.log(
            `[Layout AI] Token-használat: input=${response.usage.input_tokens}, output=${response.usage.output_tokens}`
        );
    }

    return parsed;
}

// --- Egyetlen kép elemzése ---

/**
 * POST /api/analyze-layout
 *
 * Egyetlen magazinoldal screenshot elemzése.
 *
 * Multipart form:
 *   image: JPG/PNG fájl (kötelező)
 *   publicationId: string (opcionális)
 *   pageNumbers: string (opcionális, pl. "12-13")
 *   pageTypeHint: string (opcionális, pl. "leíró")
 */
router.post(
    ['/api/analyze-layout', '/maestro-proxy/api/analyze-layout'],
    upload.single('image'),
    async (req, res) => {
        const apiKey = process.env.ANTHROPIC_API_KEY;
        if (!apiKey) {
            return res.status(501).json({ error: 'Layout AI szolgáltatás nincs konfigurálva (ANTHROPIC_API_KEY hiányzik)' });
        }

        if (!req.file) {
            return res.status(400).json({ error: 'Hiányzó kép — "image" mező kötelező' });
        }

        const { publicationId, pageNumbers, pageTypeHint } = req.body;

        try {
            console.log(
                `[Layout AI] Elemzés indítása: ${req.file.originalname} ` +
                `(${(req.file.size / 1024).toFixed(0)} KB, ${req.file.mimetype})` +
                (pageNumbers ? ` — ${pageNumbers}. oldal` : '')
            );

            const client = new Anthropic({ apiKey });

            const result = await analyzeImage(
                client,
                req.file.buffer,
                req.file.mimetype,
                { pageNumbers, pageTypeHint }
            );

            console.log(
                `[Layout AI] Elemzés kész: ${result.pageType} típus, ` +
                `${result.columnCount || '?'} hasáb, ` +
                `confidence: ${result.confidence || '?'}`
            );

            res.json({
                success: true,
                publicationId: publicationId || null,
                pageNumbers: pageNumbers || result.pageNumbers || null,
                analysis: result
            });
        } catch (error) {
            console.error('[Layout AI] Elemzés hiba:', error.message);

            const statusCode = error.status || 500;
            res.status(statusCode).json({
                error: 'Layout elemzés sikertelen',
                message: error.message
            });
        }
    }
);

// --- Batch elemzés (több kép egyszerre, base64-ként) ---

/**
 * POST /api/analyze-layout-batch
 *
 * Több magazinoldal szekvenciális elemzése.
 *
 * JSON body:
 *   images: [{ base64: string, mimeType: string, pageNumbers: string }]
 *   publicationId: string (opcionális)
 *   pageTypeHint: string (opcionális)
 */
router.post(
    ['/api/analyze-layout-batch', '/maestro-proxy/api/analyze-layout-batch'],
    express.json({ limit: '50mb' }),
    async (req, res) => {
        const apiKey = process.env.ANTHROPIC_API_KEY;
        if (!apiKey) {
            return res.status(501).json({ error: 'Layout AI szolgáltatás nincs konfigurálva (ANTHROPIC_API_KEY hiányzik)' });
        }

        const { images, publicationId, pageTypeHint } = req.body;
        if (!images || !Array.isArray(images) || images.length === 0) {
            return res.status(400).json({ error: 'Hiányzó vagy üres images tömb' });
        }

        if (images.length > 50) {
            return res.status(400).json({ error: 'Maximum 50 kép dolgozható fel egyszerre' });
        }

        const client = new Anthropic({ apiKey });
        const results = [];
        let errorCount = 0;

        console.log(`[Layout AI] Batch elemzés: ${images.length} kép, publicationId=${publicationId || 'nincs'}`);

        for (let i = 0; i < images.length; i++) {
            const img = images[i];

            if (!img.base64 || typeof img.base64 !== 'string') {
                results.push({
                    index: i,
                    pageNumbers: img.pageNumbers || null,
                    status: 'error',
                    error: 'Hiányzó vagy érvénytelen base64 adat'
                });
                errorCount++;
                continue;
            }

            try {
                const imageBuffer = Buffer.from(img.base64, 'base64');
                const mimeType = img.mimeType || 'image/jpeg';

                const analysis = await analyzeImage(
                    client,
                    imageBuffer,
                    mimeType,
                    { pageNumbers: img.pageNumbers, pageTypeHint }
                );

                results.push({
                    index: i,
                    pageNumbers: img.pageNumbers || analysis.pageNumbers || null,
                    status: 'success',
                    analysis
                });

                console.log(`[Layout AI] Batch ${i + 1}/${images.length}: ${analysis.pageType} — OK`);
            } catch (error) {
                results.push({
                    index: i,
                    pageNumbers: img.pageNumbers || null,
                    status: 'error',
                    error: error.message
                });
                errorCount++;

                console.error(`[Layout AI] Batch ${i + 1}/${images.length}: HIBA — ${error.message}`);
            }
        }

        console.log(
            `[Layout AI] Batch kész: ${results.length - errorCount} sikeres, ${errorCount} hibás`
        );

        res.json({
            success: errorCount === 0,
            processedCount: results.length,
            successCount: results.length - errorCount,
            errorCount,
            publicationId: publicationId || null,
            results
        });
    }
);

module.exports = router;
