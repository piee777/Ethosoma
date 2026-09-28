/* =========================================================================
   Ethosoma — anonymous session telemetry
   Loaded by index.html (landing) and app.html (simulation studio).

   Privacy model
     - No cookies, no localStorage, no cross-site identifier. The session id
       is a random value kept in sessionStorage, so it lives and dies with
       the tab and is never shared with other sites.
     - The server stores only: country (from the edge geo header), a coarse
       device class, active seconds, the entry path, and the referrer.
     - No IP address is persisted.

   Duration model
     Active time is measured with a monotonic timer that only advances while
     document.visibilityState === "visible", so a backgrounded tab does not
     inflate the metric. Total is reported (not a delta) on every beacon and
     the server keeps the maximum, which makes out-of-order delivery safe.
   ========================================================================= */

(() => {
  'use strict';

  const ENDPOINT = '/.netlify/functions/analytics';
  const SESSION_KEY = 'ethosoma.sessionId';
  const HEARTBEAT_MS = 15000;
  const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

  /* ── Identity ────────────────────────────────────────────────────────── */

  function randomId() {
    const bytes = new Uint8Array(16);
    if (window.crypto && typeof window.crypto.getRandomValues === 'function') {
      window.crypto.getRandomValues(bytes);
    } else {
      for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
    }
    let out = '';
    for (let i = 0; i < bytes.length; i += 1) out += bytes[i].toString(16).padStart(2, '0');
    return out;
  }

  function readSessionId() {
    let stored = null;
    try {
      stored = window.sessionStorage.getItem(SESSION_KEY);
    } catch (error) {
      /* sessionStorage blocked (private mode / strict settings): fall back
         to an in-memory id so the tab still reports a coherent session. */
    }
    return stored && SESSION_ID_PATTERN.test(stored) ? stored : null;
  }

  function writeSessionId(id) {
    try {
      window.sessionStorage.setItem(SESSION_KEY, id);
    } catch (error) {
      /* non-fatal */
    }
  }

  const sessionId = readSessionId() || randomId();
  writeSessionId(sessionId);

  /* ── Active-time clock ───────────────────────────────────────────────── */

  let activeMs = 0;
  let lastTick = now();
  let visible = document.visibilityState !== 'hidden';

  function now() {
    return window.performance && typeof window.performance.now === 'function'
      ? window.performance.now()
      : Date.now();
  }

  function tick() {
    const stamp = now();
    if (visible) activeMs += stamp - lastTick;
    lastTick = stamp;
  }

  function activeSeconds() {
    tick();
    return Math.round(activeMs / 1000);
  }

  function setVisible(next) {
    tick();
    visible = next;
    lastTick = now();
  }

  /* ── Transport ───────────────────────────────────────────────────────── */

  function buildPayload(action) {
    return {
      action,
      sessionId,
      duration: activeSeconds(),
      page: window.location.pathname,
      referrer: document.referrer || '',
    };
  }

  /**
   * Normal in-page delivery. `keepalive` lets the request outlive the
   * document if the tab goes away mid-flight.
   */
  function send(action) {
    try {
      fetch(ENDPOINT, {
        method: 'POST',
        body: JSON.stringify(buildPayload(action)),
        headers: { 'content-type': 'application/json' },
        keepalive: true,
        credentials: 'same-origin',
        mode: 'same-origin',
      }).catch(() => {});
    } catch (error) {
      /* telemetry must never break the page */
    }
  }

  /**
   * Teardown delivery. sendBeacon is the only transport the browser keeps
   * alive past unload; a text/plain Blob keeps it preflight-free so the
   * beacon is never delayed behind an OPTIONS round-trip. Falls back to a
   * keepalive fetch if the browser refuses to queue it.
   */
  function beacon(action) {
    const body = JSON.stringify(buildPayload(action));
    if (navigator.sendBeacon) {
      try {
        if (navigator.sendBeacon(ENDPOINT, new Blob([body], { type: 'text/plain;charset=UTF-8' }))) return;
      } catch (error) {
        /* fall through to fetch */
      }
    }
    send(action);
  }

  /* ── Wiring ──────────────────────────────────────────────────────────── */

  // Announce the visit as soon as the document is parsed. The request is a
  // non-blocking fetch, so deferring it to an idle callback would only add
  // latency — and on a heavy page such as the WebGL studio the idle callback
  // can be starved for seconds. A reload re-announces the same id, which the
  // server treats as idempotent, so the entry timestamp stays anchored to
  // the first hit. If the tab closes before this lands, the unload beacon
  // still records the session, so no visit is lost.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => send('visit'), { once: true });
  } else {
    send('visit');
  }

  window.setInterval(tick, 1000);
  window.setInterval(() => send('heartbeat'), HEARTBEAT_MS);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      setVisible(false);
      beacon('heartbeat');
    } else {
      setVisible(true);
    }
  });

  // A normal navigation fires beforeunload and then pagehide; the guard keeps
  // that from queueing the same beacon twice. It is reset on pageshow so a
  // bfcache restore can report the next departure.
  let leaveQueued = false;
  function sendLeave() {
    if (leaveQueued) return;
    leaveQueued = true;
    beacon('leave');
  }

  // pagehide covers bfcache navigations where beforeunload is skipped.
  window.addEventListener('pagehide', sendLeave);
  window.addEventListener('beforeunload', sendLeave);

  window.addEventListener('pageshow', (event) => {
    if (event.persisted) {
      leaveQueued = false;
      setVisible(true);
    }
  });
})();
