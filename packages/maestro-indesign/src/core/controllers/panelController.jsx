import { createRoot } from "react-dom/client";
import React from "react";
import { MaestroEvent, dispatchMaestroEvent } from "../config/maestroEvents.js";

const _id = Symbol("_id");
const _root = Symbol("_root");
const _attachment = Symbol("_attachment");
const _Component = Symbol("_Component");
const _menuItems = Symbol("_menuItems");
const _reactRoot = Symbol("_reactRoot");

export class PanelController {

    constructor(Component, { id, menuItems } = {}) {
        this[_id] = null;
        this[_root] = null;
        this[_attachment] = null;
        this[_Component] = null;
        this[_menuItems] = [];
        this[_reactRoot] = null;

        this[_Component] = Component;
        this[_id] = id;
        this[_menuItems] = menuItems || [];

        ["create", "show", "hide", "destroy", "invokeMenu"].forEach(fn => this[fn] = this[fn].bind(this));
    }

    create() {
        this[_root] = document.getElementById("root");
        if (!this[_root]) {
            this[_root] = document.createElement("div");
        }

        this[_reactRoot] = createRoot(this[_root]);
        this[_reactRoot].render(
            this[_Component]({ panel: this })
        );

        return this[_root];
    }

    show(event) {
        if (!this[_root]) this.create();
        this[_attachment] = event;
        this[_attachment].appendChild(this[_root]);

        // Panel megjelent — hálózati helyreállítás triggerelése
        console.log(`[PanelController] Panel shown, dispatching ${MaestroEvent.panelShown}`);
        dispatchMaestroEvent(MaestroEvent.panelShown);
    }

    hide() {
        if (this[_attachment] && this[_root]) {
            this[_attachment].removeChild(this[_root]);
            this[_attachment] = null;
        }
    }

    destroy() {
        if (this[_reactRoot]) {
            this[_reactRoot].unmount();
            this[_reactRoot] = null;
        }
    }

    invokeMenu(id) {
        const menuItem = this[_menuItems].find(c => c.id === id);
        if (menuItem) {
            const handler = menuItem.oninvoke;
            if (handler) {
                handler();
            }
        }
    }
}
