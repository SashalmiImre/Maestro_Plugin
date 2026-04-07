/**
 * Maestro Dashboard — DashboardLayout
 *
 * A védett `/` route layout-wrappere. Egyelőre egyszerű passzthrough a
 * meglévő DashboardView-ra. Fázis 5/6-ban itt jön majd a header + sidebar
 * shell, ha többszintű child route-ok lesznek (table/layout view-switch).
 */

import React from 'react';
import DashboardView from '../../components/DashboardView.jsx';

export default function DashboardLayout() {
    return <DashboardView />;
}
