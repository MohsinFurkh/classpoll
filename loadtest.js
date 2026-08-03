'use strict';
/**
 * Simulate a full classroom before you stand in front of one.
 *
 *   node loadtest.js MKPQ            100 students against localhost:3000
 *   node loadtest.js MKPQ 250        250 students
 *   node loadtest.js MKPQ 100 192.168.1.20:3000
 *
 * Open the projector view while this runs - you want to see the bars move.
 */

const http = require('http');

const CODE = (process.argv[2] || '').toUpperCase();
const COUNT = Number(process.argv[3] || 100);
const TARGET = process.argv[4] || 'localhost:3000';
const [HOST, PORT] = TARGET.split(':');

if (!/^[A-Z]{4}$/.test(CODE)) {
  console.error('usage: node loadtest.js <CODE> [students] [host:port]');
  process.exit(1);
}

const WORDS = ['fast', 'Fast', 'confusing', 'clear', 'recursion', 'sorting', 'tricky', 'fun', 'clear', 'fast'];
const SENTENCES = [
  'I still do not get the base case.',
  'The worst case analysis went too quickly.',
  'Could we do another example on the board?',
  'It made sense until the recursion part.',
  'Please slow down on the proofs.',
];

const streams = [];
const latencies = [];
let connected = 0;
let sent = 0;
let ok = 0;
let failed = 0;
let poll = null;

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request(
      {
        host: HOST,
        port: Number(PORT),
        path,
        method,
        headers: data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {},
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) });
          } catch {
            resolve({ status: res.statusCode, body: {} });
          }
        });
      }
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

/** Hold an SSE connection open, exactly like a phone sitting on a desk. */
function openStream(voterId) {
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: HOST,
        port: Number(PORT),
        path: `/api/stream?code=${CODE}&voterId=${voterId}`,
        method: 'GET',
        headers: { Accept: 'text/event-stream' },
      },
      (res) => {
        if (res.statusCode !== 200) {
          console.error(`stream failed: HTTP ${res.statusCode}`);
          process.exit(1);
        }
        connected++;
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          buf += chunk;
          let i;
          while ((i = buf.indexOf('\n\n')) !== -1) {
            const frame = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const line = frame.split('\n').find((l) => l.startsWith('data: '));
            if (!line) continue;
            try {
              const state = JSON.parse(line.slice(6));
              if (state.phase) poll = state;
            } catch {
              /* keepalive or partial */
            }
          }
        });
        resolve();
      }
    );
    req.on('error', (e) => {
      console.error('stream error:', e.message);
      resolve();
    });
    req.end();
    streams.push(req);
  });
}

async function vote(voterId) {
  const payload = { code: CODE, voterId };
  if (!poll || poll.type === 'choice') {
    payload.choice = Math.floor(Math.random() * ((poll && poll.options.length) || 4));
  } else if (poll.type === 'word') {
    payload.text = WORDS[Math.floor(Math.random() * WORDS.length)];
  } else {
    payload.text = SENTENCES[Math.floor(Math.random() * SENTENCES.length)];
  }

  const t0 = process.hrtime.bigint();
  sent++;
  try {
    const res = await request('POST', '/api/vote', payload);
    latencies.push(Number(process.hrtime.bigint() - t0) / 1e6);
    if (res.status === 200) ok++;
    else {
      failed++;
      if (failed <= 3) console.error(`  vote rejected (${res.status}): ${res.body.error || ''}`);
    }
  } catch (e) {
    failed++;
    if (failed <= 3) console.error('  vote error:', e.message);
  }
}

function pct(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

(async () => {
  console.log(`\nConnecting ${COUNT} students to ${TARGET} (room ${CODE})…`);
  await Promise.all(Array.from({ length: COUNT }, (_, i) => openStream(`load-${i}`)));
  console.log(`  ${connected}/${COUNT} streams open`);

  await new Promise((r) => setTimeout(r, 400));
  if (!poll) {
    console.error('\nNo state received — is the room code right?');
    process.exit(1);
  }
  if (poll.phase !== 'open') {
    console.error(`\nVoting is "${poll.phase}". Open it in the teacher console, then rerun.`);
    process.exit(1);
  }
  console.log(`  poll type: ${poll.type}`);

  // Real classrooms do not vote in lockstep - answers arrive over a few seconds.
  console.log('\nVoting over ~4s…');
  const t0 = Date.now();
  await Promise.all(
    Array.from({ length: COUNT }, (_, i) =>
      new Promise((r) => setTimeout(() => vote(`load-${i}`).then(r), Math.random() * 4000))
    )
  );
  const elapsed = Date.now() - t0;

  const sorted = latencies.slice().sort((a, b) => a - b);
  console.log('\n  ── results ─────────────────────────────');
  console.log(`  votes sent      ${sent}`);
  console.log(`  accepted        ${ok}`);
  console.log(`  failed          ${failed}`);
  console.log(`  wall clock      ${elapsed} ms`);
  console.log(`  latency p50     ${pct(sorted, 50).toFixed(1)} ms`);
  console.log(`  latency p95     ${pct(sorted, 95).toFixed(1)} ms`);
  console.log(`  latency max     ${(sorted[sorted.length - 1] || 0).toFixed(1)} ms`);
  console.log('  ────────────────────────────────────────');
  console.log('\n  Streams stay open. Ctrl+C when you have finished watching the projector.\n');
})();
