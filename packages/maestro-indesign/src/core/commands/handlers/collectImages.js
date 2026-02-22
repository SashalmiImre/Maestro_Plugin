import { 
    generateCollectImagesScript, 
    generateGetDocumentIdScript, 
    generateIsDocumentOpenScript
} from "../../utils/indesign/index.js";
import { executeScript } from "../../utils/indesign/indesignUtils.js";
import { WorkflowEngine } from "../../utils/workflow/workflowEngine.js";
import { LOCK_TYPE } from "../../utils/constants.js";
import * as pathUtils from "../../utils/pathUtils.js";

// Session tracking: maps filePath -> { docId, folderName }
// Ez biztosítja, hogy amíg ugyanaz a doksi van nyitva, ugyanazt a mappát használjuk.
const collectionSessions = new Map();

/**
 * Handles the 'collect_images' and 'collect_selected_images' commands.
 * 
 * @param {object} context - Context data including the item.
 * @returns {Promise<object>} Result of the operation.
 */
export const handleCollectImages = async (context) => {
    const { item, publication, user, commandId } = context;
    const onlySelected = commandId === 'collect_selected_images';

    console.log(`[Command] Collecting images (${onlySelected ? 'selected' : 'all'}) for:`, item?.name);

    if (!item || !item.filePath) {
        return { success: false, error: "Nincs érvényes cikk kiválasztva." };
    }

    const publicationPath = publication.rootPath || publication.path;
    if (!publicationPath) {
        return { success: false, error: "A publikáció útvonala nem található." };
    }

    // 1. Állapotellenőrzés (Nyitva van-e?)
    let isOpen = false;
    let docId = null;
    try {
        const checkOpenScript = generateIsDocumentOpenScript(item.filePath);
        const isOpenResult = await executeScript(checkOpenScript);
        isOpen = isOpenResult === "true";

        if (isOpen) {
            // Ha nyitva van, lekérjük az ID-t a session kezeléshez
            const idScript = generateGetDocumentIdScript(item.filePath);
            const result = await executeScript(idScript);
            if (!result.startsWith("ERROR")) {
                docId = result;
            }
        }
    } catch (e) {
        console.warn("[Command] Status check failed:", e);
    }

    // Ha kijelölést akarunk másolni, de nincs nyitva a doksi, az hiba (vagy fallback?)
    // A specifikáció szerint: "Kijelölés nélküli (vagy háttérben megnyitott cikknél)..."
    // "Ha vannak kijelölések..." -> Ez implikálja, hogy a kijelölés csak nyitott doksinál értelmezhető.
    if (onlySelected && !isOpen) {
        return { success: false, error: "A kijelölt képek másolásához a dokumentumnak nyitva kell lennie." };
    }

    // 2. Célmappa meghatározása (Session Logic)
    let targetFolderName = null;
    const amiFolder = pathUtils.joinPath(publicationPath, "__AMI__");

    // Session kulcs: fájl útvonal
    const sessionKey = item.filePath;
    const currentSession = collectionSessions.get(sessionKey);

    if (isOpen && docId && currentSession && currentSession.docId === docId) {
        // Ugyanaz a session (nyitva van és az ID egyezik) -> Ugyanaz a mappa
        targetFolderName = currentSession.folderName;
        console.log(`[Command] Reusing session folder: ${targetFolderName}`);
    } else {
        // Új session vagy zárt doksi -> Új mappa generálása
        // Mappa név: CikkNeve vagy CikkNeve_1, _2...
        const fs = require("uxp").storage.localFileSystem;
        try {
            // __AMI__ létrehozása ha kell
            let amiEntry;
            try {
                amiEntry = await fs.getEntryWithUrl(pathUtils.convertNativePathToUrl(amiFolder));
            } catch (e) {
                const pubEntry = await fs.getEntryWithUrl(pathUtils.convertNativePathToUrl(publicationPath));
                amiEntry = await pubEntry.createFolder("__AMI__");
            }

            // Keressük a következő szabad nevet
            let counter = 0;
            let candidateName = item.name.replace(/\.[^/.]+$/, ""); // Ext nélkül
            let finalName = candidateName;

            while (true) {
                try {
                    await amiEntry.getEntry(finalName);
                    // Ha létezik, növeljük a számlálót
                    counter++;
                    finalName = `${candidateName}_${counter}`;
                } catch (e) {
                    // Ha nem létezik, ez jó lesz
                    break;
                }
            }
            
            targetFolderName = finalName;
            
            // Session mentése (ha nyitva van)
            if (isOpen && docId) {
                collectionSessions.set(sessionKey, {
                    docId: docId,
                    folderName: targetFolderName
                });
            }

        } catch (e) {
            return { success: false, error: "Nem sikerült a célmappa előkészítése: " + e.message };
        }
    }

    const targetFolderPath = pathUtils.joinPath(amiFolder, targetFolderName);
    console.log("[Command] Target folder:", targetFolderPath);

    // 3. Zárolás (csak ha háttérben nyitjuk meg)
    let lockedBySystem = false;
    let lockedItem = null;

    try {
        if (!isOpen) {
             const lockResult = await WorkflowEngine.lockDocument(item, LOCK_TYPE.SYSTEM, user);
             if (!lockResult.success) {
                 return { success: false, error: `Nem sikerült zárolni a dokumentumot: ${lockResult.error}` };
             }
             lockedBySystem = true;
             lockedItem = lockResult.document;
        }

        // 4. Script Végrehajtás
        // sourceFilePath csak akkor kell, ha NINCS nyitva (isOpen=false). 
        // Ha nyitva van, a script az aktív/elérhető doksit használja.
        const script = generateCollectImagesScript(
            targetFolderPath,
            publicationPath,
            onlySelected,
            isOpen ? null : item.filePath
        );

        const result = await executeScript(script);
        
        let message = "";
        
        if (result.startsWith("SUCCESS:")) {
            message = result.substring(8);
        } else if (result.startsWith("ERROR:")) {
            throw new Error(result.substring(6));
        } else {
             // Fallback
             if (result.includes("ERROR")) throw new Error(result);
             message = result;
        }

        return { 
            success: true, 
            message: `Képek összegyűjtve (${targetFolderName}). ${message}` 
        };

    } catch (error) {
        console.error("[Command] Collect Images error:", error);
        return { success: false, error: error.message };
    } finally {
        // Unlock if locked
        if (lockedBySystem) {
             try {
                 await WorkflowEngine.unlockDocument(lockedItem || item, user);
             } catch (unlockError) {
                 console.error("[Command] Failed to unlock:", unlockError);
             }
        }
    }
};
