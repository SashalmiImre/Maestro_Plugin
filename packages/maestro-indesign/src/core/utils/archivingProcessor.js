/**
 * @fileoverview Archiválás feldolgozó — klaszterezés, osztályozás, kimenet-generálás.
 *
 * Ez a modul kapja az InDesign scriptből visszakapott nyers JSON adatot
 * (`generateExtractArticleDataScript` kimenete), és elvégzi a teljes feldolgozást:
 *
 *  1. Union-Find klaszterezés (logikailag összekötő grafikai elem, Group-tagság,
 *     threading, térbeli közelség — Z-order és spread-figyelembevétellel)
 *  2. Layout-típus felismerés (hosszú szöveges / fragmentált mód)
 *  3. Szövegtípus-osztályozás (CÍM, LEAD, KÖZCÍM, KIEMELÉS, KERETES, KENYÉRSZÖVEG,
 *     KÉPALÁÍRÁS)
 *  4. Plain text (.txt) és XML (.xml) tartalom generálása
 *
 * A polygon-átfedés számítása tényleges terület alapján történik
 * (Shoelace-formula + Sutherland-Hodgman clipping), nem bounding box közelítéssel.
 *
 * @module utils/archivingProcessor
 */

// --- Konstansok ---

/** Térbeli közelség küszöbértéke pontban */
const PROX_THRESHOLD = 30;

/** Logikailag összekötő grafikai elem átfedési küszöb (szövegkeret területének aránya) */
const OVERLAP_THRESHOLD = 0.80;

// --- Geometriai segédfüggvények ---

/**
 * Bounding box területe [y1,x1,y2,x2] formátumból.
 * @param {number[]} b
 * @returns {number}
 */
function bboxArea(b) {
    return Math.abs((b[2] - b[0]) * (b[3] - b[1]));
}

/**
 * Két [y1,x1,y2,x2] bounding box átfedési területe.
 * @param {number[]} b1
 * @param {number[]} b2
 * @returns {number}
 */
function bboxOverlapArea(b1, b2) {
    const oy1 = Math.max(b1[0], b2[0]);
    const ox1 = Math.max(b1[1], b2[1]);
    const oy2 = Math.min(b1[2], b2[2]);
    const ox2 = Math.min(b1[3], b2[3]);
    if (oy2 <= oy1 || ox2 <= ox1) return 0;
    return (oy2 - oy1) * (ox2 - ox1);
}

/**
 * Két [y1,x1,y2,x2] bounding box minimális távolsága.
 * @param {number[]} b1
 * @param {number[]} b2
 * @returns {number}
 */
function bboxDist(b1, b2) {
    const dy = Math.max(0, Math.max(b1[0], b2[0]) - Math.min(b1[2], b2[2]));
    const dx = Math.max(0, Math.max(b1[1], b2[1]) - Math.min(b1[3], b2[3]));
    return Math.sqrt(dx * dx + dy * dy);
}

/**
 * A szövegkeret középpontja az ovális belsejében van-e (ellipszis-egyenlet).
 * @param {number} py - Középpont Y koordinátája
 * @param {number} px - Középpont X koordinátája
 * @param {number[]} bounds - Az ovális bounding boxja [y1,x1,y2,x2]
 * @returns {boolean}
 */
function isPointInOval(py, px, bounds) {
    const cy = (bounds[0] + bounds[2]) / 2;
    const cx = (bounds[1] + bounds[3]) / 2;
    const ry = (bounds[2] - bounds[0]) / 2;
    const rx = (bounds[3] - bounds[1]) / 2;
    if (ry <= 0 || rx <= 0) return false;
    const dy = (py - cy) / ry;
    const dx = (px - cx) / rx;
    return (dx * dx + dy * dy) <= 1;
}

/**
 * Polygon terület a Shoelace-formula alapján.
 * @param {number[][]} pts - Csúcslista [[y,x], ...] (InDesign bounds formátum: [row, col])
 * @returns {number}
 */
function shoelaceArea(pts) {
    const n = pts.length;
    if (n < 3) return 0;
    let area = 0;
    for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        area += pts[i][0] * pts[j][1];
        area -= pts[j][0] * pts[i][1];
    }
    return Math.abs(area) / 2;
}

/**
 * Sutherland-Hodgman algoritmus: polygon clipping egy tengelyigazított téglalapra.
 * A clip téglalapot [y1,x1,y2,x2] formátumban adja meg a bounding box.
 *
 * @param {number[][]} subject - Vágandó polygon csúcsai [[y,x], ...]
 * @param {number[]}   clip    - Vágó téglalap [y1,x1,y2,x2]
 * @returns {number[][]} A metszet polygon csúcsai
 */
function suthHodgman(subject, clip) {
    if (!subject || subject.length < 3) return [];

    const [cy1, cx1, cy2, cx2] = clip;

    // 4 vágó él (balra, jobbra, felfelé, lefelé)
    const edges = [
        { inside: p => p[1] >= cx1, intersect: (a, b) => { const t = (cx1 - a[1]) / (b[1] - a[1]); return [a[0] + t * (b[0] - a[0]), cx1]; } },
        { inside: p => p[1] <= cx2, intersect: (a, b) => { const t = (cx2 - a[1]) / (b[1] - a[1]); return [a[0] + t * (b[0] - a[0]), cx2]; } },
        { inside: p => p[0] >= cy1, intersect: (a, b) => { const t = (cy1 - a[0]) / (b[0] - a[0]); return [cy1, a[1] + t * (b[1] - a[1])]; } },
        { inside: p => p[0] <= cy2, intersect: (a, b) => { const t = (cy2 - a[0]) / (b[0] - a[0]); return [cy2, a[1] + t * (b[1] - a[1])]; } }
    ];

    let output = subject.slice();
    for (const edge of edges) {
        if (output.length === 0) return [];
        const input = output;
        output = [];
        for (let i = 0; i < input.length; i++) {
            const curr = input[i];
            const prev = input[(i + input.length - 1) % input.length];
            const currIn = edge.inside(curr);
            const prevIn = edge.inside(prev);
            if (currIn) {
                if (!prevIn) output.push(edge.intersect(prev, curr));
                output.push(curr);
            } else if (prevIn) {
                output.push(edge.intersect(prev, curr));
            }
        }
    }
    return output;
}

/**
 * Meghatározza, hogy egy szövegkeret szignifikáns átfedésben van-e egy grafikai elemmel
 * (logikailag összekötő grafikai elem vizsgálat).
 *
 * - Téglalap / képkeret: bounding box átfedési arány
 * - Ovális: szövegkeret középpontja az ellipszis belsejében van-e
 * - Sokszög: tényleges polygon–téglalap metszet (Shoelace + Sutherland-Hodgman)
 *
 * @param {number[]} tfBounds - Szövegkeret bounds [y1,x1,y2,x2]
 * @param {object}   ge       - Grafikai elem { bounds, type, pts }
 * @returns {boolean}
 */
function hasSignificantOverlap(tfBounds, ge) {
    const tfArea = bboxArea(tfBounds);
    if (tfArea <= 0) return false;

    if (ge.type === 'oval') {
        const cpy = (tfBounds[0] + tfBounds[2]) / 2;
        const cpx = (tfBounds[1] + tfBounds[3]) / 2;
        return isPointInOval(cpy, cpx, ge.bounds);
    }

    if (ge.type === 'polygon' && ge.pts && ge.pts.length >= 3) {
        // Tényleges polygon terület alapú átfedés
        const clipped = suthHodgman(ge.pts, tfBounds);
        const intersectArea = shoelaceArea(clipped);
        return (intersectArea / tfArea) >= OVERLAP_THRESHOLD;
    }

    // Téglalap és képkeret: bounding box
    const ov = bboxOverlapArea(tfBounds, ge.bounds);
    return (ov / tfArea) >= OVERLAP_THRESHOLD;
}

// --- Union-Find ---

/**
 * Union-Find inicializálás.
 * @param {number} n
 * @returns {number[]}
 */
function ufInit(n) {
    return Array.from({ length: n }, (_, i) => i);
}

/**
 * Union-Find keresés path compression-nel.
 * @param {number[]} ufP
 * @param {number} x
 * @returns {number}
 */
function ufFind(ufP, x) {
    while (ufP[x] !== x) {
        ufP[x] = ufP[ufP[x]];
        x = ufP[x];
    }
    return x;
}

/**
 * Union-Find összekötés.
 * @param {number[]} ufP
 * @param {number} x
 * @param {number} y
 */
function ufUnion(ufP, x, y) {
    ufP[ufFind(ufP, x)] = ufFind(ufP, y);
}

// --- Story elemzés ---

/**
 * Bekezdésstílus névből típus-hint.
 * @param {string} name
 * @returns {string|null}
 */
function styleHint(name) {
    const n = (name || '').toUpperCase();
    if (/C[IÍ]M|TITLE|HEAD|FEJL|RUBR/.test(n))  return 'CIM';
    if (/LEAD|BEVEZET|INTRO/.test(n))              return 'LEAD';
    if (/K[EÉ]P|CAPTION|FOTO/.test(n))            return 'KEPALAIRAS';
    if (/KERET|BOX|SIDEBAR/.test(n))               return 'KERETES';
    if (/K[OÖ]ZC[IÍ]M|SUBHEAD|ALC/.test(n))      return 'KOZCIM';
    return null;
}

/**
 * Egy story bekezdés-adatainak elemzése: betűméret-statisztikák, domináns stílushint.
 *
 * @param {object[]} paragraphs - A story bekezdés-listája (InDesign scriptből)
 * @param {string}   rawText    - A story teljes szövege
 * @returns {object} { raw, totalN, avgFs, maxFs, paras, domHint, type }
 */
function analyzeStory(paragraphs, rawText) {
    let maxFs = 0, wSum = 0, wCount = 0;
    const hints = {};
    const paras = [];

    for (const para of paragraphs) {
        const pn = para.charCount;
        if (pn === 0) { paras.push({ t: para.text, fs: 12, n: 0, hint: null }); continue; }
        const fs = para.fontSize > 0 ? para.fontSize : 12;
        const h  = styleHint(para.styleName);
        if (fs > maxFs) maxFs = fs;
        wSum += fs * pn;
        wCount += pn;
        if (h) hints[h] = (hints[h] || 0) + 1;
        paras.push({ t: para.text, fs, n: pn, hint: h });
    }

    let domHint = null, domCnt = 0;
    for (const h in hints) {
        if (hints[h] > domCnt) { domCnt = hints[h]; domHint = h; }
    }

    return {
        raw: rawText,
        totalN: wCount,
        avgFs: wCount > 0 ? wSum / wCount : 12,
        maxFs,
        paras,
        domHint,
        type: 'EGYEB'
    };
}

// --- Kimenet generálás segédfüggvények ---

/** XML speciális karakterek escape-elése */
function escXml(s) {
    return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** String trimmelése (whitespace eltávolítása) */
function trim(s) {
    return (s || '').replace(/^\s+|\s+$/g, '');
}

// --- Fő feldolgozó ---

/**
 * Feldolgozza az InDesign scriptből kapott nyers JSON adatot:
 * klaszterezés, típusosztályozás, TXT + XML generálás.
 *
 * @param {object} rawData - Az `generateExtractArticleDataScript` által visszaadott
 *   parsed JSON: `{ spreads, textFrames, graphicElements }`.
 * @returns {{ txtContent: string, xmlContent: string }}
 * @throws {Error} Ha a feldolgozás sikertelen.
 */
export function processArticleData(rawData) {
    const { textFrames, graphicElements } = rawData;

    if (!textFrames || textFrames.length === 0) {
        throw new Error('Nem találhatók szövegkeretek az oldalakon');
    }

    const n = textFrames.length;
    const ufP = ufInit(n);

    // --- 1. Threading (azonos storyId) → Union-Find ---
    const sRep = {};
    for (let i = 0; i < n; i++) {
        const sid = String(textFrames[i].storyId);
        if (sRep.hasOwnProperty(sid)) ufUnion(ufP, i, sRep[sid]);
        else sRep[sid] = i;
    }

    // --- 2. Térbeli közelség → Union-Find (guard nélkül) ---
    for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
            if (textFrames[i].spreadIdx !== textFrames[j].spreadIdx) continue;
            if (ufFind(ufP, i) === ufFind(ufP, j)) continue;
            if (bboxDist(textFrames[i].bounds, textFrames[j].bounds) < PROX_THRESHOLD) {
                ufUnion(ufP, i, j);
            }
        }
    }

    // --- 3. Grafikai összekötő — konzervatív merge ---
    // Egy grafikai elem csak akkor von össze klasztereket, ha ≤ MAX_CLUSTER_MERGE
    // különálló klasztert érint. Ha többet → háttérelem, skip.
    const MAX_CLUSTER_MERGE = 5;
    for (const ge of graphicElements) {
        const overlapping = [];
        for (let fi = 0; fi < n; fi++) {
            const tf = textFrames[fi];
            if (tf.spreadIdx !== ge.spreadIdx) continue;
            if (ge.layerIndex < tf.layerIndex) continue;
            if (hasSignificantOverlap(tf.bounds, ge)) {
                overlapping.push(fi);
            }
        }
        if (overlapping.length < 2) continue;

        // Hány különálló klasztert érint ez a grafikai elem?
        const distinctRoots = new Set(overlapping.map(fi => ufFind(ufP, fi)));
        if (distinctRoots.size > MAX_CLUSTER_MERGE) continue;

        for (let k = 1; k < overlapping.length; k++) {
            ufUnion(ufP, overlapping[0], overlapping[k]);
        }
    }

    // --- 5. Klaszterek összeállítása, story-k deduplikálása ---
    const cMap = {};
    for (let i = 0; i < n; i++) {
        const r = String(ufFind(ufP, i));
        if (!cMap[r]) cMap[r] = [];
        cMap[r].push(i);
    }

    const clusters = [];
    for (const r in cMap) {
        const idxs = cMap[r];

        // Keretek rendezése olvasási sorrendbe: spread → Y → X
        idxs.sort((a, b) => {
            const fa = textFrames[a], fb = textFrames[b];
            if (fa.spreadIdx !== fb.spreadIdx) return fa.spreadIdx - fb.spreadIdx;
            if (fa.pageIdx !== fb.pageIdx) return fa.pageIdx - fb.pageIdx;
            const dy = fa.bounds[0] - fb.bounds[0];
            if (Math.abs(dy) > 3) return dy;
            return fa.bounds[1] - fb.bounds[1];
        });

        // Story-k deduplikálása (threaded story egyszer szerepel)
        const seen = {};
        const stList = [];
        for (const idx of idxs) {
            const fd = textFrames[idx];
            const fsid = String(fd.storyId);
            if (!seen[fsid]) {
                seen[fsid] = true;
                stList.push(fd);
            }
        }
        if (stList.length === 0) continue;

        const tot = stList.reduce((s, st) => s + st.text.replace(/[ \t\r\n]/g, '').length, 0);
        clusters.push({
            stories: stList,
            totalN: tot,
            repY: stList[0].bounds[0],
            repX: stList[0].bounds[1],
            repPage: stList[0].pageIdx,
            repSpread: stList[0].spreadIdx
        });
    }

    if (clusters.length === 0) throw new Error('Nem találhatók szövegkeretek az oldalakon');

    // Diagnosztikai log — UXP DevTools console-ban látható
    console.log(`[Archive] Keretek: ${n}, Grafikai elem: ${graphicElements.length}, Klaszter: ${clusters.length}`);
    clusters.forEach((cl, ci) => {
        const preview = cl.stories[0]?.text?.replace(/[\r\n]+/g, ' ').substring(0, 60) || '';
        console.log(`  [K${ci + 1}] ${cl.totalN} kar, ${cl.stories.length} story — "${preview}"`);
    });

    // Klaszterek olvasási sorrendbe rendezése
    clusters.sort((a, b) => {
        if (a.repSpread !== b.repSpread) return a.repSpread - b.repSpread;
        if (a.repPage !== b.repPage) return a.repPage - b.repPage;
        if (Math.abs(a.repY - b.repY) > 5) return a.repY - b.repY;
        return a.repX - b.repX;
    });

    // --- 6. Story-k elemzése ---
    const analyzed = {};
    for (const cl of clusters) {
        for (const st of cl.stories) {
            const sid = String(st.storyId);
            if (!analyzed[sid]) {
                analyzed[sid] = analyzeStory(st.paragraphs, st.text);
            }
        }
    }

    // --- 7. Layout típus felismerés ---
    const grandTotal = clusters.reduce((s, c) => s + c.totalN, 0);
    const maxClN     = clusters.reduce((m, c) => Math.max(m, c.totalN), 0);
    const isLongForm = grandTotal > 0 && (maxClN / grandTotal) > 0.40;

    // --- 8. Osztályozás és kimenet összeállítása ---
    const plainParts = [];
    const xmlParts   = ['<?xml version=\'1.0\' encoding=\'UTF-8\'?>', '<article>'];

    if (isLongForm) {
        _buildLongFormOutput(clusters, analyzed, plainParts, xmlParts);
    } else {
        _buildFragmentedOutput(clusters, analyzed, plainParts, xmlParts);
    }

    xmlParts.push('</article>');

    return {
        txtContent: plainParts.join(''),
        xmlContent: xmlParts.join('\n')
    };
}

// --- AI-alapú klaszterezés segédfüggvények ---

/**
 * Deduplikált story összefoglalók előkészítése az AI klaszterezéshez.
 *
 * Az InDesign-ban egy story több szövegkereten is átfolyhat (threading).
 * A storyId alapján deduplikálunk, és az első keret pozícióját + a szöveg
 * első ~200 karakterét küldjük az AI-nak.
 *
 * @param {object} rawData - Az `generateExtractArticleDataScript` kimenete.
 * @returns {object[]} Story összefoglalók az AI API-hoz.
 */
export function prepareStoriesForAI(rawData) {
    const { textFrames } = rawData;
    const storyMap = {};

    for (const tf of textFrames) {
        const sid = String(tf.storyId);
        if (storyMap[sid]) continue;

        // Bekezdés-adatokból súlyozott átlag betűméret és domináns stílusnév
        let totalChars = 0, weightedFsSum = 0, dominantStyle = '';
        let maxStyleCount = 0;
        const styleCounts = {};
        for (const p of (tf.paragraphs || [])) {
            const n = p.charCount || 0;
            if (n === 0) continue;
            totalChars += n;
            weightedFsSum += (p.fontSize || 12) * n;
            const sn = p.styleName || '';
            if (sn) {
                styleCounts[sn] = (styleCounts[sn] || 0) + n;
                if (styleCounts[sn] > maxStyleCount) {
                    maxStyleCount = styleCounts[sn];
                    dominantStyle = sn;
                }
            }
        }

        const avgFs = totalChars > 0 ? Math.round(weightedFsSum / totalChars * 10) / 10 : 12;
        const charCount = tf.text.replace(/[ \t\r\n]/g, '').length;

        storyMap[sid] = {
            storyId: sid,
            text: tf.text.replace(/\r/g, '\n').substring(0, 200).trim(),
            fontSize: avgFs,
            charCount,
            pageIdx: tf.pageIdx,
            bounds: tf.bounds,
            styleName: dominantStyle
        };
    }

    return Object.values(storyMap);
}

/**
 * TXT + XML kimenet generálása az AI klaszterezés eredményéből.
 *
 * Az AI klaszter-térképet ad vissza (storyId csoportok + típus-hozzárendelések),
 * ebből építjük a végleges szöveges kimeneteket.
 *
 * @param {object} rawData - Az InDesign scriptből kapott nyers adat.
 * @param {object} aiResponse - Az AI válasza: `{ clusters: [{ storyIds, types }] }`.
 * @returns {{ txtContent: string, xmlContent: string }}
 */
export function buildOutputFromAIClusters(rawData, aiResponse) {
    const { textFrames } = rawData;
    const { clusters: aiClusters } = aiResponse;

    // Story adatok keresése storyId alapján (első keret = az elsődleges)
    const storyDataMap = {};
    for (const tf of textFrames) {
        const sid = String(tf.storyId);
        if (!storyDataMap[sid]) {
            storyDataMap[sid] = tf;
        }
    }

    // Minden storyId nyilvántartása — ha az AI kihagyott volna egyet, fallback klaszterbe kerül
    const allStoryIds = new Set(Object.keys(storyDataMap));
    const assignedStoryIds = new Set();

    const plainParts = [];
    const xmlParts = ['<?xml version=\'1.0\' encoding=\'UTF-8\'?>', '<article>'];

    // Post-processing: árva klaszterek (1 story, ≤60 karakter, jellemzően névfelirat
    // vagy rövid caption) összevonása a térbeli legközelebbi szomszéd klaszterrel.
    _mergeOrphanClusters(aiClusters, storyDataMap);

    // AI klasztereket térbeli sorrendbe rendezzük (spread → page → Y → X),
    // hogy az olvasási sorrend ne az AI válasz sorrendjétől függjön.
    const sortedAIClusters = aiClusters
        .filter(cl => cl.storyIds.length > 0) // merge után üressé válhat
        .map(cl => {
            // Minden klaszterhez megkeressük a legfelső-bal story pozícióját
            let repBounds = null, repPage = 0;
            for (const sid of cl.storyIds) {
                const tf = storyDataMap[String(sid)];
                if (!tf) continue;
                if (!repBounds ||
                    tf.pageIdx < repPage ||
                    (tf.pageIdx === repPage && tf.bounds[0] < repBounds[0]) ||
                    (tf.pageIdx === repPage && tf.bounds[0] === repBounds[0] && tf.bounds[1] < repBounds[1])) {
                    repBounds = tf.bounds;
                    repPage = tf.pageIdx;
                }
            }
            return { cl, repBounds: repBounds || [0, 0, 0, 0], repPage };
        }).sort((a, b) => {
            if (a.repPage !== b.repPage) return a.repPage - b.repPage;
            if (Math.abs(a.repBounds[0] - b.repBounds[0]) > 5) return a.repBounds[0] - b.repBounds[0];
            return a.repBounds[1] - b.repBounds[1];
        }).map(item => item.cl);

    let firstCluster = true;

    for (const cl of sortedAIClusters) {
        const clusterStories = [];

        for (const sid of cl.storyIds) {
            const sidStr = String(sid);
            const tf = storyDataMap[sidStr];
            if (!tf) continue; // AI hallucinált storyId → skip
            assignedStoryIds.add(sidStr);

            const type = (cl.types && cl.types[sidStr]) || 'KENYERSZOVEG';
            clusterStories.push({ storyId: sidStr, text: tf.text, paragraphs: tf.paragraphs || [], type });
        }

        if (clusterStories.length === 0) continue;

        // TXT: klaszterek dupla sortöréssel elválasztva
        if (!firstCluster) plainParts.push('\n\n');
        firstCluster = false;

        const clusterTexts = clusterStories.map(s => trim(s.text.replace(/\r/g, '\n')));
        plainParts.push(clusterTexts.join('\n'));

        // XML: minden klaszter egy <ELEM> blokk
        xmlParts.push('<ELEM>');
        for (const s of clusterStories) {
            const rawTrimmed = trim(s.text.replace(/\r/g, '\n'));

            if (s.type === 'KERETES') {
                xmlParts.push('<KERETES>');
                const paras = (s.paragraphs || []).filter(p => (p.charCount || 0) > 0);
                if (paras.length > 0) {
                    xmlParts.push('<KERETES_CIM>' + escXml(trim(paras[0].text)) + '</KERETES_CIM>');
                    if (paras.length > 1) {
                        const body = paras.slice(1).map(p => trim(p.text)).join('\n');
                        xmlParts.push('<KERETES_SZOVEG>' + escXml(body) + '</KERETES_SZOVEG>');
                    }
                }
                xmlParts.push('</KERETES>');
            } else {
                const tag = s.type || 'KENYERSZOVEG';
                xmlParts.push('<' + tag + '>' + escXml(rawTrimmed) + '</' + tag + '>');
            }
        }
        xmlParts.push('</ELEM>');
    }

    // AI által ki nem osztott story-k fallback klaszterbe
    const unassigned = [...allStoryIds].filter(sid => !assignedStoryIds.has(sid));
    if (unassigned.length > 0) {
        if (!firstCluster) plainParts.push('\n\n');
        xmlParts.push('<ELEM>');
        for (const sid of unassigned) {
            const tf = storyDataMap[sid];
            const rawTrimmed = trim(tf.text.replace(/\r/g, '\n'));
            plainParts.push(rawTrimmed);
            xmlParts.push('<KENYERSZOVEG>' + escXml(rawTrimmed) + '</KENYERSZOVEG>');
        }
        xmlParts.push('</ELEM>');
    }

    xmlParts.push('</article>');

    return {
        txtContent: plainParts.join(''),
        xmlContent: xmlParts.join('\n')
    };
}

// --- Hosszú szöveges mód kimenet ---

function _buildLongFormOutput(clusters, analyzed, plainParts, xmlParts) {
    // Összes story egy listába
    const all = [];
    const seenAll = {};
    for (const cl of clusters) {
        for (const st of cl.stories) {
            const sid = String(st.storyId);
            if (!seenAll[sid]) { seenAll[sid] = true; all.push(analyzed[sid]); }
        }
    }

    // Kenyérszöveg: legtöbb karakter
    let bIdx = 0;
    for (let i = 1; i < all.length; i++) { if (all[i].totalN > all[bIdx].totalN) bIdx = i; }
    all[bIdx].type = 'KENYERSZOVEG';
    const bFont = all[bIdx].avgFs;

    // Stílushint alapú előosztályozás
    for (let i = 0; i < all.length; i++) {
        if (i === bIdx || all[i].type !== 'EGYEB') continue;
        if (all[i].domHint && all[i].domHint !== 'EGYEB') all[i].type = all[i].domHint;
    }

    // CÍM: stílushint wins; különben legnagyobb avgFs + max 250 kar. + ≥150% kenyérszöveg
    let tIdx = -1;
    for (let i = 0; i < all.length; i++) { if (all[i].type === 'CIM') { tIdx = i; break; } }
    if (tIdx < 0) {
        for (let i = 0; i < all.length; i++) {
            if (i === bIdx || all[i].type !== 'EGYEB') continue;
            if (all[i].totalN < 250 && all[i].avgFs >= bFont * 1.5) {
                if (tIdx < 0 || all[i].avgFs > all[tIdx].avgFs) tIdx = i;
            }
        }
        if (tIdx >= 0) all[tIdx].type = 'CIM';
    }

    // LEAD: stílushint wins; különben ≥120% kenyérszöveg, 40–800 karakter
    let lIdx = -1, lBest = -1;
    for (let i = 0; i < all.length; i++) {
        if (all[i].type !== 'EGYEB') continue;
        if (all[i].domHint === 'LEAD') { all[i].type = 'LEAD'; lIdx = i; break; }
        if (all[i].avgFs >= bFont * 1.2 && all[i].totalN >= 40 && all[i].totalN < 800) {
            const sc = all[i].avgFs * 2 + all[i].totalN * 0.05;
            if (sc > lBest) { lBest = sc; lIdx = i; }
        }
    }
    if (lIdx >= 0 && all[lIdx].type === 'EGYEB') all[lIdx].type = 'LEAD';

    // Maradék: KÉPALÁÍRÁS / KERETES / másodlagos KENYÉRSZÖVEG
    for (let i = 0; i < all.length; i++) {
        if (all[i].type !== 'EGYEB') continue;
        const s = all[i];
        if (s.totalN < 120) { s.type = 'KEPALAIRAS'; continue; }
        const fp = s.paras.find(p => p.n > 0);
        s.type = (fp && fp.n < 100 && fp.fs >= s.avgFs * 1.1) ? 'KERETES' : 'KENYERSZOVEG';
    }

    // Rendezés: CIM > LEAD > KENYERSZOVEG > KERETES > KEPALAIRAS
    const ord = { CIM: 0, LEAD: 1, KENYERSZOVEG: 2, KERETES: 3, KEPALAIRAS: 4, EGYEB: 5 };
    all.sort((a, b) => (ord[a.type] ?? 5) - (ord[b.type] ?? 5));

    // TXT + XML kimenet
    let first = true;
    for (const s of all) {
        if (s.type === 'KENYERSZOVEG') {
            if (!first) plainParts.push('\n');
            first = false;
            const bLines = [], xLines = [];
            let inXBody = false;
            for (const p of s.paras) {
                if (p.n === 0) { bLines.push(''); continue; }
                const isKc = (p.hint === 'KOZCIM') || (p.fs >= s.avgFs * 1.3 && p.n < 120);
                if (isKc) {
                    const ptT = trim(p.t);
                    bLines.push(''); bLines.push(ptT);
                    if (inXBody) {
                        xmlParts.push('<KENYERSZOVEG>' + escXml(trim(xLines.join('\n'))) + '</KENYERSZOVEG>');
                        xLines.length = 0; inXBody = false;
                    }
                    xmlParts.push('<KOZCIM>' + escXml(ptT) + '</KOZCIM>');
                } else {
                    bLines.push(p.t); xLines.push(p.t); inXBody = true;
                }
            }
            plainParts.push(bLines.join(''));
            if (inXBody && xLines.length > 0) {
                xmlParts.push('<KENYERSZOVEG>' + escXml(trim(xLines.join('\n'))) + '</KENYERSZOVEG>');
            }

        } else if (s.type === 'KERETES') {
            if (!first) plainParts.push('\n\n');
            first = false;
            const kLines = [];
            let kFirst = true, kTitle = '';
            const kBody = [];
            for (const p of s.paras) {
                if (p.n === 0) { kLines.push(''); continue; }
                const pt2 = trim(p.t);
                kLines.push(pt2);
                if (kFirst) { kTitle = pt2; kFirst = false; } else kBody.push(pt2);
            }
            plainParts.push(kLines.join('\n'));
            xmlParts.push('<KERETES>');
            if (kTitle) xmlParts.push('<KERETES_CIM>' + escXml(kTitle) + '</KERETES_CIM>');
            if (kBody.length > 0) xmlParts.push('<KERETES_SZOVEG>' + escXml(kBody.join('\n')) + '</KERETES_SZOVEG>');
            xmlParts.push('</KERETES>');

        } else {
            const tag = s.type === 'CIM' ? 'CIM' : s.type === 'LEAD' ? 'LEAD' :
                        s.type === 'KEPALAIRAS' ? 'KEPALAIRAS' : 'EGYEB';
            const ct  = trim(s.raw.replace(/\r/g, '\n'));
            if (!first) plainParts.push('\n\n');
            first = false;
            plainParts.push(ct);
            xmlParts.push('<' + tag + '>' + escXml(ct) + '</' + tag + '>');
        }
    }
}

// --- Fragmentált mód kimenet ---

function _buildFragmentedOutput(clusters, analyzed, plainParts, xmlParts) {
    let firstC = true;
    for (const cl of clusters) {
        const csl = cl.stories.map(st => analyzed[String(st.storyId)]);

        // Klaszter-szintű CÍM keresés
        let hIdx = -1;
        if (csl.length > 1) {
            for (let i = 0; i < csl.length; i++) {
                if (csl[i].domHint === 'CIM') { hIdx = i; break; }
            }
            if (hIdx < 0) {
                let hFs = -1;
                for (let i = 0; i < csl.length; i++) { if (csl[i].avgFs > hFs) { hFs = csl[i].avgFs; hIdx = i; } }
                let sndFs = 0;
                for (let i = 0; i < csl.length; i++) { if (i !== hIdx && csl[i].avgFs > sndFs) sndFs = csl[i].avgFs; }
                if (csl[hIdx].avgFs < sndFs * 1.15) hIdx = -1;
            }
            if (hIdx >= 0) csl[hIdx].type = 'CIM';
        }

        // A kenyérszöveg avgFs (a legtöbb karakterű, nem CÍM story)
        let bodyFs = 12;
        let bodyIdx = -1;
        for (let i = 0; i < csl.length; i++) {
            if (csl[i].type === 'CIM') continue;
            if (bodyIdx < 0 || csl[i].totalN > csl[bodyIdx].totalN) bodyIdx = i;
        }
        if (bodyIdx >= 0) bodyFs = csl[bodyIdx].avgFs;

        // Maradék story-k osztályozása
        for (let i = 0; i < csl.length; i++) {
            if (csl[i].type !== 'EGYEB') continue;
            const s = csl[i];
            if (s.domHint && s.domHint !== 'EGYEB') { s.type = s.domHint; continue; }

            // KIEMELÉS: önálló doboz, 20–100 kar., betűméret ≥ 120% body, nem keretes szerkezetű
            const isKiemeles = s.totalN >= 20 && s.totalN <= 100 && s.avgFs >= bodyFs * 1.2;

            // KERETES: első paragrafus rövid + kiemelkedő betűméretű
            const fp = s.paras.find(p => p.n > 0);
            const isKeretes = fp && fp.n < 100 && fp.fs >= s.avgFs * 1.1 && s.totalN > 100;

            if (isKiemeles)      s.type = 'KIEMELES';
            else if (isKeretes)  s.type = 'KERETES';
            else if (s.totalN < 150) s.type = 'KEPALAIRAS';
            else                 s.type = 'KENYERSZOVEG';
        }

        // TXT: klaszterek dupla sortöréssel, klaszteren belül egyszeres sortöréssel
        if (!firstC) plainParts.push('\n\n');
        firstC = false;
        const cLines = csl.map(s => trim(s.raw.replace(/\r/g, '\n')));
        plainParts.push(cLines.join('\n'));

        // XML: <ELEM> burok az összetartozó story-k köré
        xmlParts.push('<ELEM>');
        for (const s of csl) {
            const rawTrimmed = trim(s.raw.replace(/\r/g, '\n'));
            if (s.type === 'KERETES') {
                xmlParts.push('<KERETES>');
                const fp = s.paras.find(p => p.n > 0);
                if (fp) {
                    xmlParts.push('<KERETES_CIM>' + escXml(trim(fp.t)) + '</KERETES_CIM>');
                    const body = s.paras.filter(p => p.n > 0 && p !== fp).map(p => trim(p.t)).join('\n');
                    if (body) xmlParts.push('<KERETES_SZOVEG>' + escXml(body) + '</KERETES_SZOVEG>');
                }
                xmlParts.push('</KERETES>');
            } else {
                const tag = s.type === 'CIM'        ? 'CIM'        :
                            s.type === 'LEAD'       ? 'LEAD'       :
                            s.type === 'KIEMELES'   ? 'KIEMELES'   :
                            s.type === 'KEPALAIRAS' ? 'KEPALAIRAS' : 'KENYERSZOVEG';
                xmlParts.push('<' + tag + '>' + escXml(rawTrimmed) + '</' + tag + '>');
            }
        }
        xmlParts.push('</ELEM>');
    }
}

// --- AI post-processing: árva klaszterek összevonása ---

/** Árva klaszter maximális karakterszáma (felette önálló marad) */
const ORPHAN_MAX_CHARS = 60;

/**
 * Árva klaszterek (1 story, rövid szöveg) összevonása a térbeli legközelebbi
 * szomszéd klaszterrel. Jellemzően névfeliratok ("Drew Barrymore") vagy
 * rövid feliratok ("Édesanyja persze csak jót akart"), amelyeket az AI
 * tévesen külön klaszterbe rakott.
 *
 * Helyben módosítja az `aiClusters` tömböt (áthelyezi a storyId-kat és types-ot).
 *
 * @param {object[]} aiClusters - AI klaszter tömb (mutábilis).
 * @param {object}   storyDataMap - storyId → textFrame adatlap.
 */
function _mergeOrphanClusters(aiClusters, storyDataMap) {
    for (let i = aiClusters.length - 1; i >= 0; i--) {
        const cl = aiClusters[i];
        if (cl.storyIds.length !== 1) continue;

        const sid = String(cl.storyIds[0]);
        const tf = storyDataMap[sid];
        if (!tf) continue;

        const charCount = tf.text.replace(/[ \t\r\n]/g, '').length;
        if (charCount > ORPHAN_MAX_CHARS) continue;

        // Legközelebbi nem-árva klaszter keresése bboxDist alapján
        let bestIdx = -1, bestDist = Infinity;
        for (let j = 0; j < aiClusters.length; j++) {
            if (j === i) continue;
            if (aiClusters[j].storyIds.length === 0) continue;

            for (const otherSid of aiClusters[j].storyIds) {
                const otherTf = storyDataMap[String(otherSid)];
                if (!otherTf) continue;
                const d = bboxDist(tf.bounds, otherTf.bounds);
                if (d < bestDist) {
                    bestDist = d;
                    bestIdx = j;
                }
            }
        }

        if (bestIdx < 0) continue;

        // Story áthelyezése a legközelebbi klaszterbe
        aiClusters[bestIdx].storyIds.push(sid);
        if (cl.types && cl.types[sid]) {
            if (!aiClusters[bestIdx].types) aiClusters[bestIdx].types = {};
            aiClusters[bestIdx].types[sid] = cl.types[sid];
        }
        cl.storyIds = [];
    }
}
