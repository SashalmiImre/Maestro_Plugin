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
 * @param {string} [props.emptyLabel] - Ha megadják, egy üres értékű opció jelenik meg a lista elején
 *   ezzel a szöveggel (pl. "Nincs hozzárendelve"). null/undefined value esetén ez lesz kiválasztva.
 * @param {string} [props.id] - HTML id attribútum
 * @param {Object} [props.style] - Inline stílusok
 * @param {boolean} [props.disabled] - Letiltott állapot
 */
export const CustomDropdown = ({
    value,
    onChange,
    children,
    placeholder = "Válassz",
    emptyLabel,
    id,
    style,
    disabled
}) => {
    const dropdownRef = useRef(null);
    const valueRef = useRef(value);
    const onChangeRef = useRef(onChange);
    const emptyLabelRef = useRef(emptyLabel);

    // Ref-ek szinkronizálása — mindig az aktuális prop értéket tükrözik
    useEffect(() => { valueRef.current = value; }, [value]);
    useEffect(() => { onChangeRef.current = onChange; }, [onChange]);
    useEffect(() => { emptyLabelRef.current = emptyLabel; }, [emptyLabel]);

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
            // ne hívjuk az onChange-t (programozott sync vagy azonos érték).
            // emptyLabel módban null/undefined is üres stringnek számít az összehasonlításkor.
            const currentValue = (emptyLabelRef.current && valueRef.current == null) ? '' : valueRef.current;
            if (selectedValue === currentValue) return;

            onChangeRef.current(selectedValue);
        };

        dropdown.addEventListener('change', handleChange);
        return () => dropdown.removeEventListener('change', handleChange);
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    // Közös syncIndex logika — ref-ből olvassa az aktuális értékeket,
    // így mind a value effect, mind a MutationObserver használhatja.
    const syncIndexFn = () => {
        const dropdown = dropdownRef.current;
        if (!dropdown) return false;

        const menu = dropdown.querySelector('sp-menu');
        if (!menu) return false;

        const items = Array.from(menu.querySelectorAll('sp-menu-item'));
        if (items.length === 0) return false;

        // emptyLabel módban null/undefined value az üres értékű elemnek felel meg
        const currentValue = valueRef.current;
        const hasEmpty = emptyLabelRef.current;
        const searchValue = (hasEmpty && (currentValue == null || currentValue === '')) ? '' : currentValue;
        const index = items.findIndex(item => item.getAttribute('value') === searchValue);
        dropdown.selectedIndex = index >= 0 ? index : -1;
        return true;
    };

    // selectedIndex szinkronizálás a value prop alapján
    useEffect(() => {
        const dropdown = dropdownRef.current;
        if (!dropdown) return;

        // Azonnali szinkronizálás — a valueRef-fel egyidőben frissül a vizuális állapot,
        // így a change handler guard nem blokkol valós felhasználói interakciót
        if (syncIndexFn()) return;

        // Fallback: mount-kor a DOM még nem feltétlenül kész, ilyenkor setTimeout-tal próbáljuk
        const timerId = setTimeout(syncIndexFn, 0);
        return () => clearTimeout(timerId);
    }, [value, emptyLabel]);

    // MutationObserver: ha a menu elemek (sp-menu-item) változnak (pl. aszinkron csapattagok
    // betöltődése), újraszinkronizáljuk a selectedIndex-et. Ez megoldja azt az esetet, amikor
    // a value már be van állítva, de a megfelelő sp-menu-item még nincs a DOM-ban.
    useEffect(() => {
        const dropdown = dropdownRef.current;
        if (!dropdown) return;

        const menu = dropdown.querySelector('sp-menu');
        if (!menu) return;

        const observer = new MutationObserver(() => {
            syncIndexFn();
        });

        observer.observe(menu, { childList: true, subtree: true });
        return () => observer.disconnect();
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

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
