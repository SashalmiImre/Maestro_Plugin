# Plugin Shutdown Crash Fix Plan

## Root Cause Analysis

### Primary Bug: `_executeRecovery()` calls `realtime.reconnect()` after shutdown

The crash sequence:
1. Connection drops (server-side or sleep) → `_executeRecovery()` starts
2. User unloads plugin → `destroy()` called:
   - `recoveryManager.cancel()` → sets `isRecovering = false`, clears pending timeout
   - `realtime.disconnect()` → sets `shouldReconnect = false`, nullifies `this.realtime`
3. `_executeRecovery()` continues (cancel() does NOT abort in-flight async execution)
4. Health check resolves → `realtime.reconnect()` is called
5. `reconnect()` sets `shouldReconnect = true` and calls `_initClient()` → **new WebSocket created during shutdown!**
6. New WebSocket fires events in a destroyed plugin context → **crash**

### Secondary Bug: `realtime.reconnect()` has no guard against post-disconnect calls

`reconnect()` at line 475 in `src/core/config/realtimeClient.js` only guards against parallel calls (`isReconnecting`), but does NOT check `shouldReconnect`. After `disconnect()` sets `shouldReconnect = false`, a call to `reconnect()` will:
- Override `shouldReconnect = true` (line 511)
- Call `_initClient()` which creates a new WebSocket (line 519)

### Minor: `this.realtime` null access at line 351 (not protected)

In the close handler, `timeout = this.realtime.getTimeout()` at line 351 is executed synchronously without any null guard. However, since there are no `await` or `yield` statements between the start of the close handler and this line, the event loop cannot interleave a concurrent call to `disconnect()` at that exact moment — this guarantees atomic access within the synchronous block, so there is **no real race condition**.

---

## Fix Plan

### Fix 1: Guard `reconnect()` against post-disconnect calls
**File:** `src/core/config/realtimeClient.js`  
**Location:** `reconnect()` method, line 475

Add `shouldReconnect` check at the start of `reconnect()`, before the `isReconnecting` check:

```js
reconnect() {
    // Shutdown védelem: disconnect() után ne reconnecteljünk
    if (!this.shouldReconnect) {
        log('[Realtime] 🛑 reconnect() kihagyva — disconnect() már meghívva');
        return;
    }
    // Párhuzamos reconnect védelem
    if (this.isReconnecting) { ... }
    ...
}
```

This is the **critical fix** — it's a single-line guard that prevents any reconnection after intentional shutdown.

### Fix 2: Add cancellation check in `_executeRecovery()` after health check
**File:** `src/core/config/recoveryManager.js`  
**Location:** `_executeRecovery()` method, line 90

Add a `_isCancelled` flag to `RecoveryManager`:
- Set to `true` in `cancel()`
- Set to `false` at the start of `_executeRecovery()`
- Checked after the health check `await` — if cancelled, abort before calling `realtime.reconnect()`

```js
cancel() {
    this._isCancelled = true;  // signal in-flight execution to stop
    if (this._pendingTimeout) {
        clearTimeout(this._pendingTimeout);
        this._pendingTimeout = null;
    }
    this.isRecovering = false;
}

async _executeRecovery(trigger) {
    if (this.isRecovering) return;
    this._isCancelled = false;  // reset flag
    this.isRecovering = true;
    ...
    try {
        const serverReachable = await this._healthCheckWithRetry();
        
        // Check if cancelled while health check was running
        if (this._isCancelled) {
            log('[Recovery] 🛑 Recovery megszakítva (plugin leállítás)');
            return;
        }
        ...
    }
}
```

### Fix 3: Add `_isCancelled` to constructor initialization
**File:** `src/core/config/recoveryManager.js`  
**Location:** `RecoveryManager` constructor

Initialize `this._isCancelled = false;` in the constructor.

---

## Files to Modify

| File | Lines | Change |
|------|-------|--------|
| `src/core/config/realtimeClient.js` | ~475-480 | Add `!shouldReconnect` guard at start of `reconnect()` |
| `src/core/config/recoveryManager.js` | ~26-35 | Add `this._isCancelled = false` to constructor |
| `src/core/config/recoveryManager.js` | ~90-95 | Reset `_isCancelled = false` at start of `_executeRecovery()` |
| `src/core/config/recoveryManager.js` | ~99-104 | Add `_isCancelled` check after health check await |
| `src/core/config/recoveryManager.js` | ~260-265 | Set `this._isCancelled = true` in `cancel()` |

---

## Why Fix 1 is sufficient alone

Fix 1 (`reconnect()` guard) is the most robust defense: even if `_executeRecovery()` manages to call `reconnect()` after shutdown, it will be a no-op. Fix 2 is defense-in-depth that also prevents the health check retry loop from running after plugin shutdown (saving unnecessary network calls and potential errors from dead contexts).

Both fixes together make the shutdown sequence fully safe.
