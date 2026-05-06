/**
 * Maestro Dashboard — useCssToken / useCssTokens hook
 *
 * Egy `--token-name` CSS custom property aktuális értékét olvassa a
 * `<html>` elemről, és reaktívan frissül, ha a téma vált (`data-theme`
 * attribútum változás → `MutationObserver`).
 *
 * Használat third-party React komponensek prop-jainál, ahol a CSS
 * `var(--token)` nem érvényesíthető (pl. React Flow `Background.color`,
 * `MiniMap.maskColor`, SVG `stroke` attribútum).
 *
 * @example
 *   const dotColor = useCssToken('--canvas-dot-color');
 *   <Background color={dotColor} ... />
 *
 * @example  több token egyszerre
 *   const [forward, backward, reset] = useCssTokens([
 *       '--edge-forward', '--edge-backward', '--edge-reset',
 *   ]);
 *
 * Implementáció (harden 2026-05-06, Codex baseline P2-1 + adversarial P1-#1
 * fix): modul-szintű singleton store — EGY `MutationObserver` az egész
 * alkalmazásra, listener-pattern-en értesíti a hook-fogyasztókat. 50+
 * `TransitionEdge` esetén korábban 50× observer indult; most 1 observer +
 * N listener. Adversarial P2-#2 fix: `MutationObserver` feature guard
 * (test environment / partial DOM shim védelem).
 */

import { useEffect, useReducer } from 'react';

function readToken(name) {
    if (typeof document === 'undefined') return '';
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

// ─── Singleton store ────────────────────────────────────────────────────────
//
// `tokenCache`: tokenName → utoljára olvasott érték (lazy populate).
// `subscribers`: listener-ek halmaza, theme-váltáskor mind triggerelődik.
// `observerInstance`: egyetlen MutationObserver az egész alkalmazásra.
//
// A `data-theme` attribútum változására minden cached tokent újraolvasunk,
// és értesítjük a subscribers-eket. A subscribers-ek `forceUpdate` reducer-ek,
// amelyek React re-rendert triggerelnek.

const tokenCache = new Map();
const subscribers = new Set();
let observerInstance = null;

function ensureObserver() {
    if (observerInstance) return;
    if (typeof document === 'undefined') return;
    if (typeof MutationObserver === 'undefined') return; // partial DOM shim guard

    observerInstance = new MutationObserver(() => {
        // Téma váltáskor minden cached tokent újraolvasunk. A nem-fogyasztott
        // tokenek is benne maradnak a cache-ben — de mivel a cache csak
        // tokenName → string, a memóriaköltség elhanyagolható (max ~10-20 token).
        for (const name of tokenCache.keys()) {
            tokenCache.set(name, readToken(name));
        }
        for (const fn of subscribers) fn();
    });
    observerInstance.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['data-theme'],
    });
}

function getOrReadToken(name) {
    if (!tokenCache.has(name)) {
        tokenCache.set(name, readToken(name));
    }
    return tokenCache.get(name);
}

function subscribe(listener) {
    ensureObserver();
    subscribers.add(listener);
    return () => {
        subscribers.delete(listener);
    };
}

// ─── Public hookok ──────────────────────────────────────────────────────────

export function useCssToken(tokenName) {
    const [, forceUpdate] = useReducer((x) => x + 1, 0);
    useEffect(() => subscribe(forceUpdate), []);
    return getOrReadToken(tokenName);
}

export function useCssTokens(tokenNames) {
    const [, forceUpdate] = useReducer((x) => x + 1, 0);
    useEffect(() => subscribe(forceUpdate), []);
    return tokenNames.map(getOrReadToken);
}
