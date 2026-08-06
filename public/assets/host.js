'use strict';
/* Teacher console. Kept off the projector so the answer key stays private. */

const $ = (id) => document.getElementById(id);
const LETTERS = 'ABCDEF';
const STORE = 'classpoll:host';
const DECK_STORE = 'classpoll:deck';
const KEY_STORE = 'classpoll:key';

// Only used when the server was started with HOST_KEY set - i.e. when this is
// on a public URL that students also have. /host?key=... works for a bookmark;
// otherwise we ask once and remember it on this laptop.
let hostKey = localStorage.getItem(KEY_STORE) || '';

let session = null;   // { code, hostToken }
let state = null;
let correct = null;   // index of the correct option, or null

let deck = null;      // { title, questions: [...] } currently loaded
let deckFile = '';    // filename it came from
let deckIndex = -1;   // which question is in the form, or -1 for none

// A multi-part poll has no editor in the console - it is authored in a deck file
// and held here verbatim between loading it and pushing it. Editing six
// sub-questions through a web form during a lecture is not a real workflow.
let pendingParts = null;

// ---- session bootstrap -------------------------------------------------------

// /host?code=MTBN claims a fixed room, so a code printed on a lecture slide
// keeps working after the server restarts.
const params = new URLSearchParams(location.search);
const wantedCode = (params.get('code') || '').toUpperCase().replace(/[^A-Z]/g, '');

// /host?key=... lets the whole thing live in one bookmark. Remember it and drop
// it from the address bar, so the key is not sitting on screen in front of a class.
if (params.get('key')) {
  hostKey = params.get('key').trim();
  localStorage.setItem(KEY_STORE, hostKey);
  params.delete('key');
  const rest = params.toString();
  history.replaceState(null, '', location.pathname + (rest ? '?' + rest : ''));
}

async function newSession(code, token) {
  const res = await fetch('/api/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...(code ? { code, token } : {}), key: hostKey }),
  });
  const data = await res.json();

  if (!res.ok) {
    if (res.status === 401) {
      // Wrong key: forget it so the next attempt asks again rather than
      // silently retrying something we already know is wrong.
      localStorage.removeItem(KEY_STORE);
      const entered = prompt(
        hostKey ? 'That host key was not accepted. Try again:' : 'Host key for this server:'
      );
      if (!entered) return;
      hostKey = entered.trim();
      localStorage.setItem(KEY_STORE, hostKey);
      return newSession(code, token);
    }
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

  // It is gone. Claim the same code back rather than taking a fresh one: the
  // old code is on the projector and in sixty phones, and a host that sleeps
  // and restarts mid-lecture would otherwise orphan the entire room.
  if (!probe.ok) return newSession(session.code, session.hostToken);
  attach();
}

let src = null;

function attach() {
  $('codeBadge').textContent = session.code;
  $('displayLink').href = `/d/${session.code}`;
  $('joinUrl').textContent = `${location.host}  →  ${session.code}`;

  if (src) src.close();
  src = new EventSource(
    `/api/stream?code=${session.code}&token=${encodeURIComponent(session.hostToken)}`
  );

  src.addEventListener('state', (e) => {
    state = JSON.parse(e.data);
    render();
  });

  src.onerror = () => {
    // A restarted server has forgotten the room and our host token with it, so
    // reconnecting to the old stream is pointless - boot() claims the room again
    // and issues a fresh token. Without this the console goes quietly stale:
    // the numbers stop moving and the buttons stop working, with no clue why.
    if (src.readyState === EventSource.CLOSED) setTimeout(boot, 2000);
  };
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
  const multi = type === 'multi';

  $('optionsBlock').classList.toggle('hidden', type !== 'choice');
  $('multiBlock').classList.toggle('hidden', !multi);
  $('multiNote').textContent = multi && pendingParts
    ? `${pendingParts.length} parts, answered together on one screen — edit them in the deck file.`
    : '';
  $('liveResults').checked = type !== 'choice' && !multi;
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
  if (type === 'multi' && !(pendingParts && pendingParts.length)) {
    return alert('Load a multi-part question from a deck first.');
  }

  await command('setPoll', {
    type,
    question,
    options,
    parts: type === 'multi' ? pendingParts : [],
    correct: type === 'choice' ? correct : null,
    liveResults: $('liveResults').checked,
  });
  if (open) await command('open');
}

// ---- decks -------------------------------------------------------------------
//
// A deck is a lecture's questions in slide order, so the teacher is never typing
// a question with the class watching. Loading one only fills the form - it never
// pushes to the projector on its own, because the moment a question appears is a
// timing decision that belongs to the person in the room, not to a file.

function fillForm(q) {
  const type = ['choice', 'word', 'text', 'multi'].includes(q.type) ? q.type : 'choice';
  pendingParts = type === 'multi' && Array.isArray(q.parts) ? q.parts : null;

  $('type').value = type;
  syncTypeUI();
  $('question').value = String(q.question || '');

  if (type === 'multi') renderPartsSummary();

  if (type === 'choice') {
    const opts = (Array.isArray(q.options) ? q.options : []).slice(0, 6);
    while (opts.length < 2) opts.push('');
    $('optionRows').innerHTML = '';
    opts.forEach((o) => $('optionRows').appendChild(optionRow(o)));
    correct = Number.isInteger(q.correct) && q.correct >= 0 && q.correct < opts.length
      ? q.correct
      : null;
    paintCorrect();
  } else {
    correct = null;
  }

  // syncTypeUI picked a sensible default; an explicit value in the deck wins.
  if (typeof q.liveResults === 'boolean') $('liveResults').checked = q.liveResults;
}

/** The answer key, on the laptop only — this is exactly what must not be projected. */
function renderPartsSummary() {
  const box = $('multiParts');
  box.innerHTML = '';
  if (!pendingParts) return;

  pendingParts.forEach((p, i) => {
    const row = document.createElement('div');
    row.className = 'part-summary';

    const tag = document.createElement('span');
    tag.className = 'slot';
    tag.textContent = p.label || String(i + 1);

    const text = document.createElement('span');
    text.className = 'label';
    text.textContent = p.prompt || '';

    const key = document.createElement('span');
    key.className = 'key';
    if (p.type === 'text') key.textContent = 'free text';
    else if (Number.isInteger(p.correct)) key.textContent = `✓ ${LETTERS[p.correct]}`;
    else key.textContent = 'no key';
    if (Number.isInteger(p.correct) && p.type === 'choice') key.style.color = 'var(--good)';

    row.append(tag, text, key);
    box.appendChild(row);
  });
}

function loadQuestion(i) {
  if (!deck || i < 0 || i >= deck.questions.length) return;
  deckIndex = i;
  fillForm(deck.questions[i]);
  localStorage.setItem(DECK_STORE, JSON.stringify({ file: deckFile, index: i }));
  renderDeck();
  $('question').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function renderDeck() {
  const list = $('deckList');
  list.innerHTML = '';
  if (!deck) return;

  deck.questions.forEach((q, i) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className =
      'deck-row' + (i === deckIndex ? ' is-current' : i < deckIndex ? ' is-done' : '');

    const slot = document.createElement('span');
    slot.className = 'slot';
    slot.textContent = q.slot || String(i + 1);

    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = q.label || q.question || '(untitled)';

    row.append(slot, label);
    row.addEventListener('click', () => loadQuestion(i));
    list.appendChild(row);
  });

  const n = deck.questions.length;
  $('deckPos').textContent = deckIndex < 0 ? `${n} questions` : `${deckIndex + 1} of ${n}`;
  $('deckPrev').disabled = deckIndex <= 0;
  $('deckNext').disabled = deckIndex >= n - 1;
  $('deckHint').textContent =
    deckIndex < 0 ? 'Pick a question to load it into the form.' : 'Loaded — not yet on the projector.';

  const current = list.querySelector('.is-current');
  if (current) current.scrollIntoView({ block: 'nearest' });
}

async function chooseDeck(file, restoreIndex) {
  deck = null;
  deckFile = '';
  deckIndex = -1;

  if (file) {
    try {
      const res = await fetch(`/decks/${encodeURIComponent(file)}`);
      const data = await res.json();
      if (Array.isArray(data.questions) && data.questions.length) {
        deck = data;
        deckFile = file;
      }
    } catch {
      alert(`Could not read deck ${file}.`);
    }
  }

  renderDeck();
  if (deck && Number.isInteger(restoreIndex)) loadQuestion(restoreIndex);
  localStorage.setItem(DECK_STORE, JSON.stringify({ file: deckFile, index: deckIndex }));
}

async function loadDecks() {
  let decks = [];
  try {
    decks = (await (await fetch('/api/decks')).json()).decks || [];
  } catch {
    /* server too old or offline: the panel just stays hidden */
  }
  if (!decks.length) return;   // no decks authored - nothing to show

  $('deckPanel').classList.remove('hidden');
  const pick = $('deckPick');
  pick.innerHTML = '';
  pick.appendChild(new Option('— no deck —', ''));
  for (const d of decks) pick.appendChild(new Option(`${d.title}  (${d.count})`, d.file));

  // A mid-lecture reload should come back to the same place in the same deck.
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(DECK_STORE) || 'null');
  } catch {
    saved = null;
  }
  if (saved && decks.some((d) => d.file === saved.file)) {
    pick.value = saved.file;
    await chooseDeck(saved.file, saved.index);
  }
}

// ---- rendering ---------------------------------------------------------------

/** One compact block per part, so the teacher can see at a glance which one split the room. */
function renderMultiPreview(box, r) {
  (state.parts || []).forEach((part, i) => {
    const res = r.parts[i];
    if (!res) return;

    const head = document.createElement('div');
    head.className = 'muted';
    head.style.cssText = 'font-size:.8rem;margin:.9rem 0 .3rem;font-weight:700';
    head.textContent = `${part.label || i + 1} · ${part.prompt}`;
    box.appendChild(head);

    if (res.kind === 'choice') {
      const total = res.counts.reduce((a, b) => a + b, 0);
      part.options.forEach((opt, j) => {
        const pct = total ? Math.round((res.counts[j] / total) * 100) : 0;
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;gap:.5rem;align-items:center;font-size:.85rem;margin-bottom:.2rem';
        const name = document.createElement('span');
        name.style.cssText = 'flex:0 0 9rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
        name.textContent = `${LETTERS[j]}. ${opt}${part.correct === j ? ' ✓' : ''}`;
        if (part.correct === j) name.style.color = 'var(--good)';
        const bar = document.createElement('div');
        bar.className = 'mini-bar';
        bar.style.flex = '1';
        const fill = document.createElement('span');
        fill.style.width = pct + '%';
        if (part.correct === j) fill.style.background = 'var(--good)';
        bar.appendChild(fill);
        const num = document.createElement('span');
        num.className = 'muted';
        num.style.cssText = 'flex:0 0 3.5rem;text-align:right';
        num.textContent = `${pct}% · ${res.counts[j]}`;
        row.append(name, bar, num);
        box.appendChild(row);
      });
    } else {
      const n = document.createElement('div');
      n.className = 'muted';
      n.style.fontSize = '.85rem';
      n.textContent = `${res.texts.length} answer${res.texts.length === 1 ? '' : 's'}`;
      box.appendChild(n);
    }
  });
}

function renderPreview() {
  const box = $('preview');
  const r = state.results;
  box.innerHTML = '';

  if (!r) return void (box.textContent = 'No answers yet.');

  if (r.kind === 'multi') return renderMultiPreview(box, r);

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
$('deckPick').addEventListener('change', (e) => chooseDeck(e.target.value));
$('deckPrev').addEventListener('click', () => loadQuestion(deckIndex - 1));
$('deckNext').addEventListener('click', () => loadQuestion(deckIndex < 0 ? 0 : deckIndex + 1));

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
loadDecks();
