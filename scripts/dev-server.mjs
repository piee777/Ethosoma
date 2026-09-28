/* =========================================================================
   Ethosoma — local dev server for the admin dashboard

   Serves frontend/ statically and mounts netlify/functions/analytics.js at
   /.netlify/functions/analytics, so the console works end to end without a
   deploy. `npx netlify dev` is the fuller alternative (it emulates Blobs and
   the edge runtime), but it installs site build plugins, which fails on
   npm >= 12 because remote tarball fetching is disabled by default. This
   server has no plugin step and no extra dependencies.

     node scripts/dev-server.mjs            # port 8888
     PORT=9000 node scripts/dev-server.mjs

   NOTE: without the Netlify runtime there is no Blobs context, so sessions
   are held in memory and are lost on restart. The console detects this and
   shows a "storage: memory" warning. Use a real deploy (or `netlify dev`)
   to exercise persistence.
   ========================================================================= */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import analytics from '../netlify/functions/analytics.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const FRONTEND = join(ROOT, 'frontend');
const PORT = Number(process.env.PORT) || 8888;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.gz': 'application/gzip',
  '.bin': 'application/octet-stream',
  '.obj': 'text/plain; charset=utf-8',
};

/** Minimal .env reader so the secret can live in the gitignored .env file. */
async function loadEnv() {
  if (process.env.ADMIN_KEY) return;
  try {
    const raw = await readFile(join(ROOT, '.env'), 'utf8');
    for (const line of raw.split('\n')) {
      const match = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/i.exec(line);
      if (!match) continue;
      const value = match[2].replace(/^["']|["']$/g, '');
      if (!(match[1] in process.env)) process.env[match[1]] = value;
    }
  } catch {
    /* no .env — ADMIN_KEY must come from the environment */
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

await loadEnv();

if (!process.env.ADMIN_KEY) {
  console.error(
    '\n  ADMIN_KEY is not set.\n\n' +
      '  The dashboard has no usable secret, so every request will 401.\n' +
      '  Create a .env file in the repository root:\n\n' +
      '    printf "ADMIN_KEY=%s\\n" "$(openssl rand -hex 24)" > .env\n\n' +
      '  It is gitignored. To use an existing .env.example, copy it and\n' +
      '  replace the placeholder value.\n',
  );
  process.exit(1);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/.netlify/functions/analytics') {
    try {
      const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await readBody(req);
      const request = new Request(`${url.origin}${url.pathname}${url.search}`, {
        method: req.method,
        headers: Object.fromEntries(
          Object.entries(req.headers).filter(([, value]) => typeof value === 'string'),
        ),
        body,
      });
      // No Netlify edge here, so the geo headers are absent and the
      // function will report "??". Use the real deploy to see country data.
      const response = await analytics(request, {});
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(await response.text());
    } catch (error) {
      console.error('[dev-server] function error:', error);
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'server_error', message: String(error?.message || error) }));
    }
    return;
  }

  // Contain the resolved path inside frontend/ (traversal-safe).
  const requested = normalize(decodeURIComponent(url.pathname));
  const relative = requested === '/' || requested === '\\' ? '/index.html' : requested;
  const filePath = join(FRONTEND, relative);
  if (!filePath.startsWith(FRONTEND)) {
    res.writeHead(403, { 'content-type': 'text/plain' });
    res.end('forbidden');
    return;
  }

  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error('not a file');
    res.writeHead(200, {
      'content-type': MIME[extname(filePath).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(await readFile(filePath));
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`404 — ${relative} not found`);
  }
});

server.listen(PORT, () => {
  console.log(`\n  Ethosoma dev server`);
  console.log(`  ─────────────────────────────────────────────`);
  console.log(`  landing   http://localhost:${PORT}/`);
  console.log(`  studio    http://localhost:${PORT}/app.html`);
  console.log(`  ADMIN     http://localhost:${PORT}/admin.html`);
  console.log(`\n  secret: ADMIN_KEY from .env (${process.env.ADMIN_KEY.length} chars)`);
  console.log(`  storage: in-memory — sessions reset on restart\n`);
});
