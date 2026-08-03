/**
 * Spiral word cloud. Bigger word = more students said it.
 *
 * Placement is deterministic for a given input, and spans are reused across
 * updates keyed by their text, so CSS transitions animate words growing and
 * sliding rather than the whole cloud flickering on every new answer.
 */
(function (global) {
  'use strict';

  const PALETTE = ['--c1', '--c2', '--c3', '--c4', '--c5', '--c6'];
  const MAX_WORDS = 60;
  const PAD = 6;

  function hashHue(text) {
    let h = 0;
    for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) >>> 0;
    return PALETTE[h % PALETTE.length];
  }

  function overlaps(a, b) {
    return !(
      a.x2 + PAD < b.x1 || a.x1 - PAD > b.x2 || a.y2 + PAD < b.y1 || a.y1 - PAD > b.y2
    );
  }

  function render(container, words) {
    const W = container.clientWidth;
    const H = container.clientHeight;
    if (!W || !H) return;

    const list = words.slice(0, MAX_WORDS);
    const live = new Set(list.map((w) => w.text));

    // Drop spans for words that are gone (moderated out, or poll cleared)
    for (const el of [...container.children]) {
      if (el.dataset.word && !live.has(el.dataset.word)) el.remove();
    }
    if (!list.length) return;

    const max = list[0].count;
    const maxPx = Math.min(H * 0.3, W * 0.2, 190);
    const minPx = Math.max(15, maxPx * 0.24);
    const sizeFor = (c) => {
      const t = max <= 1 ? 0.5 : Math.sqrt((c - 1) / (max - 1));
      return minPx + (maxPx - minPx) * t;
    };

    // Shrink globally until everything fits rather than dropping words.
    for (let attempt = 0; attempt < 5; attempt++) {
      const scale = Math.pow(0.82, attempt);
      if (place(container, list, W, H, sizeFor, scale)) break;
    }

    // Only now, with positions final, let these spans animate on future updates.
    requestAnimationFrame(() => {
      for (const el of container.querySelectorAll('span.fresh')) el.classList.remove('fresh');
    });
  }

  /**
   * A scratch span with transitions disabled. The visible spans animate their
   * font-size, so measuring those would read a stale width mid-transition and
   * the whole layout would collide.
   */
  function measurer(container) {
    let m = container.querySelector('.wc-measure');
    if (!m) {
      m = document.createElement('span');
      m.className = 'wc-measure';
      container.appendChild(m);
    }
    return m;
  }

  function place(container, list, W, H, sizeFor, scale) {
    const rects = [];
    const cx = W / 2;
    const cy = H / 2;
    const aspect = W / H;
    const maxR = Math.max(W, H) * 0.75;
    const m = measurer(container);
    let allPlaced = true;

    for (const w of list) {
      const fontSize = Math.round(sizeFor(w.count) * scale);

      m.style.fontSize = `${fontSize}px`;
      m.textContent = w.text;
      const bw = m.offsetWidth;
      const bh = m.offsetHeight;

      let el = container.querySelector(`[data-word="${CSS.escape(w.text)}"]`);
      if (!el) {
        el = document.createElement('span');
        el.dataset.word = w.text;
        el.textContent = w.text;
        // A fresh span has no previous left/top, so without this it would
        // animate in from the container's origin instead of appearing in place.
        el.classList.add('fresh');
        container.appendChild(el);
      }
      el.title = `${w.text} - ${w.count}`;
      el.style.color = `var(${hashHue(w.text)})`;
      el.style.fontSize = `${fontSize}px`;

      let placed = false;
      for (let t = 0; t < 4000; t++) {
        const angle = 0.28 * t;
        const r = 2.4 * angle;
        if (r > maxR) break;
        const x = cx + r * Math.cos(angle) * aspect * 0.55;
        const y = cy + r * Math.sin(angle) * 0.55;
        const box = { x1: x - bw / 2, x2: x + bw / 2, y1: y - bh / 2, y2: y + bh / 2 };
        if (box.x1 < 0 || box.y1 < 0 || box.x2 > W || box.y2 > H) continue;
        if (rects.some((other) => overlaps(box, other))) continue;

        rects.push(box);
        el.style.left = `${Math.round(x)}px`;
        el.style.top = `${Math.round(y)}px`;
        el.classList.add('placed');
        placed = true;
        break;
      }

      if (!placed) {
        el.classList.remove('placed');
        allPlaced = false;
      }
    }

    return allPlaced;
  }

  global.WordCloud = { render };
})(window);
