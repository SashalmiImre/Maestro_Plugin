/**
 * Maestro Dashboard — Media query hook
 *
 * Könnyű React-wrapper a `window.matchMedia` köré. SSR-safe (szerveren `false`-t
 * ad vissza, de a Dashboard csak böngészőben fut, így ez védelmi réteg), és
 * a változást azonnal követi az `onChange` event-en keresztül.
 *
 * Előre definiált breakpoint-hookok (`useIsMobile`, `useIsTablet`) a
 * responsive.css-beli értékekkel szinkronban vannak — ha egyik csúszik,
 * a másik is csússzon vele.
 */

import { useEffect, useState } from 'react';

export function useMediaQuery(query) {
    const [matches, setMatches] = useState(() => {
        if (typeof window === 'undefined' || !window.matchMedia) return false;
        return window.matchMedia(query).matches;
    });

    useEffect(() => {
        if (typeof window === 'undefined' || !window.matchMedia) return;
        const mq = window.matchMedia(query);
        const handler = (e) => setMatches(e.matches);
        setMatches(mq.matches);
        mq.addEventListener('change', handler);
        return () => mq.removeEventListener('change', handler);
    }, [query]);

    return matches;
}

// Egységes breakpoint-ok (ld. css/layouts/responsive.css).
export const BREAKPOINTS = {
    mobile: '(max-width: 640px)',
    tablet: '(max-width: 960px)',
};

export function useIsMobile() {
    return useMediaQuery(BREAKPOINTS.mobile);
}

export function useIsTablet() {
    return useMediaQuery(BREAKPOINTS.tablet);
}
