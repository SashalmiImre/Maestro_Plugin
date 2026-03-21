/**
 * Maestro Dashboard — Kiadvány lista (oldalsáv + mobil dropdown)
 */

import React from 'react';
import { useData } from '../contexts/DataContext.jsx';

export default function Sidebar({ onSelect }) {
    const { publications, activePublicationId } = useData();

    return (
        <>
            {/* Oldalsáv */}
            <div className="sidebar">
                <div className="sidebar-header">Kiadványok</div>
                <div>
                    {publications.map(pub => (
                        <div
                            key={pub.$id}
                            className={`publication-item ${pub.$id === activePublicationId ? 'active' : ''}`}
                            title={pub.name}
                            onClick={() => onSelect(pub.$id)}
                        >
                            {pub.name}
                        </div>
                    ))}
                </div>
            </div>

            {/* Mobil dropdown */}
            <div className="mobile-pub-select">
                <select
                    value={activePublicationId || ''}
                    onChange={e => e.target.value && onSelect(e.target.value)}
                >
                    <option value="">Válassz kiadványt...</option>
                    {publications.map(pub => (
                        <option key={pub.$id} value={pub.$id}>
                            {pub.name}
                        </option>
                    ))}
                </select>
            </div>
        </>
    );
}
