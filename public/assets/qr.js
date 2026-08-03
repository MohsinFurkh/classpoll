/**
 * Minimal QR encoder - byte mode, versions 1-10, EC level L or M.
 * Enough for a LAN URL like http://192.168.1.20:3000/MKPQ, and it means the
 * projector page pulls in no external library.
 *
 * window.QR.svg(text, opts) -> SVG string
 */
(function (global) {
  'use strict';

  // ---- GF(256), primitive polynomial 0x11d -------------------------------
  const EXP = new Uint8Array(512);
  const LOG = new Uint8Array(256);
  (function () {
    let x = 1;
    for (let i = 0; i < 255; i++) {
      EXP[i] = x;
      LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d;
    }
    for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  })();

  const gmul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

  function rsGenerator(degree) {
    let result = [1];
    for (let i = 0; i < degree; i++) {
      const next = new Array(result.length + 1).fill(0);
      for (let j = 0; j < result.length; j++) {
        next[j] ^= result[j];
        next[j + 1] ^= gmul(result[j], EXP[i]);
      }
      result = next;
    }
    return result;
  }

  function rsRemainder(data, ecLen) {
    const gen = rsGenerator(ecLen);
    const rem = new Uint8Array(ecLen);
    for (const b of data) {
      const factor = b ^ rem[0];
      rem.copyWithin(0, 1);
      rem[ecLen - 1] = 0;
      for (let i = 0; i < ecLen; i++) rem[i] ^= gmul(gen[i + 1], factor);
    }
    return rem;
  }

  // ---- block structure ---------------------------------------------------
  // [ecCodewordsPerBlock, blocksInGroup1, dataPerBlock1, blocksInGroup2, dataPerBlock2]
  const BLOCKS = {
    L: {
      1: [7, 1, 19], 2: [10, 1, 34], 3: [15, 1, 55], 4: [20, 1, 80], 5: [26, 1, 108],
      6: [18, 2, 68], 7: [20, 2, 78], 8: [24, 2, 97], 9: [30, 2, 116], 10: [18, 2, 68, 2, 69],
    },
    M: {
      1: [10, 1, 16], 2: [16, 1, 28], 3: [26, 1, 44], 4: [18, 2, 32], 5: [24, 2, 43],
      6: [16, 4, 27], 7: [18, 4, 31], 8: [22, 2, 38, 2, 39], 9: [22, 3, 36, 2, 37],
      10: [26, 4, 43, 1, 44],
    },
  };

  const ALIGN = {
    1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
    6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
  };

  const EC_BITS = { L: 1, M: 0 };

  function dataCapacity(version, ecc) {
    const [, b1, d1, b2 = 0, d2 = 0] = BLOCKS[ecc][version];
    return b1 * d1 + b2 * d2;
  }

  // ---- bit buffer --------------------------------------------------------
  function BitBuffer() {
    this.bits = [];
  }
  BitBuffer.prototype.push = function (value, len) {
    for (let i = len - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
  };

  // ---- encode ------------------------------------------------------------
  function encodeData(text, ecc) {
    const bytes = new TextEncoder().encode(text);

    let version = 0;
    for (let v = 1; v <= 10; v++) {
      const countBits = v < 10 ? 8 : 16;
      if (4 + countBits + bytes.length * 8 <= dataCapacity(v, ecc) * 8) {
        version = v;
        break;
      }
    }
    if (!version) throw new Error('QR: text too long for version 10');

    const bb = new BitBuffer();
    bb.push(0b0100, 4);                        // byte mode
    bb.push(bytes.length, version < 10 ? 8 : 16);
    for (const b of bytes) bb.push(b, 8);

    const capacityBits = dataCapacity(version, ecc) * 8;
    bb.push(0, Math.min(4, capacityBits - bb.bits.length));   // terminator
    while (bb.bits.length % 8 !== 0) bb.bits.push(0);
    for (let pad = 0xec; bb.bits.length < capacityBits; pad ^= 0xec ^ 0x11) {
      bb.push(pad, 8);
    }

    const words = new Uint8Array(bb.bits.length / 8);
    for (let i = 0; i < bb.bits.length; i++) {
      if (bb.bits[i]) words[i >>> 3] |= 0x80 >>> (i & 7);
    }

    // Split into blocks, add error correction, then interleave.
    const [ecLen, b1, d1, b2 = 0, d2 = 0] = BLOCKS[ecc][version];
    const blocks = [];
    let off = 0;
    for (let i = 0; i < b1 + b2; i++) {
      const len = i < b1 ? d1 : d2;
      const data = words.slice(off, off + len);
      off += len;
      blocks.push({ data, ec: rsRemainder(data, ecLen) });
    }

    const out = [];
    const maxData = Math.max(d1, d2);
    for (let i = 0; i < maxData; i++) {
      for (const blk of blocks) if (i < blk.data.length) out.push(blk.data[i]);
    }
    for (let i = 0; i < ecLen; i++) {
      for (const blk of blocks) out.push(blk.ec[i]);
    }

    const bits = [];
    for (const byte of out) for (let i = 7; i >= 0; i--) bits.push((byte >>> i) & 1);
    return { version, bits };
  }

  // ---- module placement --------------------------------------------------
  function buildMatrix(version, ecc, bits) {
    const size = version * 4 + 17;
    const mod = Array.from({ length: size }, () => new Array(size).fill(false));
    const fn = Array.from({ length: size }, () => new Array(size).fill(false));

    const setFn = (x, y, dark) => {
      if (x < 0 || y < 0 || x >= size || y >= size) return;
      mod[y][x] = dark;
      fn[y][x] = true;
    };

    // Finder patterns + separators
    for (const [fx, fy] of [[0, 0], [size - 7, 0], [0, size - 7]]) {
      for (let dy = -1; dy <= 7; dy++) {
        for (let dx = -1; dx <= 7; dx++) {
          const inner = dx >= 0 && dx <= 6 && dy >= 0 && dy <= 6;
          const dark =
            inner &&
            (dx === 0 || dx === 6 || dy === 0 || dy === 6 ||
              (dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4));
          setFn(fx + dx, fy + dy, dark);
        }
      }
    }

    // Timing patterns
    for (let i = 8; i < size - 8; i++) {
      setFn(i, 6, i % 2 === 0);
      setFn(6, i, i % 2 === 0);
    }

    // Alignment patterns (skipped where they would collide with a finder)
    const centers = ALIGN[version];
    for (const r of centers) {
      for (const c of centers) {
        if ((r === 6 && c === 6) || (r === 6 && c === size - 7) || (r === size - 7 && c === 6)) {
          continue;
        }
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            setFn(c + dx, r + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
          }
        }
      }
    }

    // Reserve the format-info strips (real values written after masking).
    // Index 6 is skipped in both directions - that cell belongs to the timing
    // pattern, and clobbering it stops scanners locking onto the module grid.
    for (let i = 0; i <= 8; i++) {
      if (i === 6) continue;
      setFn(8, i, false);
      setFn(i, 8, false);
    }
    for (let i = 0; i < 8; i++) {
      setFn(size - 1 - i, 8, false);
      setFn(8, size - 1 - i, false);
    }
    setFn(8, size - 8, true); // the always-dark module

    if (version >= 7) {
      let rem = version;
      for (let i = 0; i < 12; i++) rem = ((rem << 1) ^ ((rem >>> 11) * 0x1f25)) & 0xffffff;
      const vbits = (version << 12) | rem;
      for (let i = 0; i < 18; i++) {
        const bit = ((vbits >>> i) & 1) === 1;
        const a = size - 11 + (i % 3);
        const b = Math.floor(i / 3);
        setFn(a, b, bit);
        setFn(b, a, bit);
      }
    }

    // Data, laid out in an upward/downward zigzag of 2-wide columns
    let idx = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5; // column 6 is the vertical timing pattern
      const upward = ((right + 1) & 2) === 0;
      for (let v = 0; v < size; v++) {
        const y = upward ? size - 1 - v : v;
        for (let k = 0; k < 2; k++) {
          const x = right - k;
          if (fn[y][x]) continue;
          mod[y][x] = idx < bits.length ? bits[idx] === 1 : false;
          idx++;
        }
      }
    }

    return { mod, fn, size };
  }

  function applyMask(mod, fn, size, mask) {
    const f = [
      (i, j) => (i + j) % 2 === 0,
      (i) => i % 2 === 0,
      (i, j) => j % 3 === 0,
      (i, j) => (i + j) % 3 === 0,
      (i, j) => (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0,
      (i, j) => ((i * j) % 2) + ((i * j) % 3) === 0,
      (i, j) => (((i * j) % 2) + ((i * j) % 3)) % 2 === 0,
      (i, j) => (((i + j) % 2) + ((i * j) % 3)) % 2 === 0,
    ][mask];
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (!fn[y][x] && f(y, x)) mod[y][x] = !mod[y][x];
      }
    }
  }

  function writeFormat(mod, size, ecc, mask) {
    const data = (EC_BITS[ecc] << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = ((rem << 1) ^ ((rem >>> 9) * 0x537)) & 0x7ff;
    const bits = (((data << 10) | rem) ^ 0x5412) & 0x7fff;
    const bit = (i) => ((bits >>> i) & 1) === 1;

    for (let i = 0; i <= 5; i++) mod[i][8] = bit(i);
    mod[7][8] = bit(6);
    mod[8][8] = bit(7);
    mod[8][7] = bit(8);
    for (let i = 9; i < 15; i++) mod[8][14 - i] = bit(i);

    for (let i = 0; i < 8; i++) mod[8][size - 1 - i] = bit(i);
    for (let i = 8; i < 15; i++) mod[size - 15 + i][8] = bit(i);
    mod[size - 8][8] = true;
  }

  function penalty(mod, size) {
    let score = 0;

    // Rule 1: runs of five or more same-coloured modules
    for (let i = 0; i < size; i++) {
      for (const read of [(k) => mod[i][k], (k) => mod[k][i]]) {
        let run = 1;
        for (let k = 1; k < size; k++) {
          if (read(k) === read(k - 1)) {
            run++;
            if (run === 5) score += 3;
            else if (run > 5) score += 1;
          } else run = 1;
        }
      }
    }

    // Rule 2: 2x2 blocks of one colour
    for (let y = 0; y < size - 1; y++) {
      for (let x = 0; x < size - 1; x++) {
        const c = mod[y][x];
        if (c === mod[y][x + 1] && c === mod[y + 1][x] && c === mod[y + 1][x + 1]) score += 3;
      }
    }

    // Rule 3: finder-lookalike 1:1:3:1:1 patterns
    const A = [true, false, true, true, true, false, true, false, false, false, false];
    const B = [false, false, false, false, true, false, true, true, true, false, true];
    const matches = (read, start) => {
      let a = true;
      let b = true;
      for (let k = 0; k < 11; k++) {
        const v = read(start + k);
        if (v !== A[k]) a = false;
        if (v !== B[k]) b = false;
      }
      return (a ? 1 : 0) + (b ? 1 : 0);
    };
    for (let i = 0; i < size; i++) {
      for (let j = 0; j + 11 <= size; j++) {
        score += 40 * matches((k) => mod[i][k], j);
        score += 40 * matches((k) => mod[k][i], j);
      }
    }

    // Rule 4: deviation from a 50/50 dark ratio
    let dark = 0;
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (mod[y][x]) dark++;
    const pct = (dark * 100) / (size * size);
    score += Math.floor(Math.abs(pct - 50) / 5) * 10;

    return score;
  }

  function matrix(text, ecc) {
    ecc = ecc || 'M';
    const { version, bits } = encodeData(text, ecc);

    let best = null;
    for (let mask = 0; mask < 8; mask++) {
      const { mod, fn, size } = buildMatrix(version, ecc, bits);
      applyMask(mod, fn, size, mask);
      writeFormat(mod, size, ecc, mask);
      const score = penalty(mod, size);
      if (!best || score < best.score) best = { score, mod, size };
    }
    return { modules: best.mod, size: best.size };
  }

  function svg(text, opts) {
    opts = opts || {};
    const quiet = opts.quiet == null ? 4 : opts.quiet;
    const dark = opts.dark || '#000';
    const light = opts.light || '#fff';
    const { modules, size } = matrix(text, opts.ecc || 'M');
    const total = size + quiet * 2;

    // One path for every dark module keeps the DOM to a single node.
    let d = '';
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (modules[y][x]) d += `M${x + quiet} ${y + quiet}h1v1h-1z`;
      }
    }

    return (
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" ` +
      `shape-rendering="crispEdges" width="100%" height="100%">` +
      `<rect width="${total}" height="${total}" fill="${light}"/>` +
      `<path d="${d}" fill="${dark}"/></svg>`
    );
  }

  global.QR = { matrix, svg, _tables: { BLOCKS, ALIGN } };
})(window);
