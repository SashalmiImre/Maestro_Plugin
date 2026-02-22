import React, { useEffect, useRef } from "react";

/**
 * CustomDropdown Component
 *
 * UXP-kompatibilis dropdown wrapper az `sp-dropdown` köré.
 *
 * MIÉRT SZÜKSÉGES:
 * A UXP `sp-dropdown` nem támogatja a React `onChange` eseményt.
 * Natív `addEventListener('change', ...)` szükséges, valamint a `selectedIndex`
 * kézi szinkronizálása a React state-tel. Ez a komponens ezt a boilerplate-et
 * elrejti egy egyszerű `value` + `onChange(value)` interfész mögé.
 *
 * @param {Object} props
 * @param {string} [props.value] - A kiválasztott érték (sp-menu-item value attribútuma)
 * @param {Function} props.onChange - Callback: (selectedValue: string) => void
 * @param {React.ReactNode} props.children - Az sp-menu és sp-menu-item elemek
 * @param {string} [props.placeholder="Válassz"] - Placeholder szöveg
 * @param {string} [props.id] - HTML id attribútum
 * @param {Object} [props.style] - Inline stílusok
 * @param {boolean} [props.disabled] - Letiltott állapot
 */
export const CustomDropdown = ({
    value,
    onChange,
    children,
    placeholder = "Válassz",
    id,
    style,
    disabled
}) => {
    const dropdownRef = useRef(null);
    const valueRef = useRef(value);
    const onChangeRef = useRef(onChange);

    // Ref-ek szinkronizálása — mindig az aktuális prop értéket tükrözik
    useEffect(() => { valueRef.current = value; }, [value]);
    useEffect(() => { onChangeRef.current = onChange; }, [onChange]);

    // Natív change event listener (UXP sp-dropdown nem támogatja a React onChange-t)
    // FONTOS: a listener EGYSZER kerül fel (üres dependency) és stabil marad.
    // A friss onChange-et és value-t ref-eken keresztül éri el, így re-renderek
    // nem törlik/rakják vissza a listenert (ami event-vesztést okozna).
    useEffect(() => {
        const dropdown = dropdownRef.current;
        if (!dropdown) return;

        const handleChange = () => {
            const menu = dropdown.querySelector('sp-menu');
            if (!menu || dropdown.selectedIndex < 0) return;

            // querySelectorAll('sp-menu-item') kihagyja a sp-menu-divider elemeket
            const items = Array.from(menu.querySelectorAll('sp-menu-item'));
            const selectedItem = items[dropdown.selectedIndex];
            if (!selectedItem || !onChangeRef.current) return;

            const selectedValue = selectedItem.getAttribute('value') || '';

            // Ha a kiválasztott érték megegyezik az aktuális prop-pal,
            // ne hívjuk az onChange-t (programozott sync vagy azonos érték)
            if (selectedValue === valueRef.current) return;

            onChangeRef.current(selectedValue);
        };

        dropdown.addEventListener('change', handleChange);
        return () => dropdown.removeEventListener('change', handleChange);
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    // selectedIndex szinkronizálás a value prop alapján
    useEffect(() => {
        const dropdown = dropdownRef.current;
        if (!dropdown) return;

        const syncIndex = () => {
            const menu = dropdown.querySelector('sp-menu');
            if (!menu) return false;

            const items = Array.from(menu.querySelectorAll('sp-menu-item'));
            if (items.length === 0) return false;

            const index = items.findIndex(item => item.getAttribute('value') === value);
            dropdown.selectedIndex = index >= 0 ? index : -1;
            return true;
        };

        // Azonnali szinkronizálás — a valueRef-fel egyidőben frissül a vizuális állapot,
        // így a change handler guard nem blokkol valós felhasználói interakciót
        if (syncIndex()) return;

        // Fallback: mount-kor a DOM még nem feltétlenül kész, ilyenkor setTimeout-tal próbáljuk
        const timerId = setTimeout(syncIndex, 0);
        return () => clearTimeout(timerId);
    }, [value]);

    return (
        <sp-dropdown
            ref={dropdownRef}
            id={id}
            placeholder={placeholder}
            style={style}
            disabled={disabled || undefined}
        >
            {children}
        </sp-dropdown>
    );
};
