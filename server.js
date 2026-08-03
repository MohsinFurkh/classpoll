'use strict';
/**
 * ClassPoll - live classroom polling. Zero dependencies.
 *
 * Transport is SSE (server -> browser) + plain POST (browser -> server).
 * Votes are one-shot, so nothing needs client->server streaming; SSE gives us
 * native auto-reconnect and sails through proxies that mangle WebSockets.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || process.argv[2] || 3000);
const PUBLIC = path.join(__dirname, 'public');

const CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ'; // no vowels -> never spells a word
const CODE_LEN = 4;
const BROADCAST_MS = 250;        // coalesce tally broadcasts
const KEEPALIVE_MS = 20000;      // defeat idle-proxy timeouts
const MAX_BODY = 8 * 1024;
const MAX_TEXT = 140;
const SESSION_TTL_MS = 6 * 60 * 60 * 1000;

/** @type {Map<string, Session>} */
const sessions = new Map();

// ---------------------------------------------------------------- sessions

function newCode() {
  for (;;) {
    let c = '';
    for (let i = 0; i < CODE_LEN; i++) {
      c += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
    }
    if (!sessions.has(c)) return c;
  }
}

function createSession() {
  const s = {
    code: newCode(),
    hostToken: crypto.randomBytes(16).toString('hex'),
    phase: 'lobby',              // lobby | open | closed
    poll: {
      type: 'choice',            // choice | word | text
      question: '',
      options: [],
      correct: null,
      liveResults: false,
    },
    responses: new Map(),        // voterId -> { choice, text, at }
    hidden: new Set(),           // voterId of moderated-out responses
    joined: new Set(),           // voterId
    clients: new Set(),          // { res, role, voterId }
    touched: Date.now(),
    timer: null,
  };
  sessions.set(s.code, s);
  return s;
}

/** Normalise a word-cloud answer so "Fast!", "fast" and " FAST " collapse. */
function normalizeWord(raw) {
  return raw
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s'-]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function tally(s) {
  const live = [...s.responses.entries()].filter(([id]) => !s.hidden.has(id));

  if (s.poll.type === 'choice') {
    const counts = s.poll.options.map(() => 0);
    for (const [, r] of live) {
      if (Number.isInteger(r.choice) && r.choice >= 0 && r.choice < counts.length) {
        counts[r.choice]++;
      }
    }
    return { kind: 'choice', counts };
  }

  if (s.poll.type === 'word') {
    const byKey = new Map();
    for (const [, r] of live) {
      const key = normalizeWord(r.text || '');
      if (!key) continue;
      const hit = byKey.get(key);
      if (hit) hit.count++;
      else byKey.set(key, { text: r.text.trim(), count: 1 });
    }
    const words = [...byKey.values()].sort(
      (a, b) => b.count - a.count || a.text.localeCompare(b.text)
    );
    return { kind: 'word', words };
  }

  return {
    kind: 'text',
    texts: live
      .sort((a, b) => b[1].at - a[1].at)
      .map(([id, r]) => ({ id, text: r.text })),
  };
}

/**
 * Build the payload for one audience. Students and the projector must not see
 * the answer key before reveal, nor the tally while voting is open (unless the
 * teacher opted in) - live bars make late voters follow the leader.
 */
function snapshot(s, role) {
  const isHost = role === 'host';
  const showResults =
    isHost || s.phase === 'closed' || (s.phase === 'open' && s.poll.liveResults);

  const out = {
    code: s.code,
    phase: s.phase,
    type: s.poll.type,
    question: s.poll.question,
    options: s.poll.options,
    liveResults: s.poll.liveResults,
    stats: { joined: s.joined.size, responded: s.responses.size },
    results: showResults ? tally(s) : null,
    correct: isHost || s.phase === 'closed' ? s.poll.correct : null,
  };

  if (isHost) {
    out.moderation = [...s.responses.entries()]
      .filter(([, r]) => typeof r.text === 'string')
      .sort((a, b) => b[1].at - a[1].at)
      .map(([id, r]) => ({ id, text: r.text, hidden: s.hidden.has(id) }));
  }
  return out;
}

function send(client, event, data) {
  try {
    client.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch {
    /* connection is going away; the close handler will clean up */
  }
}

/** Coalesced broadcast: 100 taps in 3s must not fan out to 10,000 messages. */
function broadcast(s) {
  if (s.timer) return;
  s.timer = setTimeout(() => {
    s.timer = null;
    const forHost = snapshot(s, 'host');
    const forRest = snapshot(s, 'guest');
    for (const c of s.clients) send(c, 'state', c.role === 'host' ? forHost : forRest);
  }, BROADCAST_MS);
}

// ------------------------------------------------------------------- http

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function sendFile(res, file) {
  fs.readFile(file, (err, buf) => {
    if (err) return sendJSON(res, 404, { error: 'not found' });
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(buf);
  });
}

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(new Error('bad json'));
      }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;

  try {
    if (p.startsWith('/assets/')) {
      const safe = path
        .normalize(p)
        .replace(/^(\.\.[/\\])+/, '')
        .replace(/^[/\\]+/, '');
      const file = path.join(PUBLIC, safe);
      if (!file.startsWith(PUBLIC)) return sendJSON(res, 403, { error: 'nope' });
      return sendFile(res, file);
    }

    // These are awaited so a rejected body parse lands in the catch below.
    // Returning the promise unawaited would make it an unhandled rejection,
    // which takes the whole process down on modern Node.
    if (p === '/api/stream') return stream(req, res, url);
    if (p === '/api/join') return sendJSON(res, 200, { base: joinBase(req) });
    if (p === '/api/session' && req.method === 'POST') return await apiSession(req, res);
    if (p === '/api/host' && req.method === 'POST') return await apiHost(req, res);
    if (p === '/api/vote' && req.method === 'POST') return await apiVote(req, res);

    if (p === '/' || p === '/index.html') return sendFile(res, path.join(PUBLIC, 'index.html'));
    if (p === '/host') return sendFile(res, path.join(PUBLIC, 'host.html'));
    if (p === '/selftest.html') return sendFile(res, path.join(PUBLIC, 'selftest.html'));
    if (/^\/d\/[A-Za-z]{4}$/.test(p)) return sendFile(res, path.join(PUBLIC, 'display.html'));
    if (/^\/[A-Za-z]{4}$/.test(p)) return sendFile(res, path.join(PUBLIC, 'vote.html'));

    sendJSON(res, 404, { error: 'not found' });
  } catch (err) {
    if (!res.headersSent) sendJSON(res, 400, { error: String(err.message || err) });
    else res.end();
  }
});

// A phone that walks out of wifi range kills its socket mid-write. Without this
// the stray 'error' event would be unhandled and take the server with it.
server.on('clientError', (err, socket) => socket.destroy());

// ------------------------------------------------------------------ routes

/**
 * The join URL students should use, which is what the QR code encodes.
 *
 * Running locally the teacher's browser is on localhost, which no phone can
 * reach, so swap in a real LAN address. Hosted, the Host header is already the
 * public name - but a platform proxy terminates TLS, so the scheme has to come
 * from x-forwarded-proto or the QR would send students to http on an https site.
 */
function joinBase(req) {
  const host = req.headers.host || `localhost:${PORT}`;
  const name = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  const isLoopback = name === 'localhost' || name === '127.0.0.1' || name === '::1';

  if (!isLoopback) {
    const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
    return `${proto === 'https' ? 'https' : 'http'}://${host}`;
  }

  const lan = lanAddresses()[0];
  return lan ? `http://${lan}:${PORT}` : `http://${host}`;
}

function stream(req, res, url) {
  const s = sessions.get((url.searchParams.get('code') || '').toUpperCase());
  if (!s) return sendJSON(res, 404, { error: 'no such session' });

  const token = url.searchParams.get('token') || '';
  const role = token && token === s.hostToken ? 'host' : 'guest';
  const voterId = (url.searchParams.get('voterId') || '').slice(0, 64);

  res.on('error', () => {});   // socket died; the close handler does the cleanup

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 2000\n\n');

  const client = { res, role, voterId };
  s.clients.add(client);
  s.touched = Date.now();

  if (voterId && role !== 'host') {
    s.joined.add(voterId);
    const mine = s.responses.get(voterId);
    send(client, 'you', {
      voterId,
      mine: mine ? { choice: mine.choice ?? null, text: mine.text ?? null } : null,
    });
  }

  send(client, 'state', snapshot(s, role));
  broadcast(s); // let everyone else see the new join count

  const ka = setInterval(() => {
    try {
      res.write(': ka\n\n');
    } catch {
      /* ignore */
    }
  }, KEEPALIVE_MS);

  req.on('close', () => {
    clearInterval(ka);
    s.clients.delete(client);
    // Keep them in `joined` - a phone locking its screen is not a student leaving.
    broadcast(s);
  });
}

async function apiSession(req, res) {
  const s = createSession();
  sendJSON(res, 200, { code: s.code, hostToken: s.hostToken });
}

async function apiHost(req, res) {
  const body = await readBody(req);
  const s = sessions.get(String(body.code || '').toUpperCase());
  if (!s) return sendJSON(res, 404, { error: 'no such session' });
  if (body.token !== s.hostToken) return sendJSON(res, 403, { error: 'not the host' });
  s.touched = Date.now();

  switch (body.action) {
    case 'ping':
      return sendJSON(res, 200, snapshot(s, 'host'));
    case 'setPoll': {
      const type = ['choice', 'word', 'text'].includes(body.type) ? body.type : 'choice';
      const options = Array.isArray(body.options)
        ? body.options.map((o) => String(o).slice(0, 80).trim()).filter(Boolean).slice(0, 6)
        : [];
      if (type === 'choice' && options.length < 2) {
        return sendJSON(res, 400, { error: 'need at least 2 options' });
      }
      s.poll = {
        type,
        question: String(body.question || '').slice(0, 300).trim(),
        options,
        correct:
          type === 'choice' && Number.isInteger(body.correct) &&
          body.correct >= 0 && body.correct < options.length
            ? body.correct
            : null,
        liveResults: !!body.liveResults,
      };
      s.responses.clear();
      s.hidden.clear();
      s.phase = 'lobby';
      break;
    }
    case 'open':
      if (!s.poll.question) return sendJSON(res, 400, { error: 'no question set' });
      s.phase = 'open';
      break;
    case 'close':
      s.phase = 'closed';
      break;
    case 'reopen':
      s.phase = 'open';
      break;
    case 'clear':
      s.responses.clear();
      s.hidden.clear();
      s.phase = 'lobby';
      break;
    case 'hide':
      s.hidden.add(String(body.id || ''));
      break;
    case 'unhide':
      s.hidden.delete(String(body.id || ''));
      break;
    default:
      return sendJSON(res, 400, { error: 'unknown action' });
  }

  broadcast(s);
  sendJSON(res, 200, snapshot(s, 'host'));
}

async function apiVote(req, res) {
  const body = await readBody(req);
  const s = sessions.get(String(body.code || '').toUpperCase());
  if (!s) return sendJSON(res, 404, { error: 'no such session' });
  if (s.phase !== 'open') return sendJSON(res, 409, { error: 'voting is not open' });

  const voterId = String(body.voterId || '').slice(0, 64);
  if (!voterId) return sendJSON(res, 400, { error: 'missing voterId' });

  s.joined.add(voterId);
  s.touched = Date.now();

  let entry;
  if (s.poll.type === 'choice') {
    const choice = Number(body.choice);
    if (!Number.isInteger(choice) || choice < 0 || choice >= s.poll.options.length) {
      return sendJSON(res, 400, { error: 'bad choice' });
    }
    entry = { choice, at: Date.now() };
  } else {
    const text = String(body.text || '').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
    if (!text) return sendJSON(res, 400, { error: 'empty answer' });
    if (s.poll.type === 'word' && text.split(' ').length > 3) {
      return sendJSON(res, 400, { error: 'one or two words please' });
    }
    entry = { text, at: Date.now() };
  }

  // Keyed by voter, so a double-tap or refresh overwrites instead of double-counting.
  s.responses.set(voterId, entry);
  broadcast(s);
  sendJSON(res, 200, { ok: true, mine: { choice: entry.choice ?? null, text: entry.text ?? null } });
}

// ----------------------------------------------------------------- upkeep

setInterval(() => {
  const now = Date.now();
  for (const [code, s] of sessions) {
    if (s.clients.size === 0 && now - s.touched > SESSION_TTL_MS) sessions.delete(code);
  }
}, 10 * 60 * 1000).unref();

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}

server.listen(PORT, () => {
  const addrs = lanAddresses();
  console.log('\n  ClassPoll is running.\n');
  console.log(`  Teacher console : http://localhost:${PORT}/host`);
  if (addrs.length) {
    console.log('\n  Students join from the classroom wifi at:');
    for (const a of addrs) console.log(`    http://${a}:${PORT}`);
  } else {
    console.log('\n  No LAN address found - students will need internet hosting.');
  }
  console.log('\n  Ctrl+C to stop.\n');
});
