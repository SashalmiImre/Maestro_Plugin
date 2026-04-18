/**
 * Maestro Dashboard — Téma hook
 *
 * Sötét/világos téma váltás localStorage perzisztenciával + rendszerszintű
 * `prefers-color-scheme` követéssel (csak ha a user nem választott explicit-en).
 *
 * A `<html data-theme="...">` attribútumot a `main.jsx` korai bootstrap-je
 * már beállította a hidratálás előtt — ez a hook a futtatási váltást kezeli.
 */

import { useState, useCallback, useEffect } from 'react';

export const THEME_STORAGE_KEY = 'maestro.dashboard.theme';

function getInitialTheme() {
    const current = document.documentElement.dataset.theme;
    if (current === 'light' || current === 'dark') return current;
    return 'dark';
}

export function useTheme() {
    const [theme, setThemeState] = useState(getInitialTheme);

    const setTheme = useCallback((next) => {
        if (next !== 'light' && next !== 'dark') return;
        document.documentElement.dataset.theme = next;
        localStorage.setItem(THEME_STORAGE_KEY, next);
        setThemeState(next);
    }, []);

    const toggleTheme = useCallback(() => {
        setTheme(theme === 'light' ? 'dark' : 'light');
    }, [theme, setTheme]);

    // Rendszerszintű preferencia követése — csak ha a user nem választott
    useEffect(() => {
        const mq = window.matchMedia('(prefers-color-scheme: light)');
        const handler = (e) => {
            const saved = localStorage.getItem(THEME_STORAGE_KEY);
            if (saved === 'light' || saved === 'dark') return;
            const next = e.matches ? 'light' : 'dark';
            document.documentElement.dataset.theme = next;
            setThemeState(next);
        };
        mq.addEventListener('change', handler);
        return () => mq.removeEventListener('change', handler);
    }, []);

    return { theme, setTheme, toggleTheme };
}
