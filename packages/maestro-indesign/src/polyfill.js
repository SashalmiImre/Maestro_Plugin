// Polyfill queueMicrotask for UXP (required by sp-table and lit-element)
if (typeof globalThis.queueMicrotask === 'undefined') {
    globalThis.queueMicrotask = (callback) => Promise.resolve().then(callback);
}

// Spectrum Web Components dev mode figyelmeztetés elnyomása
// (a Base.js ellenőrzi a window.__swc.ignoreWarningTypes objektumot inicializáláskor)
window.__swc = window.__swc || {};
window.__swc.ignoreWarningTypes = window.__swc.ignoreWarningTypes || {};
window.__swc.ignoreWarningTypes.default = true;
