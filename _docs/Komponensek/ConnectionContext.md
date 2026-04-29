---
tags: [komponens, plugin, ui]
aliases: [ConnectionContext, useConnection]
---

# ConnectionContext

## Cél
**Online / offline / connecting UI állapot** (spinner, overlay) tárolása. Egyszerűsített: a tényleges connection-logic a [[DataContext]], [[RecoveryManager]], [[RealtimeClient]]-ben él — ez csak az UI state-et közvetíti.

## Helye
- **Forrás**: `packages/maestro-indesign/src/core/contexts/ConnectionContext.jsx:23`

## Felület (API)
- **Read**: `connectionStatus` ({ `isConnecting`, `isOffline`, `attempts`, `message`, `details`, `showSpinner`, `realtimeStatus` }), `showConnectionOverlay` (= `isConnecting || isOffline`)
- **Write**: `startConnecting(msg?)`, `setConnected()`, `setOffline(error?, attempts?)`, `setOnlineStatus(bool)`, `setRealtimeStatus(status)`, `incrementAttempts()`
- **Hook**: `useConnection()`

## Kapcsolatok
- **Hívják**: [[DataContext]] (`startConnecting`/`setOffline`/`setConnected`), [[RecoveryManager]] (`setOffline`, `incrementAttempts`), `Main.jsx` `navigator.onLine` listener
- **Olvasói**: `OverlayComponent` UI, `WorkspaceHeader` connection badge

## Gotchas
- **Csak UI state**: a context nem indít hálózati próbát — a `setConnected()` egy tényt rögzít, amit valaki más derít ki ([[RecoveryManager]] vagy a [[RealtimeClient]] open event-je)
- **Tranziens üzenet**: a "Kapcsolat helyreállt" 3s után auto-tűnik (`useEffect` timeout)

## Kapcsolódó
- [[DataContext]], [[RecoveryManager]], [[RealtimeClient]]
