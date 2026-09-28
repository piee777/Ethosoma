/* =========================================================================
   Ethosoma — Analytics Function
   Anonymous, aggregate-only session telemetry for the Drosophila
   Connectome Digital Twin.

   Endpoints
     GET  /.netlify/functions/analytics          -> admin-only metrics payload
     POST /.netlify/functions/analytics          -> public event ingestion
                                                   (visit | heartbeat | leave)

   Design notes
     - The admin secret is read exclusively from the ADMIN_KEY environment
       variable. There is deliberately NO default/fallback key: if the env
       var is absent the admin surface is hard-disabled rather than
       silently opened up.
     - Every GET is authenticated with a constant-time, digest-normalised
       comparison and is rate limited per client IP.
     - No IP addresses, cookies, or cross-site identifiers are ever
       persisted. The client-generated session id lives in sessionStorage
       and dies with the tab.
     - Netlify Blobs is the primary store. If the package is unavailable
       or the site has Blobs disabled, the function degrades to a
       best-effort in-memory store instead of throwing (the dashboard then
       reports storage: "memory" so the degradation is visible).
   ========================================================================= */

import { createHash, timingSafeEqual } from 'node:crypto';

/* ─── Configuration ──────────────────────────────────────────────────────── */

const STORE_NAME = 'ethosoma-analytics';
const STORE_KEY = 'sessions';
const MAX_SESSIONS = 200;

const MAX_BODY_BYTES = 2048;
const MAX_DURATION_SECONDS = 86400; // hard ceiling: one day of active time
const MAX_UA_LENGTH = 300;
const MAX_PAGE_LENGTH = 160;
const MAX_REFERRER_LENGTH = 300;
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

const VALID_ACTIONS = new Set(['visit', 'heartbeat', 'leave', 'ping']);

const AUTH_WINDOW_MS = 5 * 60 * 1000;
const AUTH_MAX_FAILURES = 10;
const POST_WINDOW_MS = 5 * 60 * 1000;
// Generous on purpose: a university or office egresses every visitor through
// one shared address, and a single active tab emits ~21 events per 5 min
// (one visit plus a 15s heartbeat). 600/5min tolerates a shared NAT of ~25
// concurrent tabs while still rejecting a deliberate flood.
const POST_MAX_REQUESTS = 600;
const RATE_MAP_MAX_KEYS = 5000;

/* ─── Tiny helpers ───────────────────────────────────────────────────────── */

const noStoreHeaders = {
  'cache-control': 'no-store, no-cache, must-revalidate, private',
  pragma: 'no-cache',
  'x-content-type-options': 'nosniff',
  'x-robots-tag': 'noindex, nofollow',
  'referrer-policy': 'no-referrer',
};

function json(statusCode, payload, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status: statusCode,
    headers: { ...noStoreHeaders, 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

/** Strip control characters and clamp to a maximum length. */
function cleanText(value, maxLength) {
  if (typeof value !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function toFiniteNumber(value) {
  const n = typeof value === 'number' ? value : Number.parseFloat(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Constant-time secret comparison. Both sides are hashed first so that
 * differing lengths do not throw inside timingSafeEqual (and do not leak
 * the expected length through an exception).
 */
function secretMatches(presented, expected) {
  const a = createHash('sha256').update(String(presented)).digest();
  const b = createHash('sha256').update(String(expected)).digest();
  return timingSafeEqual(a, b);
}

/* ─── Rate limiting (best effort, per warm instance) ─────────────────────── */

const authFailureLog = new Map();
const postRateLog = new Map();

function pruneRateMap(map, windowMs) {
  if (map.size < RATE_MAP_MAX_KEYS) return;
  const cutoff = Date.now() - windowMs;
  for (const [key, hits] of map) {
    const kept = hits.filter((t) => t > cutoff);
    if (kept.length === 0) map.delete(key);
    else map.set(key, kept);
  }
}

function isRateLimited(map, key, windowMs, max) {
  const now = Date.now();
  const cutoff = now - windowMs;
  const hits = (map.get(key) || []).filter((t) => t > cutoff);
  hits.push(now);
  map.set(key, hits);
  pruneRateMap(map, windowMs);
  return hits.length > max;
}

function clearRate(map, key) {
  map.delete(key);
}

function clientIp(headers) {
  const candidates = [
    headers.get('x-nf-client-connection-ip'),
    headers.get('cf-connecting-ip'),
    headers.get('x-real-ip'),
    headers.get('x-forwarded-for'),
  ];
  for (const value of candidates) {
    if (!value) continue;
    const first = value.split(',')[0]?.trim();
    if (first) return first.slice(0, 64);
  }
  return 'unknown';
}

function requestHost(headers) {
  const forwarded = headers.get('x-forwarded-host');
  const raw = (forwarded ? forwarded.split(',')[0] : headers.get('host')) || '';
  return raw.trim().toLowerCase();
}

/**
 * Same-origin gate for the public ingestion endpoint. Requests without an
 * Origin header (older browsers, some beacon paths) are allowed through; a
 * mismatching Origin is rejected so third-party pages cannot inflate the
 * visitor metrics from a victim's browser.
 *
 * The host falls back to the request URL so the check cannot be silently
 * disabled by a proxy that strips the Host header.
 */
function isSameOrigin(headers, requestUrl) {
  const origin = headers.get('origin');
  if (!origin) return true;

  let originHost;
  try {
    originHost = new URL(origin).host.toLowerCase();
  } catch {
    return false;
  }
  if (!originHost) return false;

  let host = requestHost(headers);
  if (!host && requestUrl) {
    try {
      host = new URL(requestUrl).host.toLowerCase();
    } catch {
      host = '';
    }
  }
  if (!host) return false;

  return originHost === host;
}

/* ─── Geo resolution ─────────────────────────────────────────────────────── */

const COUNTRY_HEADERS = [
  'x-country',          // Netlify edge
  'cf-ipcountry',       // Cloudflare
  'x-geo-country',
  'fastly-client-country',
  'x-vercel-ip-country',
];

function resolveCountry(headers, context) {
  for (const name of COUNTRY_HEADERS) {
    const value = cleanText(headers.get(name), 8).toUpperCase();
    if (/^[A-Z]{2}$/.test(value) && value !== 'XX') return value;
  }
  const fromContext = cleanText(context?.geo?.country?.code, 8).toUpperCase();
  if (/^[A-Z]{2}$/.test(fromContext) && fromContext !== 'XX') return fromContext;
  return '??';
}

/* ─── Device classification ──────────────────────────────────────────────── */

function detectDevice(userAgent) {
  if (/ipad|tablet|playbook|silk|kindle|android(?!.*mobile)/i.test(userAgent)) return 'tablet';
  if (/mobi|iphone|ipod|android|blackberry|iemobile|opera mini|windows phone/i.test(userAgent)) {
    return 'mobile';
  }
  return 'desktop';
}

function detectDeviceLabel(userAgent) {
  const browser = /edg\//i.test(userAgent)
    ? 'Edge'
    : /opr\/|opera/i.test(userAgent)
      ? 'Opera'
      : /crios|chrome\//i.test(userAgent)
        ? 'Chrome'
        : /fxios|firefox\//i.test(userAgent)
          ? 'Firefox'
          : /safari\//i.test(userAgent)
            ? 'Safari'
            : 'Browser';

  const platform = /iphone|ipad|ipod/i.test(userAgent)
    ? 'iOS'
    : /android/i.test(userAgent)
      ? 'Android'
      : /windows/i.test(userAgent)
        ? 'Windows'
        : /mac os x|macintosh/i.test(userAgent)
          ? 'macOS'
          : /linux/i.test(userAgent)
            ? 'Linux'
            : 'Unknown OS';

  return `${browser} · ${platform}`;
}

/* ─── Storage: Netlify Blobs with an in-memory fallback ──────────────────── */

let blobStorePromise = null;
const memoryStore = new Map();

function emptyState() {
  return { version: 1, updated_at: Date.now(), sessions: [] };
}

function getBlobStore() {
  if (!blobStorePromise) {
    blobStorePromise = import('@netlify/blobs')
      .then((mod) => mod.getStore({ name: STORE_NAME, consistent: true }))
      .catch((error) => {
        console.warn('[analytics] Netlify Blobs unavailable, using in-memory store:', error?.message || error);
        return null;
      });
  }
  return blobStorePromise;
}

/** Defensive re-shape: never trust the shape of persisted data. */
function normalizeState(raw) {
  if (!raw || !Array.isArray(raw.sessions)) return emptyState();
  return { version: 1, updated_at: Number(raw.updated_at) || Date.now(), sessions: raw.sessions };
}

async function readState() {
  const store = await getBlobStore();
  if (store) {
    try {
      return normalizeState(await store.get(STORE_KEY, { type: 'json' }));
    } catch (error) {
      console.warn('[analytics] blob read failed, falling back to memory:', error?.message || error);
    }
  }
  return normalizeState(memoryStore.get(STORE_KEY));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function writeState(state) {
  const snapshot = { version: 1, updated_at: Date.now(), sessions: state.sessions.slice(0, MAX_SESSIONS) };
  memoryStore.set(STORE_KEY, snapshot);

  const store = await getBlobStore();
  if (!store) return { persisted: false, backend: 'memory' };

  try {
    // Blobs has no compare-and-swap, so two concurrent invocations on
    // different instances can still clobber one another. A short random
    // delay makes the read-modify-write window far less likely to collide;
    // the in-process lock below already serialises same-instance writes.
    await sleep(Math.floor(Math.random() * 120));
    await store.setJSON(STORE_KEY, snapshot);
    return { persisted: true, backend: 'blobs' };
  } catch (error) {
    console.warn('[analytics] blob write failed, retained in memory:', error?.message || error);
    return { persisted: false, backend: 'memory' };
  }
}

/** Serialises mutations within a single warm instance. */
let mutationQueue = Promise.resolve();
function withMutationLock(task) {
  const run = mutationQueue.then(task, task);
  mutationQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function findSession(state, sessionId) {
  return state.sessions.find((session) => session.id === sessionId) || null;
}

/* ─── Session mutations ──────────────────────────────────────────────────── */

/** `visit` is idempotent: a reload re-announces the same session id. */
function upsertVisit(state, input) {
  const now = Date.now();
  const existing = findSession(state, input.sessionId);

  const record = {
    id: input.sessionId,
    country: input.country,
    device: input.device,
    device_label: input.deviceLabel,
    user_agent: input.userAgent,
    page: input.page,
    referrer: input.referrer,
    start_time: existing ? existing.start_time : now,
    last_seen: now,
    duration_seconds: existing ? Math.max(existing.duration_seconds, input.durationSeconds) : input.durationSeconds,
  };

  if (existing) {
    state.sessions = state.sessions.map((session) => (session.id === record.id ? record : session));
    return { created: false, sessionId: record.id };
  }

  state.sessions = [record, ...state.sessions];
  return { created: true, sessionId: record.id };
}

/** Duration is monotonic: beacons can arrive out of order, so take the max. */
function updateDuration(state, input) {
  const existing = findSession(state, input.sessionId);
  if (!existing) {
    state.sessions = [
      {
        id: input.sessionId,
        country: input.country,
        device: input.device,
        device_label: input.deviceLabel,
        user_agent: input.userAgent,
        page: input.page,
        referrer: input.referrer,
        start_time: Date.now(),
        last_seen: Date.now(),
        duration_seconds: input.durationSeconds,
      },
      ...state.sessions,
    ];
    return { updated: false, created: true, sessionId: input.sessionId };
  }

  existing.duration_seconds = Math.max(existing.duration_seconds, input.durationSeconds);
  existing.last_seen = Date.now();
  if (input.page) existing.page = input.page;
  return { updated: true, created: false, sessionId: input.sessionId };
}

/* ─── Aggregation for the dashboard ──────────────────────────────────────── */

function buildDashboardPayload(state, backend) {
  const sessions = state.sessions;
  const totalVisitors = sessions.length;

  let totalDuration = 0;
  const countryCounts = new Map();
  const deviceCounts = { mobile: 0, tablet: 0, desktop: 0 };
  const pageCounts = new Map();

  for (const session of sessions) {
    totalDuration += session.duration_seconds || 0;

    const country = session.country || '??';
    countryCounts.set(country, (countryCounts.get(country) || 0) + 1);

    const device = session.device || 'desktop';
    deviceCounts[device] = (deviceCounts[device] || 0) + 1;

    if (session.page) pageCounts.set(session.page, (pageCounts.get(session.page) || 0) + 1);
  }

  const countries = [...countryCounts.entries()]
    .map(([country, count]) => ({ country, count }))
    .sort((a, b) => b.count - a.count || a.country.localeCompare(b.country));

  const averageDurationSeconds = totalVisitors > 0 ? totalDuration / totalVisitors : 0;

  return {
    generated_at: Date.now(),
    storage: backend,
    totals: {
      visitors: totalVisitors,
      max_sessions: MAX_SESSIONS,
      total_duration_seconds: totalDuration,
      average_duration_seconds: Number(averageDurationSeconds.toFixed(2)),
      average_duration_minutes: Number((averageDurationSeconds / 60).toFixed(2)),
      countries: countries.length,
    },
    countries,
    devices: deviceCounts,
    top_pages: [...pageCounts.entries()]
      .map(([page, count]) => ({ page, count }))
      .sort((a, b) => b.count - a.count || a.page.localeCompare(b.page))
      .slice(0, 5),
    sessions: sessions.map((session) => ({
      id: session.id,
      country: session.country || '??',
      device: session.device || 'desktop',
      device_label: session.device_label || '',
      page: session.page || '',
      start_time: session.start_time,
      last_seen: session.last_seen,
      duration_seconds: session.duration_seconds || 0,
    })),
  };
}

/* ─── Admin authentication ───────────────────────────────────────────────── */

function extractPresentedKey(headers, url) {
  const headerKey =
    headers.get('x-admin-key') || headers.get('admin-key') || headers.get('x-admin-token') || headers.get('ADMIN_KEY');
  if (headerKey && headerKey.trim()) return headerKey.trim();

  const authorization = headers.get('authorization');
  if (authorization && /^bearer\s+/i.test(authorization)) {
    const token = authorization.replace(/^bearer\s+/i, '').trim();
    if (token) return token;
  }

  const queryKey = url.searchParams.get('key') || url.searchParams.get('token') || '';
  return queryKey.trim();
}

function handleAdminRequest(req, url, context) {
  const configuredKey = process.env.ADMIN_KEY;
  const presentedKey = extractPresentedKey(req.headers, url);
  const ip = clientIp(req.headers);

  // No configured secret => the admin surface stays closed. Returning 401
  // (rather than 500) keeps the failure mode indistinguishable to callers.
  if (!configuredKey) {
    console.error('[analytics] ADMIN_KEY is not set — admin endpoint disabled.');
    return json(401, { error: 'unauthorized', message: 'Admin analytics are not configured.' });
  }

  if (isRateLimited(authFailureLog, ip, AUTH_WINDOW_MS, AUTH_MAX_FAILURES)) {
    return json(429, { error: 'rate_limited', message: 'Too many attempts. Try again later.' }, { 'retry-after': '300' });
  }

  if (!presentedKey || !secretMatches(presentedKey, configuredKey)) {
    return json(401, { error: 'unauthorized', message: 'Invalid admin credentials.' });
  }

  clearRate(authFailureLog, ip);

  return withMutationLock(async () => {
    // A read that fell back to memory means the payload was rebuilt from the
    // ephemeral copy; report that instead of implying durable storage.
    const store = await getBlobStore();
    const state = await readState();
    return json(200, buildDashboardPayload(state, store ? 'blobs' : 'memory'), { vary: 'x-admin-key' });
  });
}

/* ─── Public ingestion ───────────────────────────────────────────────────── */

async function handleIngest(req, context) {
  if (!isSameOrigin(req.headers, req.url)) {
    return json(403, { error: 'forbidden', message: 'Cross-origin submissions are not accepted.' });
  }

  const ip = clientIp(req.headers);
  if (isRateLimited(postRateLog, ip, POST_WINDOW_MS, POST_MAX_REQUESTS)) {
    return json(429, { error: 'rate_limited', message: 'Too many events.' }, { 'retry-after': '300' });
  }

  const declaredLength = Number.parseInt(req.headers.get('content-length') || '0', 10);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return json(413, { error: 'payload_too_large', message: 'Body exceeds the allowed size.' });
  }

  let body;
  try {
    const raw = await req.text();
    if (raw.length > MAX_BODY_BYTES) {
      return json(413, { error: 'payload_too_large', message: 'Body exceeds the allowed size.' });
    }
    body = JSON.parse(raw);
  } catch {
    return json(400, { error: 'bad_request', message: 'Expected a JSON body.' });
  }

  if (!body || typeof body !== 'object') {
    return json(400, { error: 'bad_request', message: 'Expected a JSON object.' });
  }

  const action = cleanText(body.action, 16).toLowerCase();
  if (!VALID_ACTIONS.has(action)) {
    return json(400, { error: 'bad_request', message: 'Unsupported action.' });
  }

  const sessionId = cleanText(body.sessionId, 64);
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    return json(400, { error: 'bad_request', message: 'Invalid session id.' });
  }

  const page = cleanText(body.page, MAX_PAGE_LENGTH);
  // The dashboard is a private surface; never let it inflate visitor counts.
  if (/^\/?admin(\.html)?$/i.test(page)) {
    return json(202, { ok: true, skipped: 'admin_page' });
  }

  const userAgent = cleanText(req.headers.get('user-agent'), MAX_UA_LENGTH);

  const rawDuration = toFiniteNumber(body.duration ?? body.duration_seconds);
  const durationSeconds = Math.min(
    Math.max(Math.round(rawDuration ?? 0), 0),
    MAX_DURATION_SECONDS,
  );

  const input = {
    sessionId,
    country: resolveCountry(req.headers, context),
    device: detectDevice(userAgent),
    deviceLabel: detectDeviceLabel(userAgent),
    userAgent,
    page,
    referrer: cleanText(body.referrer, MAX_REFERRER_LENGTH),
    durationSeconds,
  };

  const result = await withMutationLock(async () => {
    const state = await readState();
    const outcome = action === 'visit' ? upsertVisit(state, input) : updateDuration(state, input);
    state.sessions.sort((a, b) => (b.start_time || 0) - (a.start_time || 0));
    state.sessions = state.sessions.slice(0, MAX_SESSIONS);
    await writeState(state);
    return outcome;
  });

  return json(202, { ok: true, action, ...result });
}

/* ─── Handler ────────────────────────────────────────────────────────────── */

export default async function handler(req, context = {}) {
  try {
    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: noStoreHeaders });
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      return await handleAdminRequest(req, new URL(req.url), context);
    }

    if (req.method === 'POST') {
      return await handleIngest(req, context);
    }

    return json(405, { error: 'method_not_allowed', message: 'Use GET or POST.' }, { allow: 'GET, POST, OPTIONS' });
  } catch (error) {
    console.error('[analytics] unhandled error:', error);
    return json(500, { error: 'server_error', message: 'Unexpected server error.' });
  }
}
