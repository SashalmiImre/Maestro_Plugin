/**
 * Maestro Dashboard — Tabs
 *
 * Újrafelhasználható fülsáv komponens beállítás modalokhoz.
 * Vízszintes fülsáv aláhúzás indikátorral, controlled activeTab.
 *
 * Használat:
 *   <Tabs
 *     tabs={[
 *       { id: 'general', label: 'Általános' },
 *       { id: 'layouts', label: 'Layoutok' },
 *       { id: 'deadlines', label: 'Határidők' }
 *     ]}
 *     activeTab="general"
 *     onTabChange={setActiveTab}
 *   />
 */

import React from 'react';

/**
 * @param {Object} props
 * @param {{ id: string, label: string }[]} props.tabs — fül definíciók
 * @param {string} props.activeTab — aktív fül ID
 * @param {Function} props.onTabChange — callback: (tabId) => void
 */
export default function Tabs({ tabs, activeTab, onTabChange }) {
    return (
        <div className="tabs" role="tablist">
            {tabs.map(tab => (
                <button
                    key={tab.id}
                    type="button"
                    role="tab"
                    className={`tab ${tab.id === activeTab ? 'active' : ''}`}
                    aria-selected={tab.id === activeTab}
                    onClick={() => onTabChange(tab.id)}
                >
                    {tab.label}
                </button>
            ))}
        </div>
    );
}
