// Polyfill queueMicrotask for UXP (required by sp-table and lit-element)
if (typeof globalThis.queueMicrotask === 'undefined') {
    globalThis.queueMicrotask = (callback) => Promise.resolve().then(callback);
}
