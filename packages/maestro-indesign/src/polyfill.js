// Polyfill queueMicrotask for UXP (required by sp-table and lit-element)
if (typeof globalThis.queueMicrotask === 'undefined') {
    globalThis.queueMicrotask = (callback) => Promise.resolve().then(callback);
}

// Polyfill File for UXP — a built-in Blob nem mindig subclassable UXP-ben,
// ezért valódi Blob-ot hozunk létre és a prototípus láncot kézzel állítjuk be.
// Az Appwrite SDK instanceof File ellenőrzést végez a feltöltésnél.
if (typeof globalThis.File === 'undefined') {
    const FilePolyfill = function(chunks, name, options = {}) {
        const blob = new Blob(chunks, options);
        blob.name = name;
        blob.lastModified = options.lastModified || Date.now();
        Object.setPrototypeOf(blob, FilePolyfill.prototype);
        return blob;
    };
    FilePolyfill.prototype = Object.create(Blob.prototype);
    FilePolyfill.prototype.constructor = FilePolyfill;
    globalThis.File = FilePolyfill;
}

// Spectrum Web Components dev mode figyelmeztetés elnyomása
// (a Base.js ellenőrzi a window.__swc.ignoreWarningTypes objektumot inicializáláskor)
window.__swc = window.__swc || {};
window.__swc.ignoreWarningTypes = window.__swc.ignoreWarningTypes || {};
window.__swc.ignoreWarningTypes.default = true;
