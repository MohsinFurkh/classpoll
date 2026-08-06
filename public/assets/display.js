'use strict';
/* Projector view. Read from the back row; no controls, no answer key. */

const CODE = location.pathname.split('/').pop().toUpperCase();
const $ = (id) => document.getElementById(id);
const LETTERS = 'ABCDEF';
const HUES = ['--c1', '--c2', '--c3', '--c4', '--c5', '--c6'];

let state = null;

$('code').textContent = CODE;

// The teacher's browser is usually on localhost, which students cannot reach.
// The server hands back the address that actually works from the classroom wifi.
fetch('/api/join')
  .then((r) => r.json())
  .then(({ base }) => {
    const url = `${base}/${CODE}`;
    $('joinUrl').textContent = base.replace(/^https?:\/\//, '');
    $('qr').innerHTML = QR.svg(url, { ecc: 'M', quiet: 2, dark: '#0d1117', light: '#ffffff' });
  })
  .catch(() => {
    $('joinUrl').textContent = location.host;
  });

function show(id) {
  for (const k of ['waiting', 'bars', 'cloud', 'wall', 'dots', 'grid']) {
    $(k).classList.toggle('hidden', k !== id);
  }
}

// ---- renderers ---------------------------------------------------------------

function renderBars(r) {
  const box = $('bars');
  const total = r.counts.reduce((a, b) => a + b, 0) || 1;
  const revealed = state.phase === 'closed' && state.correct !== null;

  if (box.children.length !== state.options.length) {
    box.innerHTML = '';
    state.options.forEach((opt, i) => {
      const row = document.createElement('div');
      row.className = 'bar-row';
      const label = document.createElement('div');
      label.className = 'bar-label';
      label.textContent = `${LETTERS[i]}. ${opt}`;
      const track = document.createElement('div');
      track.className = 'bar-track';
      const fill = document.createElement('div');
      fill.className = 'bar-fill';
      fill.style.background = `var(${HUES[i % HUES.length]})`;
      track.appendChild(fill);
      const count = document.createElement('div');
      count.className = 'bar-count';
      row.append(label, track, count);
      box.appendChild(row);
    });
  }

  [...box.children].forEach((row, i) => {
    const pct = Math.round((r.counts[i] / total) * 100);
    const fill = row.querySelector('.bar-fill');
    fill.style.width = Math.max(pct, r.counts[i] ? 4 : 0) + '%';
    fill.textContent = pct >= 12 ? pct + '%' : '';
    row.querySelector('.bar-count').textContent = r.counts[i];
    row.classList.toggle('is-correct', revealed && state.correct === i);
    row.classList.toggle('dim', revealed && state.correct !== null && state.correct !== i);
  });

  show('bars');
}

/** While a choice vote is open we show participation only — never the tally. */
function renderDots() {
  const box = $('dots');
  const n = state.stats.responded;
  const target = Math.max(state.stats.joined, n, 20);

  if (box.dataset.target !== String(target)) {
    box.dataset.target = String(target);
    box.innerHTML = '';
    const grid = document.createElement('div');
    grid.style.cssText =
      'display:flex;flex-wrap:wrap;gap:1.1vh;justify-content:center;align-content:center;max-width:70vw;margin:0 auto';
    for (let i = 0; i < target; i++) {
      const d = document.createElement('div');
      d.style.cssText =
        'width:2.6vh;height:2.6vh;border-radius:50%;background:var(--panel);transition:background .3s,transform .3s';
      grid.appendChild(d);
    }
    box.appendChild(grid);
  }

  const dots = box.firstChild.children;
  for (let i = 0; i < dots.length; i++) {
    const on = i < n;
    dots[i].style.background = on ? 'var(--accent)' : 'var(--panel)';
    dots[i].style.transform = on ? 'scale(1)' : 'scale(.7)';
  }
  show('dots');
}

const LIMIT = 40;

function hueFor(id) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return HUES[h % HUES.length];
}

/**
 * Cards are reused across updates. Rebuilding the list would replay the entry
 * animation on every card each time an answer lands - a constant flicker on a
 * screen 100 people are reading.
 */
function renderWall(r) {
  const box = $('wall');
  const items = r.texts.slice(0, LIMIT);          // server sorts newest first
  const want = new Map(items.map((t) => [t.id, t]));

  for (const el of [...box.children]) {
    if (!el.classList.contains('more') && !want.has(el.dataset.id)) el.remove();
  }

  const present = new Set([...box.children].map((el) => el.dataset.id));
  const fresh = items.filter((t) => !present.has(t.id));
  for (let i = fresh.length - 1; i >= 0; i--) {   // reverse so newest ends up first
    const card = document.createElement('div');
    card.className = 'card';
    card.dataset.id = fresh[i].id;
    card.style.borderLeftColor = `var(${hueFor(fresh[i].id)})`;
    card.textContent = fresh[i].text;
    box.prepend(card);
  }

  const size =
    items.length > 24 ? 'clamp(.9rem,1.1vw,1.3rem)'
    : items.length > 12 ? 'clamp(1rem,1.4vw,1.8rem)'
    : 'clamp(1.2rem,1.9vw,2.4rem)';

  for (const el of box.children) {
    const t = want.get(el.dataset.id);
    if (t && el.textContent !== t.text) el.textContent = t.text;   // student edited it
    el.style.fontSize = size;
  }

  const overflow = r.texts.length - LIMIT;
  let more = box.querySelector('.more');
  if (overflow > 0) {
    if (!more) {
      more = document.createElement('div');
      more.className = 'card more muted';
      box.appendChild(more);
    }
    more.style.fontSize = size;
    more.textContent = `+ ${overflow} more`;
    box.appendChild(more);   // keep it last
  } else if (more) {
    more.remove();
  }

  show('wall');
}

// ---- multi-part grid ---------------------------------------------------------
//
// Every part of the poll is on screen at once, because the point of grouping
// six items into one poll is seeing the pattern across them - which item split
// the room, which one everybody agreed on. Splitting them back up on the
// projector would throw that away.

function gridColumns(n) {
  return n <= 2 ? n : n <= 4 ? 2 : 3;
}

function buildCell(part, i) {
  const cell = document.createElement('section');
  cell.className = 'cell';

  const head = document.createElement('div');
  head.className = 'cell-head';
  const tag = document.createElement('span');
  tag.className = 'cell-tag';
  tag.textContent = part.label || String(i + 1);
  const prompt = document.createElement('span');
  prompt.className = 'cell-prompt';
  prompt.textContent = part.prompt;
  head.append(tag, prompt);

  const body = document.createElement('div');
  body.className = 'cell-body';

  cell.append(head, body);
  return cell;
}

function paintChoiceCell(body, part, res, revealed) {
  const total = res.counts.reduce((a, b) => a + b, 0) || 1;

  if (body.children.length !== part.options.length) {
    body.innerHTML = '';
    part.options.forEach((opt, j) => {
      const row = document.createElement('div');
      row.className = 'cell-row';
      const label = document.createElement('span');
      label.className = 'cell-label';
      label.textContent = `${LETTERS[j]}. ${opt}`;
      const track = document.createElement('div');
      track.className = 'cell-track';
      const fill = document.createElement('div');
      fill.className = 'cell-fill';
      fill.style.background = `var(${HUES[j % HUES.length]})`;
      track.appendChild(fill);
      const count = document.createElement('span');
      count.className = 'cell-count';
      row.append(label, track, count);
      body.appendChild(row);
    });
  }

  [...body.children].forEach((row, j) => {
    const pct = Math.round((res.counts[j] / total) * 100);
    row.querySelector('.cell-fill').style.width = Math.max(pct, res.counts[j] ? 5 : 0) + '%';
    row.querySelector('.cell-count').textContent = res.counts[j] || '';
    const hit = revealed && part.correct === j;
    row.classList.toggle('is-correct', hit);
    row.classList.toggle('dim', revealed && part.correct !== null && !hit);
  });
}

function paintTextCell(body, res) {
  const items = res.texts.slice(0, 12);
  const want = new Map(items.map((t) => [t.id, t]));

  for (const card of [...body.children]) {
    if (!card.classList.contains('more') && !want.has(card.dataset.id)) card.remove();
  }

  const present = new Set([...body.children].map((c) => c.dataset.id));
  for (let i = items.length - 1; i >= 0; i--) {
    if (present.has(items[i].id)) continue;
    const card = document.createElement('div');
    card.className = 'cell-card';
    card.dataset.id = items[i].id;
    card.style.borderLeftColor = `var(${hueFor(items[i].id)})`;
    card.textContent = items[i].text;
    body.prepend(card);
  }

  for (const card of body.children) {
    const t = want.get(card.dataset.id);
    if (t && card.textContent !== t.text) card.textContent = t.text;
  }

  const overflow = res.texts.length - items.length;
  let more = body.querySelector('.more');
  if (overflow > 0) {
    if (!more) {
      more = document.createElement('div');
      more.className = 'cell-card more muted';
      body.appendChild(more);
    }
    more.textContent = `+ ${overflow} more`;
    body.appendChild(more);
  } else if (more) {
    more.remove();
  }

  if (!body.children.length) {
    const empty = document.createElement('div');
    empty.className = 'cell-card muted';
    empty.textContent = 'waiting…';
    body.appendChild(empty);
  }
}

function renderGrid(r) {
  const box = $('grid');
  const parts = state.parts || [];
  const revealed = state.phase === 'closed';

  const sig = parts.map((p) => `${p.label}:${p.type}`).join('§');
  if (box.dataset.signature !== sig) {
    box.dataset.signature = sig;
    box.innerHTML = '';
    parts.forEach((p, i) => box.appendChild(buildCell(p, i)));
    box.style.gridTemplateColumns = `repeat(${gridColumns(parts.length)}, minmax(0, 1fr))`;
  }

  parts.forEach((part, i) => {
    const body = box.children[i].querySelector('.cell-body');
    const res = r.parts[i];
    if (!res) return;
    if (res.kind === 'choice') paintChoiceCell(body, part, res, revealed);
    else paintTextCell(body, res);
  });

  show('grid');
}

// ---- main --------------------------------------------------------------------

function render() {
  if (!state) return;

  $('question').textContent = state.question || 'Scan the code to join';
  $('responded').textContent = state.stats.responded;
  $('phaseText').textContent =
    state.phase === 'open' ? 'voting open' : state.phase === 'closed' ? 'results' : `${state.stats.joined} joined`;

  if (state.phase === 'lobby' || !state.question) {
    $('waiting').textContent =
      state.stats.joined ? `${state.stats.joined} joined — waiting for the question` : 'Scan the code to join';
    return show('waiting');
  }

  const r = state.results;

  if (!r) {
    // Voting is open but the teacher chose to keep the tally hidden.
    return state.type === 'choice' || state.type === 'multi'
      ? renderDots()
      : (($('waiting').textContent = `${state.stats.responded} answers in`), show('waiting'));
  }

  if (r.kind === 'multi') return renderGrid(r);
  if (r.kind === 'choice') return renderBars(r);

  if (r.kind === 'word') {
    if (!r.words.length) {
      $('waiting').textContent = 'Waiting for the first answer…';
      return show('waiting');
    }
    show('cloud');
    WordCloud.render($('cloud'), r.words);
    return;
  }

  if (!r.texts.length) {
    $('waiting').textContent = 'Waiting for the first answer…';
    return show('waiting');
  }
  renderWall(r);
}

// Same reasoning as the student page: a missing room 404s the stream, which
// EventSource treats as fatal. The projector must come back on its own - it is
// on a wall, and nobody is going to notice it has quietly stopped updating.
let src = null;
let retryMs = 1000;

function connect() {
  if (src) src.close();
  src = new EventSource(`/api/stream?code=${CODE}`);

  src.addEventListener('open', () => {
    retryMs = 1000;
  });

  src.addEventListener('state', (e) => {
    state = JSON.parse(e.data);
    render();
  });

  src.onerror = () => {
    if (!state) {
      $('waiting').textContent = 'Waiting for the teacher to open the room…';
      show('waiting');
    }
    if (src.readyState === EventSource.CLOSED) {
      setTimeout(connect, retryMs);
      retryMs = Math.min(retryMs * 2, 15000);
    }
  };
}

connect();

let resizeTimer;
addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(render, 150);
});

// Word-cloud placement depends on measured text width, so redo it once the
// font metrics are final.
if (document.fonts && document.fonts.ready) document.fonts.ready.then(render);
