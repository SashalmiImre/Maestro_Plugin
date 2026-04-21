/**
 * Maestro Dashboard — SegmentedToggle
 *
 * Többszörös kijelölésű (multi-select) gombcsoport: egyetlen vizuális „összetett
 * gombnak" tűnő sávra tagolt toggle-k. Ha minden opció aktív, az felel meg a
 * „Mind" állapotnak; az `onChange` az aktív `Set<value>`-t adja vissza.
 *
 * Kényszer: `minSelected` darab mindig aktív marad — az utolsó aktív gomb
 * kattintása no-op, így nincs „0 kiválasztás" üres állapot.
 */

/**
 * @template T
 * @param {Object} props
 * @param {Array<{ value: T, label: string, title?: string }>} props.options
 * @param {Set<T>} props.selected — aktív értékek halmaza
 * @param {(next: Set<T>) => void} props.onChange
 * @param {number} [props.minSelected=1] — legalább ennyi aktív gomb marad
 * @param {string} [props.ariaLabel] — a csoport ARIA neve
 * @param {string} [props.className]
 */
export default function SegmentedToggle({
    options,
    selected,
    onChange,
    minSelected = 1,
    ariaLabel,
    className
}) {
    function toggle(value) {
        const next = new Set(selected);
        if (next.has(value)) {
            if (next.size <= minSelected) return;
            next.delete(value);
        } else {
            next.add(value);
        }
        onChange(next);
    }

    return (
        <div
            className={`segmented-toggle${className ? ` ${className}` : ''}`}
            role="group"
            aria-label={ariaLabel}
        >
            {options.map((opt) => {
                const isActive = selected.has(opt.value);
                return (
                    <button
                        key={String(opt.value)}
                        type="button"
                        className={`segmented-toggle-btn${isActive ? ' is-active' : ''}`}
                        onClick={() => toggle(opt.value)}
                        aria-pressed={isActive}
                        title={opt.title}
                    >
                        {opt.label}
                    </button>
                );
            })}
        </div>
    );
}
