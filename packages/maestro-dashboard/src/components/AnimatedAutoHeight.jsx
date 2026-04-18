/**
 * Maestro Dashboard — AnimatedAutoHeight
 *
 * Wrapper komponens, amely animálja a tartalom magasság-változását. Belső
 * `ResizeObserver` figyeli a content div természetes magasságát; ha változik,
 * a külső wrapper-en explicit px height + transition váltást hajt végre,
 * majd transitionend után visszaengedi `auto`-ra.
 *
 * Két beágyazott div szükséges: a content-et figyeljük (annak nagysága az
 * animáció során nem változik), a wrapper-t animáljuk (px height-tal).
 * Ezzel elkerüljük a feedback loopot, amit egyetlen elem ResizeObserver-e
 * okozna saját magasság-animációra.
 */

import { useLayoutEffect, useRef } from 'react';

export default function AnimatedAutoHeight({
    children,
    duration = 250,
    easing = 'ease'
}) {
    const wrapperRef = useRef(null);
    const contentRef = useRef(null);
    const prevHeightRef = useRef(null);
    const isAnimatingRef = useRef(false);
    const onEndRef = useRef(null);

    useLayoutEffect(() => {
        const wrapper = wrapperRef.current;
        const content = contentRef.current;
        if (!wrapper || !content) return;

        const ro = new ResizeObserver(([entry]) => {
            const newHeight = entry.contentRect.height;

            // Első mérés — csak baseline rögzítés, nincs animáció
            if (prevHeightRef.current === null) {
                prevHeightRef.current = newHeight;
                return;
            }

            // Lényegi változás híján skip
            if (Math.abs(prevHeightRef.current - newHeight) < 0.5) return;

            // Mid-transition esetén az aktuális vizuális magasságot vesszük
            const startHeight = isAnimatingRef.current
                ? wrapper.getBoundingClientRect().height
                : prevHeightRef.current;

            // Korábbi transitionend listener leszedése (ha van)
            if (onEndRef.current) {
                wrapper.removeEventListener('transitionend', onEndRef.current);
                onEndRef.current = null;
            }

            wrapper.style.transition = 'none';
            wrapper.style.height = `${startHeight}px`;
            wrapper.style.overflow = 'hidden';
            void wrapper.offsetHeight; // reflow

            wrapper.style.transition = `height ${duration}ms ${easing}`;
            wrapper.style.height = `${newHeight}px`;

            prevHeightRef.current = newHeight;
            isAnimatingRef.current = true;

            const onEnd = (e) => {
                if (e.propertyName !== 'height') return;
                wrapper.style.transition = '';
                wrapper.style.height = '';
                wrapper.style.overflow = '';
                isAnimatingRef.current = false;
                wrapper.removeEventListener('transitionend', onEnd);
                onEndRef.current = null;
            };
            wrapper.addEventListener('transitionend', onEnd);
            onEndRef.current = onEnd;
        });

        ro.observe(content);

        return () => {
            ro.disconnect();
            if (onEndRef.current) {
                wrapper.removeEventListener('transitionend', onEndRef.current);
                onEndRef.current = null;
            }
        };
    }, [duration, easing]);

    return (
        <div ref={wrapperRef}>
            <div ref={contentRef}>{children}</div>
        </div>
    );
}
