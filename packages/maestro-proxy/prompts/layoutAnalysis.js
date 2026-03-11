/**
 * @fileoverview Tördelő AI prompt template-ek.
 *
 * A Claude Vision API-nak küldött prompt, amely a Story magazin
 * stíluskönyve alapján elemzi a magazinoldalak elrendezését.
 *
 * @module prompts/layoutAnalysis
 */

/**
 * System prompt a layout elemzéshez.
 * Tartalmazza az oldaltípus-definíciókat és az elvárt output sémát.
 */
const SYSTEM_PROMPT = `Te egy magyar női magazin (Story) tördelési szakértő AI vagy.

Feladatod: egy magazinoldal (vagy oldalpár/spread) screenshot-ját elemezni, és strukturált JSON-ban leírni az elrendezését. A csatolt PDF a magazin stíluskönyve — használd referenciaként az oldaltípusok, hasábszerkezetek és tipográfiai szabályok megértéséhez.

OLDALTÍPUSOK (a stíluskönyv alapján):
- "leíró": Klasszikus cikk oldal. 4 hasáb, domináns nyitókép, folyószöveg, lead, kiemelések. Szöveg-kép arány ~40-60%.
- "szekciós": Szekciókra bontott anyag, minden szekciónak saját alcíme és képe van. 4-5 hasáb.
- "parti": Eseménybeszámoló/galéria. Képdominált (~80% kép), sok kis fotó névfeliratokkal, nyilak a személyekre mutatva. Minimális szöveg (lead + képaláírások).
- "női_extra": Női Extra rovat. 5 hasáb, termékfotók, celeb referenciák, tipp-dobozok, szekciók. Organikus, lebegő elrendezés.
- "tányér": Étkezési napló formátum. Központi portré + lebegő ételfotók, étkezés-szekciók (reggeli, ebéd, stb.).
- "horoszkóp": 12 csillagjegy rács (3×4), ikonok, kiemelt celeb, dátumtartomány. Erősen sablonos, adatvezérelt.
- "egyéb": Ha egyik sem illik, használd ezt.

ELEMZÉSI SZEMPONTOK:
1. Oldaltípus azonosítása
2. Hasábszerkezet (hány hasáb, margók)
3. Vizuális elemek felsorolása pozícióval és mérettel
4. Színséma (domináns szín, hangulat)
5. Tipográfiai jellemzők (cím, lead, törzsszöveg méretei)
6. Speciális elemek (kiemelések, keretes szövegek, nyilak, badge-ek)
7. Szöveg-kép arány becslése`;

/**
 * A layout elemzés elvárt output JSON sémája.
 * A user prompt-ba kerül, hogy a modell tudja, milyen formátumot várunk.
 */
const OUTPUT_SCHEMA = `Válaszolj KIZÁRÓLAG érvényes JSON-nel, semmilyen más szöveggel. A JSON struktúra:

{
  "pageType": "leíró|szekciós|parti|női_extra|tányér|horoszkóp|egyéb",
  "pageNumbers": "12-13",
  "columnCount": 4,
  "colorScheme": {
    "primary": "#HEX",
    "mood": "positive_warm|negative_cold|neutral|celebratory|fresh_healthy|structured"
  },
  "titleStructure": {
    "cim": "A cikk főcíme",
    "felcim": "Felcím (ha van, egyébként null)",
    "alcim": "Alcím/lead szövege (ha van)",
    "szerzo": "Szerző neve (ha látható)",
    "cimPosition": "top_left|center|image_overlay|stb.",
    "cimSize": "small|medium|large|very_large"
  },
  "images": [
    {
      "role": "opening|portrait|product|gallery_item|food|celeb|icon",
      "subject": "Rövid leírás, mit ábrázol",
      "position": "center_dominant|top_left|bottom_right|stb.",
      "size": "very_large|large|medium|small|tiny",
      "columnsSpan": 2,
      "bleed": true,
      "nameLabel": "Személy neve (ha van)",
      "caption": "Képaláírás (ha van)"
    }
  ],
  "textElements": [
    {
      "type": "headline|lead|body|caption|pullQuote|sidebar|subheading|byline|productInfo|tipp",
      "position": "col1_top|center_below_image|stb.",
      "estimatedFontSize": "9pt|12pt|24pt|stb.",
      "columnsSpan": 1
    }
  ],
  "specialElements": [
    {
      "type": "kiemeles|keretes|badge|arrow|nameLabel|productShot|tippBox|promoBox|disclaimer",
      "text": "Az elem szövege (ha van)",
      "position": "over_image|left_bottom|stb.",
      "style": "inverse_yellow|colored_box|red_circle|stb."
    }
  ],
  "layoutNotes": {
    "textImageRatio": "40_60",
    "structure": "linear_narrative|gallery_with_central_portrait|sections_with_tips|stb.",
    "gridType": "strict_columns|organic_floating|mixed",
    "arrowConnectors": false,
    "nameLabelStyle": "over_image|below_image|none"
  },
  "confidence": 0.85
}`;

/**
 * Összeállítja a user prompt-ot az elemzéshez.
 *
 * @param {object} options - Prompt opciók.
 * @param {string} [options.pageNumbers] - Oldalszámok (pl. "12-13").
 * @param {string} [options.pageTypeHint] - Oldaltípus hint (ha a felhasználó megadta).
 * @returns {string} A user prompt szövege.
 */
function buildUserPrompt(options = {}) {
    const parts = ['Elemezd ezt a Story magazin oldalt/oldalpárt a mellékelt stíluskönyv alapján.'];

    if (options.pageNumbers) {
        parts.push(`Oldalszámok: ${options.pageNumbers}.`);
    }

    if (options.pageTypeHint) {
        parts.push(`A felhasználó jelzése szerint ez egy "${options.pageTypeHint}" típusú oldal — de ellenőrizd a kép alapján.`);
    }

    parts.push('');
    parts.push(OUTPUT_SCHEMA);

    return parts.join('\n');
}

module.exports = {
    SYSTEM_PROMPT,
    OUTPUT_SCHEMA,
    buildUserPrompt
};
