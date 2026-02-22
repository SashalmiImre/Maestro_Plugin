/**
 * @fileoverview Névkonvenciók és fájlnév generáló segédfüggvények.
 * A fájlok elnevezésével, formázásával kapcsolatos logikát tartalmazza.
 * 
 * @module utils/namingUtils
 */

/**
 * Generál egy formázott fájlnevet oldalszámokkal kiegészítve.
 * Tipikus felhasználás: PDF exportálás, ahol a fájlnévben szerepelnie kell az oldalszámnak.
 * 
 * Formátum: "Kezdő [Vég] EredetiNév.kiterjesztés"
 * Példa: "005 012 CikkNeve.pdf" vagy "005 CikkNeve.pdf"
 * 
 * @param {string} name - Az eredeti fájlnév vagy cikk név.
 * @param {number|string|null} startPage - Kezdő oldalszám.
 * @param {number|string|null} endPage - Utolsó oldalszám.
 * @param {number} maxPage - A kiadvány utolsó oldalszáma vagy teljes oldalszám (a padding hosszához). Ha nincs megadva, 3 digitet feltételez (999).
 * @param {string} [extension=".pdf"] - A kívánt kimeneti kiterjesztés (ponttal).
 * @returns {string} A formázott fájlnév.
 */
export const formatPagedFileName = (name, startPage, endPage, maxPage, extension = ".pdf") => {
    // Padding meghatározása
    // Ha nincs maxPage, alapértelmezett 3 (biztonságos magazinokhoz)
    const paddingLength = (maxPage || 999).toString().length;

    const pad = (num) => String(num).padStart(paddingLength, "0");

    let prefix = "";
    
    // Csak akkor teszünk prefixet, ha van érvényes kezdő oldalszám
    if (startPage !== null && startPage !== undefined && startPage !== "") {
        prefix += pad(startPage);
        
        // Ha van végoldal és különbözik a kezdőtől
        if (endPage !== null && endPage !== undefined && endPage !== "" && String(endPage) !== String(startPage)) {
            prefix += " " + pad(endPage);
        }
        
        prefix += " "; // Elválasztó szóköz
    }

    // Név tisztítása (eredeti kiterjesztés levágása, ha van)
    // Feltételezzük, hogy a bemeneti névnek lehet .indd kiterjesztése
    const cleanName = name.replace(/\.indd$/i, "");
    
    // Ha a kiterjesztés nem ponttal kezdődik, tegyünk elé
    const safeExtension = extension.startsWith(".") ? extension : `.${extension}`;

    return `${prefix}${cleanName}${safeExtension}`;
};
