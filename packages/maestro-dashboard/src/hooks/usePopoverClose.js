/**
 * usePopoverClose — Közös outside-click + ESC bezáró logika.
 *
 * Dropdown menükhöz, popover-ekhez. Kiszervezett hook, amelyet
 * a BreadcrumbDropdown és UserAvatar is használ.
 *
 * @param {React.RefObject} containerRef — a popover konténer ref-je
 * @param {boolean} isOpen — nyitva van-e
 * @param {Function} close — bezáró callback (pl. () => setIsOpen(false))
 */

import { useEffect, useCallback } from 'react';

export default function usePopoverClose(containerRef, isOpen, close) {
    const handleClickOutside = useCallback((e) => {
        if (containerRef.current && !containerRef.current.contains(e.target)) {
            close();
        }
    }, [containerRef, close]);

    useEffect(() => {
        if (!isOpen) return;
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, [isOpen, handleClickOutside]);

    useEffect(() => {
        if (!isOpen) return;
        function handleEsc(e) {
            if (e.key === 'Escape') {
                e.stopPropagation();
                close();
            }
        }
        document.addEventListener('keydown', handleEsc);
        return () => document.removeEventListener('keydown', handleEsc);
    }, [isOpen, close]);
}
