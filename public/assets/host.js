'use strict';
/* Teacher console. Kept off the projector so the answer key stays private. */

const $ = (id) => document.getElementById(id);
const LETTERS = 'ABCDEF';
const STORE = 'classpoll:host';

let session = null;   // { code, hostToken }
let state = null;
let correct = null;   // index of the correct option, or null

// ---- session bootstrap -------------------------------------------------------

// /host?code=MTBN claims a fixed room, so a code printed on a lecture slide
// keeps working after the server restarts.
const wantedCode = (new URLSearchParams(location.search).get('code') || '')
  .toUpperCase()
  .replace(/[^A-Z]/g, '');

async function newSession(code, token) {
  const res = await fetch('/api/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(code ? { code, token } : {}),
  });
  const data = await res.json();

  if (!res.ok) {
    if (res.status === 409) {
      alert(
        `Room ${code} is already open in another browser or tab.\n\n` +
          `Close it, or remove ?code=${code} from this URL to get a fresh code.`
      );
      return;
    }
    alert(data.error || 'Could not start a room');
    return;
  }

  session = data;
  localStorage.setItem(STORE, JSON.stringify(session));
  attach();
}

async function boot() {
  try {
    session = JSON.parse(localStorage.getItem(STORE) || 'null');
  } catch {
    session = null;
  }

  if (wantedCode) {
    // Reuse the stored token if it belongs to this room, so a reload reclaims it.
    const token = session && session.code === wantedCode ? session.hostToken : undefined;
    return newSession(wantedCode, token);
  }

  if (!session || !session.code) return newSession();

  // The server restarts with empty memory; make sure the room still exists.
  const probe = await fetch('/api/host', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: session.code, token: session.hostToken, action: 'ping' }),
  });
  if (!probe.ok) return newSession();
  attach();
}

function attach() {
  $('codeBadge').textContent = session.code;
  $('displayLink').href = `/d/${session.code}`;
  $('joinUrl').textContent = `${location.host}  →  ${session.code}`;

  const src = new EventSource(
    `/api/stream?code=${session.code}&token=${encodeURIComponent(session.hostToken)}`
  );
  src.addEventListener('state', (e) => {
    state = JSON.parse(e.data);
    render();
  });
}

async function command(action, extra) {
  const res = await fetch('/api/host', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: session.code, token: session.hostToken, action, ...extra }),
  });
  const data = await res.json();
  if (!res.ok) alert(data.error || 'Something went wrong');
  else {
    state = data;
    render();
  }
}

// ---- question builder --------------------------------------------------------

function optionRow(value) {
  const row = document.createElement('div');
  row.className = 'opt-row';

  const input = document.createElement('input');
  input.maxLength = 80;
  input.value = value || '';
  input.placeholder = 'Option text';

  const mark = document.createElement('button');
  mark.type = 'button';
  mark.className = 'mark';
  mark.textContent = '✓ correct';
  mark.addEventListener('click', () => {
    const rows = [...$('optionRows').children];
    const i = rows.indexOf(row);
    correct = correct === i ? null : i;
    paintCorrect();
  });

  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'mark';
  del.textContent = '✕';
  del.addEventListener('click', () => {
    if ($('optionRows').children.length <= 2) return;
    row.remove();
    correct = null;
    paintCorrect();
  });

  row.append(input, mark, del);
  return row;
}

function paintCorrect() {
  [...$('optionRows').children].forEach((row, i) => {
    row.querySelector('.mark').classList.toggle('is-correct', correct === i);
  });
}

function readOptions() {
  return [...$('optionRows').querySelectorAll('input')].map((i) => i.value.trim()).filter(Boolean);
}

function syncTypeUI() {
  const type = $('type').value;
  $('optionsBlock').classList.toggle('hidden', type !== 'choice');
  $('liveResults').checked = type !== 'choice';
  $('liveHint').textContent =
    type === 'choice'
      ? 'Off by default — a visible leading bar makes late voters follow the crowd.'
      : 'On by default — watching the cloud fill up is half the fun.';
  $('question').placeholder =
    type === 'choice'
      ? 'Which sorting algorithm is O(n log n) in the worst case?'
      : type === 'word'
      ? 'One word: how did today\'s topic feel?'
      : 'In one sentence, what is still unclear?';
}

async function setPoll(open) {
  const type = $('type').value;
  const question = $('question').value.trim();
  if (!question) return alert('Add a question first.');

  const options = type === 'choice' ? readOptions() : [];
  if (type === 'choice' && options.length < 2) return alert('Add at least two options.');

  await command('setPoll', {
    type,
    question,
    options,
    correct: type === 'choice' ? correct : null,
    liveResults: $('liveResults').checked,
  });
  if (open) await command('open');
}

// ---- rendering ---------------------------------------------------------------

function renderPreview() {
  const box = $('preview');
  const r = state.results;
  box.innerHTML = '';

  if (!r) return void (box.textContent = 'No answers yet.');

  if (r.kind === 'choice') {
    const total = r.counts.reduce((a, b) => a + b, 0);
    if (!total) return void (box.textContent = 'No answers yet.');
    state.options.forEach((opt, i) => {
      const pct = Math.round((r.counts[i] / total) * 100);
      const wrap = document.createElement('div');
      wrap.style.margin = '0 0 .7rem';
      const head = document.createElement('div');
      head.className = 'row';
      head.style.justifyContent = 'space-between';
      const name = document.createElement('strong');
      name.textContent = `${LETTERS[i]}. ${opt}${state.correct === i ? '  ✓' : ''}`;
      if (state.correct === i) name.style.color = 'var(--good)';
      const num = document.createElement('span');
      num.className = 'muted';
      num.textContent = `${pct}% · ${r.counts[i]}`;
      head.append(name, num);
      const bar = document.createElement('div');
      bar.className = 'mini-bar';
      bar.style.marginTop = '.35rem';
      const fill = document.createElement('span');
      fill.style.width = pct + '%';
      if (state.correct === i) fill.style.background = 'var(--good)';
      bar.appendChild(fill);
      wrap.append(head, bar);
      box.appendChild(wrap);
    });
    return;
  }

  if (r.kind === 'word') {
    if (!r.words.length) return void (box.textContent = 'No answers yet.');
    box.innerHTML = '';
    for (const w of r.words.slice(0, 25)) {
      const chip = document.createElement('span');
      chip.className = 'pill';
      chip.style.margin = '0 .35rem .35rem 0';
      chip.style.color = 'var(--ink)';
      chip.textContent = `${w.text} ×${w.count}`;
      box.appendChild(chip);
    }
    return;
  }

  box.textContent = `${r.texts.length} answer${r.texts.length === 1 ? '' : 's'} — see the moderation list below.`;
}

function renderModeration() {
  const show = state.type !== 'choice' && state.moderation && state.moderation.length;
  $('modPanel').classList.toggle('hidden', !show);
  if (!show) return;

  // Rebuilding this list on every broadcast would reset its scroll position and
  // move the hide buttons while the teacher is aiming at one. Reuse rows.
  const list = $('modList');
  const want = new Map(state.moderation.map((m) => [m.id, m]));

  for (const row of [...list.children]) {
    if (!want.has(row.dataset.id)) row.remove();
  }

  const present = new Set([...list.children].map((r) => r.dataset.id));
  for (let i = state.moderation.length - 1; i >= 0; i--) {
    const item = state.moderation[i];
    if (present.has(item.id)) continue;
    const row = document.createElement('div');
    row.className = 'mod-item';
    row.dataset.id = item.id;
    const text = document.createElement('span');
    const btn = document.createElement('button');
    btn.addEventListener('click', () => {
      const current = state.moderation.find((m) => m.id === item.id);
      command(current && current.hidden ? 'unhide' : 'hide', { id: item.id });
    });
    row.append(text, btn);
    list.prepend(row);   // newest first
  }

  for (const row of list.children) {
    const item = want.get(row.dataset.id);
    if (!item) continue;
    row.classList.toggle('is-hidden', item.hidden);
    const text = row.querySelector('span');
    if (text.textContent !== item.text) text.textContent = item.text;
    row.querySelector('button').textContent = item.hidden ? 'show' : 'hide';
  }
}

function render() {
  if (!state) return;

  $('phasePill').textContent = state.phase;
  $('phasePill').className =
    'pill ' + (state.phase === 'open' ? 'open' : state.phase === 'closed' ? 'closed' : '');

  $('respondedCount').textContent = state.stats.responded;
  $('joinedCount').textContent = state.stats.joined;
  const pct = state.stats.joined ? (state.stats.responded / state.stats.joined) * 100 : 0;
  $('respondedBar').style.width = Math.min(100, pct) + '%';

  $('openBtn').textContent = state.phase === 'closed' ? 'Reopen voting' : 'Open voting';
  $('openBtn').disabled = state.phase === 'open';
  $('closeBtn').disabled = state.phase !== 'open';

  renderPreview();
  renderModeration();
}

// ---- wiring ------------------------------------------------------------------

$('optionRows').append(optionRow('') , optionRow(''));
syncTypeUI();

$('type').addEventListener('change', syncTypeUI);
$('addOption').addEventListener('click', () => {
  if ($('optionRows').children.length >= 6) return;
  $('optionRows').appendChild(optionRow(''));
});
$('startBtn').addEventListener('click', () => setPoll(true));
$('setOnly').addEventListener('click', () => setPoll(false));
$('openBtn').addEventListener('click', () => command('open'));
$('closeBtn').addEventListener('click', () => command('close'));
$('clearBtn').addEventListener('click', () => {
  if (confirm('Delete every answer for this question?')) command('clear');
});
$('newSession').addEventListener('click', () => {
  if (!confirm('Start a new room with a new code? Students will need to rejoin.')) return;
  // Drop any ?code= so this really does hand out a fresh code.
  if (wantedCode) location.href = '/host';
  else newSession();
});

boot();
