// Local proxy + static server for the Valorant stats dashboard.
// Keeps the HenrikDev API key on the server and forwards requests from the page.
'use strict';

const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const demo = require('./demo');

try {
  process.loadEnvFile(path.join(__dirname, '.env'));
} catch {
  // No .env file: fall back to real environment variables.
}

const PORT = Number(process.env.PORT) || 3000;
const API_KEY = (process.env.HENRIK_API_KEY || '').trim();
const DEMO = process.argv.includes('--demo') || process.env.DEMO === '1';
const API_BASE = 'https://api.henrikdev.xyz';
const PUBLIC_DIR = path.join(__dirname, 'public');
const CACHE_MS = 60_000;

const REGIONS = new Set(['eu', 'na', 'latam', 'br', 'ap', 'kr']);
const MODES = new Set([
  '', 'competitive', 'unrated', 'swiftplay', 'deathmatch',
  'teamdeathmatch', 'spikerush', 'premier',
]);
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// Successful upstream responses are cached briefly to stay under rate limits.
const cache = new Map();

async function henrik(apiPath) {
  const hit = cache.get(apiPath);
  if (hit && Date.now() - hit.time < CACHE_MS) return hit.result;

  const res = await fetch(API_BASE + apiPath, {
    headers: { Authorization: API_KEY, Accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  const body = await res.json().catch(() => ({}));
  const result = { status: res.status, body };

  if (res.ok) {
    if (cache.size > 200) {
      for (const [key, entry] of cache) {
        if (Date.now() - entry.time >= CACHE_MS) cache.delete(key);
      }
    }
    cache.set(apiPath, { time: Date.now(), result });
  }
  return result;
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readRiotId(params) {
  const name = (params.get('name') || '').trim();
  const tag = (params.get('tag') || '').trim().replace(/^#/, '');
  if (!name || name.length > 32 || !tag || tag.length > 8) return null;
  return { name, tag };
}

function upstreamPath(route, { name, tag }, region, mode) {
  const n = encodeURIComponent(name);
  const t = encodeURIComponent(tag);
  if (route === 'account') return `/valorant/v2/account/${n}/${t}`;
  if (route === 'mmr') return `/valorant/v2/mmr/${region}/${n}/${t}`;
  return `/valorant/v3/matches/${region}/${n}/${t}?size=10${mode ? `&mode=${mode}` : ''}`;
}

async function handleApi(url, res) {
  const route = url.pathname.slice('/api/'.length);

  if (route === 'status') {
    return sendJson(res, 200, { demo: DEMO, hasKey: Boolean(API_KEY) });
  }
  if (!['account', 'mmr', 'matches'].includes(route)) {
    return sendJson(res, 404, { error: 'Unknown API route.' });
  }

  const id = readRiotId(url.searchParams);
  if (!id) return sendJson(res, 400, { error: 'Enter your Riot ID as Name#Tag.' });

  const region = (url.searchParams.get('region') || '').toLowerCase();
  const mode = (url.searchParams.get('mode') || '').toLowerCase();
  if (route !== 'account' && !REGIONS.has(region)) {
    return sendJson(res, 400, { error: 'Unknown region. Pick one from the Region menu.' });
  }
  if (route === 'matches' && !MODES.has(mode)) {
    return sendJson(res, 400, { error: 'Unknown game mode.' });
  }

  if (DEMO) return sendJson(res, 200, demo[route](id, region, mode));

  if (!API_KEY) {
    return sendJson(res, 500, {
      error: 'No API key set. Add HENRIK_API_KEY to the .env file and restart the server, or run "npm run demo".',
    });
  }

  try {
    const { status, body } = await henrik(upstreamPath(route, id, region, mode));
    sendJson(res, status, body);
  } catch (err) {
    const reason = err.name === 'TimeoutError' ? 'the request timed out' : err.message;
    sendJson(res, 502, { error: `Couldn't reach the HenrikDev API: ${reason}.` });
  }
}

async function serveStatic(url, res) {
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400).end('Bad request');
    return;
  }
  const file = path.normalize(path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const data = await fs.readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method !== 'GET') {
    res.writeHead(405).end('Method not allowed');
    return;
  }
  if (url.pathname.startsWith('/api/')) {
    handleApi(url, res).catch((err) => sendJson(res, 500, { error: `Server error: ${err.message}` }));
  } else {
    serveStatic(url, res);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Valorant dashboard running at http://localhost:${PORT}`);
  if (DEMO) console.log('Demo mode: serving generated sample data.');
  else if (!API_KEY) console.log('Warning: HENRIK_API_KEY is not set. Add it to .env or run "npm run demo".');
});
