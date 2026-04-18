import React from "react";

// A publikáció létrehozás Fázis 4-től a Dashboard hatáskörébe került; az új
// kiadványok csak aktivált állapotban jelennek meg a pluginban, így a plugin-
// oldali create gomb elvezetne egy nem elérhető rekordhoz. A teljes CRUD
// eltávolítást Fázis 9 fogja elvégezni; addig csak a belépési pontot tiltjuk le.
export const PublicationListToolbar = () => {
    return (
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", width: "100%" }}>
            <sp-heading size="s" style={{ margin: 0 }}>KIADVÁNYOK</sp-heading>
        </div>
    );
};
