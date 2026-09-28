/* =========================================================================
   Ethosoma — Admin Console
   Session-gated telemetry reader.

   Auth model
     The secret lives in sessionStorage only (never localStorage, never a
     cookie), so closing the tab discards it. Every fetch presents it via
     the x-admin-key header; a 401 clears the secret and re-locks the
     console. The key is never written to the URL, so it cannot leak into
     browser history, referrers, or server access logs.
   ========================================================================= */

(() => {
  'use strict';

  const ENDPOINT = '/.netlify/functions/analytics';
  const KEY_STORAGE = 'ethosoma.adminKey';
  const AUTO_STORAGE = 'ethosoma.adminAutoRefresh';
  const AUTO_INTERVAL_MS = 30000;

  const el = {
    lockScreen: document.getElementById('lock-screen'),
    lockForm: document.getElementById('lock-form'),
    keyInput: document.getElementById('key-input'),
    unlockBtn: document.getElementById('unlock-btn'),
    lockStatus: document.getElementById('lock-status'),

    dashboard: document.getElementById('dashboard'),
    statusDot: document.getElementById('status-dot'),
    statusText: document.getElementById('status-text'),
    refreshBtn: document.getElementById('refresh-btn'),
    autoBtn: document.getElementById('auto-btn'),
    lockBtn: document.getElementById('lock-btn'),
    capSessions: document.getElementById('cap-sessions'),

    visitors: document.getElementById('m-visitors'),
    visitorsNote: document.getElementById('m-visitors-note'),
    duration: document.getElementById('m-duration'),
    durationNote: document.getElementById('m-duration-note'),
    countries: document.getElementById('m-countries'),
    countryList: document.getElementById('m-country-list'),
    devices: document.getElementById('m-devices'),
    deviceList: document.getElementById('m-device-list'),

    logBody: document.getElementById('log-body'),
    logMeta: document.getElementById('log-meta'),
    toast: document.getElementById('toast'),
  };

  let adminKey = null;
  let autoTimer = null;
  let inFlight = false;
  let toastTimer = null;

  /* ── Storage helpers (fail closed if storage is unavailable) ─────────── */

  const readStore = (key) => {
    try { return window.sessionStorage.getItem(key); } catch (error) { return null; }
  };
  const writeStore = (key, value) => {
    try { window.sessionStorage.setItem(key, value); } catch (error) { /* non-fatal */ }
  };
  const clearStore = (key) => {
    try { window.sessionStorage.removeItem(key); } catch (error) { /* non-fatal */ }
  };

  /* ── Formatting ──────────────────────────────────────────────────────── */

  /** ISO-3166 alpha-2 -> regional indicator flag. Returns '' when unknown. */
  function toFlag(code) {
    if (!/^[A-Za-z]{2}$/.test(code)) return '';
    return String.fromCodePoint(...[...code.toUpperCase()].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
  }

  const countryName = (code) =>
    code === '??' ? 'Unknown' : code;

  /**
   * Returns the split form used by the big metric tile (`value` + small
   * `unit`) plus a ready-to-print `text` for table cells.
   */
  function formatDuration(totalSeconds) {
    const seconds = Math.max(0, Math.round(totalSeconds || 0));
    if (seconds < 60) return { value: String(seconds), unit: 's', text: `${seconds}s` };
    const minutes = Math.floor(seconds / 60);
    const rest = String(seconds % 60).padStart(2, '0');
    if (minutes < 60) return { value: `${minutes}m ${rest}`, unit: 's', text: `${minutes}m ${rest}s` };
    const hours = Math.floor(minutes / 60);
    const rem = String(minutes % 60).padStart(2, '0');
    return { value: `${hours}h ${rem}m`, unit: '', text: `${hours}h ${rem}m` };
  }

  function formatDateTime(epochMs) {
    const date = new Date(epochMs);
    if (Number.isNaN(date.getTime())) return { main: '—', sub: '' };
    return {
      main: date.toLocaleString(undefined, {
        month: 'short', day: '2-digit', year: 'numeric',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
      }),
      sub: date.toISOString().replace('T', ' ').slice(0, 19) + 'Z',
    };
  }

  function formatPage(path) {
    if (!path) return '/';
    return path;
  }

  /* ── Status + toast ──────────────────────────────────────────────────── */

  function setStatus(state, text) {
    el.statusDot.dataset.state = state;
    el.statusText.textContent = text;
  }

  function toast(message, tone = 'info') {
    el.toast.textContent = message;
    el.toast.dataset.tone = tone;
    el.toast.dataset.show = 'true';
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => { el.toast.dataset.show = 'false'; }, 3200);
  }

  function setLockStatus(message, tone) {
    el.lockStatus.textContent = message;
    if (tone) el.lockStatus.dataset.tone = tone;
    else delete el.lockStatus.dataset.tone;
  }

  /* ── Render ──────────────────────────────────────────────────────────── */

  function renderRank(container, rows, { nameKey, valueKey }) {
    container.replaceChildren();
    if (!rows.length) {
      const empty = document.createElement('span');
      empty.className = 'empty-inline';
      empty.textContent = 'no data yet';
      container.appendChild(empty);
      return;
    }

    const max = rows[0][valueKey];
    for (const row of rows) {
      const line = document.createElement('div');
      line.className = 'rank-row';

      if (nameKey === 'flag') {
        const flag = document.createElement('span');
        flag.className = 'rank-flag';
        flag.textContent = toFlag(row.code);
        line.appendChild(flag);
      }

      const name = document.createElement('span');
      name.className = 'rank-name';
      name.textContent = row.label;
      line.appendChild(name);

      const barWrap = document.createElement('span');
      barWrap.className = 'rank-bar';
      const bar = document.createElement('span');
      bar.style.width = `${Math.max(6, Math.round((row[valueKey] / max) * 100))}%`;
      barWrap.appendChild(bar);
      line.appendChild(barWrap);

      const count = document.createElement('span');
      count.className = 'rank-count';
      count.textContent = String(row[valueKey]);
      line.appendChild(count);

      container.appendChild(line);
    }
  }

  function renderMetrics(data) {
    const totals = data.totals || {};
    const visitors = totals.visitors || 0;

    el.visitors.textContent = visitors.toLocaleString();
    el.visitorsNote.textContent = `sessions in the last ${totals.max_sessions || 200} visits`;

    const avg = formatDuration(totals.average_duration_seconds);
    el.duration.replaceChildren(document.createTextNode(avg.value));
    if (avg.unit) {
      const unit = document.createElement('span');
      unit.className = 'unit';
      unit.textContent = avg.unit;
      el.duration.appendChild(unit);
    }
    const totalHours = (totals.total_duration_seconds || 0) / 3600;
    el.durationNote.textContent = visitors
      ? `${(totals.average_duration_minutes || 0).toFixed(2)} min avg · ${totalHours.toFixed(1)} h total`
      : 'active time per session';

    el.countries.textContent = (totals.countries || 0).toLocaleString();
    renderRank(
      el.countryList,
      (data.countries || []).slice(0, 4).map((row) => ({
        code: row.country,
        label: countryName(row.country),
        count: row.count,
      })),
      { nameKey: 'flag', valueKey: 'count' },
    );

    const devices = data.devices || { mobile: 0, tablet: 0, desktop: 0 };
    const deviceTotal = devices.mobile + devices.tablet + devices.desktop;
    const mobileShare = deviceTotal ? Math.round(((devices.mobile + devices.tablet) / deviceTotal) * 100) : 0;
    el.devices.textContent = deviceTotal ? `${mobileShare}%` : '—';
    renderRank(
      el.deviceList,
      [
        { label: 'desktop', count: devices.desktop || 0 },
        { label: 'mobile', count: devices.mobile || 0 },
        { label: 'tablet', count: devices.tablet || 0 },
      ].filter((row) => row.count > 0),
      { nameKey: 'plain', valueKey: 'count' },
    );

    el.capSessions.textContent = String(totals.max_sessions || 200);
  }

  function renderSkeleton() {
    el.logBody.replaceChildren();
    for (let i = 0; i < 6; i += 1) {
      const tr = document.createElement('tr');
      tr.className = 'skeleton-row';
      for (let c = 0; c < 5; c += 1) {
        const td = document.createElement('td');
        const bar = document.createElement('span');
        bar.className = 'skeleton-bar';
        td.appendChild(bar);
        tr.appendChild(td);
      }
      el.logBody.appendChild(tr);
    }
  }

  function renderTable(sessions) {
    el.logBody.replaceChildren();

    if (!sessions.length) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 5;
      td.className = 'table-empty';
      td.textContent = 'No sessions recorded yet.';
      const hint = document.createElement('span');
      hint.className = 'hint';
      hint.textContent = 'Open the landing page in another tab — the visit is logged on load.';
      td.appendChild(hint);
      tr.appendChild(td);
      el.logBody.appendChild(tr);
      el.logMeta.textContent = '0 rows';
      return;
    }

    const fragment = document.createDocumentFragment();

    for (const session of sessions) {
      const tr = document.createElement('tr');

      const when = formatDateTime(session.start_time);
      const tdTime = document.createElement('td');
      tdTime.className = 'col-time';
      tdTime.textContent = when.main;
      const subTime = document.createElement('span');
      subTime.className = 'sub';
      subTime.textContent = when.sub;
      tdTime.appendChild(subTime);
      tr.appendChild(tdTime);

      const tdCountry = document.createElement('td');
      tdCountry.className = 'col-country';
      const flag = document.createElement('span');
      flag.className = 'flag';
      flag.textContent = toFlag(session.country);
      tdCountry.appendChild(flag);
      tdCountry.appendChild(document.createTextNode(countryName(session.country)));
      tr.appendChild(tdCountry);

      const tdDevice = document.createElement('td');
      tdDevice.className = 'col-device';
      tdDevice.textContent = session.device || '—';
      if (session.device_label) {
        const subDevice = document.createElement('span');
        subDevice.className = 'sub';
        subDevice.textContent = session.device_label;
        tdDevice.appendChild(subDevice);
      }
      tr.appendChild(tdDevice);

      const tdDuration = document.createElement('td');
      tdDuration.className = 'col-duration';
      tdDuration.textContent = formatDuration(session.duration_seconds).text;
      tr.appendChild(tdDuration);

      const tdPage = document.createElement('td');
      tdPage.className = 'col-page';
      tdPage.textContent = formatPage(session.page);
      tdPage.title = session.page || '';
      tr.appendChild(tdPage);

      fragment.appendChild(tr);
    }

    el.logBody.appendChild(fragment);
    el.logMeta.textContent = `${sessions.length} row${sessions.length === 1 ? '' : 's'}`;
  }

  /* ── Data fetching ───────────────────────────────────────────────────── */

  async function loadDashboard({ silent = false } = {}) {
    if (inFlight || !adminKey) return;
    inFlight = true;

    el.refreshBtn.disabled = true;
    if (!silent) setStatus('busy', 'loading');
    // Skeleton only when there is nothing meaningful on screen yet, so the
    // 30s background poll never makes the table flicker.
    if (!silent || !el.logBody.children.length) renderSkeleton();

    try {
      const response = await fetch(ENDPOINT, {
        method: 'GET',
        headers: { 'x-admin-key': adminKey },
        credentials: 'same-origin',
        cache: 'no-store',
      });

      if (response.status === 401) {
        clearStore(KEY_STORAGE);
        adminKey = null;
        setStatus('error', 'unauthorized');
        lockConsole('Session expired or key rejected.');
        return;
      }

      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const data = await response.json();
      renderMetrics(data);
      renderTable(data.sessions || []);

      const stamp = new Date(data.generated_at || Date.now())
        .toLocaleTimeString(undefined, { hour12: false });
      setStatus('ok', `synced ${stamp}`);

      if (data.storage === 'memory') {
        toast('Blobs unavailable — showing ephemeral in-memory data.', 'error');
      }
    } catch (error) {
      setStatus('error', 'request failed');
      if (!silent) {
        el.logBody.replaceChildren();
        const tr = document.createElement('tr');
        const td = document.createElement('td');
        td.colSpan = 5;
        td.className = 'table-empty';
        td.textContent = `Could not reach the analytics endpoint (${error.message}).`;
        tr.appendChild(td);
        el.logBody.appendChild(tr);
        toast('Failed to load telemetry.', 'error');
      }
    } finally {
      inFlight = false;
      el.refreshBtn.disabled = false;
    }
  }

  /* ── Lock / unlock ───────────────────────────────────────────────────── */

  function lockConsole(message) {
    stopAutoRefresh();
    el.dashboard.hidden = true;
    el.lockScreen.hidden = false;
    el.keyInput.value = '';
    if (message) setLockStatus(message, 'error');
    el.keyInput.focus();
  }

  function unlockConsole() {
    setLockStatus('Authenticated. Loading telemetry…', 'ok');
    el.lockScreen.hidden = true;
    el.dashboard.hidden = false;
    window.setTimeout(() => el.keyInput.blur(), 0);
  }

  async function handleUnlock(event) {
    event.preventDefault();
    const candidate = el.keyInput.value.trim();
    if (!candidate) {
      setLockStatus('Enter the admin secret key.', 'error');
      return;
    }

    el.unlockBtn.disabled = true;
    setLockStatus('Verifying…');
    adminKey = candidate;

    try {
      const response = await fetch(ENDPOINT, {
        method: 'GET',
        headers: { 'x-admin-key': candidate },
        credentials: 'same-origin',
        cache: 'no-store',
      });

      if (response.status === 401) {
        adminKey = null;
        setLockStatus('Access denied. Check the secret key.', 'error');
        el.keyInput.select();
        return;
      }
      if (response.status === 429) {
        adminKey = null;
        setLockStatus('Too many attempts. Wait a few minutes.', 'error');
        return;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      writeStore(KEY_STORAGE, candidate);
      setLockStatus('Authenticated. Loading telemetry…', 'ok');
      unlockConsole();
      await loadDashboard();
    } catch (error) {
      adminKey = null;
      setLockStatus(`Could not reach the server (${error.message}).`, 'error');
    } finally {
      el.unlockBtn.disabled = false;
    }
  }

  /* ── Auto refresh ────────────────────────────────────────────────────── */

  function isAutoEnabled() {
    return readStore(AUTO_STORAGE) === '1';
  }

  function startAutoRefresh() {
    stopAutoRefresh();
    autoTimer = window.setInterval(() => loadDashboard({ silent: true }), AUTO_INTERVAL_MS);
    el.autoBtn.setAttribute('aria-pressed', 'true');
    el.autoBtn.innerHTML = 'Auto&nbsp;30s&nbsp;:&nbsp;<span aria-hidden="true">on</span>';
  }

  function stopAutoRefresh() {
    if (autoTimer) window.clearInterval(autoTimer);
    autoTimer = null;
    el.autoBtn.setAttribute('aria-pressed', 'false');
    el.autoBtn.textContent = 'Auto 30s : off';
  }

  function toggleAutoRefresh() {
    if (autoTimer) {
      stopAutoRefresh();
      clearStore(AUTO_STORAGE);
      toast('Auto-refresh disabled.');
    } else {
      startAutoRefresh();
      writeStore(AUTO_STORAGE, '1');
      toast('Auto-refresh every 30s.');
    }
  }

  /* ── Boot ────────────────────────────────────────────────────────────── */

  el.lockForm.addEventListener('submit', handleUnlock);
  el.refreshBtn.addEventListener('click', () => loadDashboard());
  el.autoBtn.addEventListener('click', toggleAutoRefresh);
  el.lockBtn.addEventListener('click', () => {
    clearStore(KEY_STORAGE);
    adminKey = null;
    lockConsole('');
    setLockStatus('Console locked. Secret cleared from session storage.', 'ok');
  });

  const storedKey = readStore(KEY_STORAGE);
  if (storedKey) {
    adminKey = storedKey;
    unlockConsole();
    setLockStatus('Restored key from this tab’s session storage.', 'ok');
    loadDashboard();
    if (isAutoEnabled()) startAutoRefresh();
  } else {
    lockConsole('');
  }
})();
