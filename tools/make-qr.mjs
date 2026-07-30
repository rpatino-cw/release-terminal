#!/usr/bin/env node
/* make-qr.mjs - generate qr.svg for the ASSET RELEASE TERMINAL deploy URL.
 *
 * Zero dependencies. Byte mode, error correction level M, smallest fitting
 * version (1 through 5), all 8 masks evaluated with the standard penalty
 * rules, lowest penalty wins.
 *
 * This script REFUSES to write qr.svg unless it can decode its own output
 * back to the exact input URL. An unscannable sticker is worse than no
 * sticker, so on any self-check failure it prints paste-ready instructions
 * instead.
 *
 * Usage:
 *   node tools/make-qr.mjs                 (default deploy URL)
 *   node tools/make-qr.mjs https://other/  (any URL up to 84 bytes)
 */

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const DEFAULT_URL = 'https://rpatino-cw.github.io/release-terminal/';

/* ------------------------------------------------------------------ */
/* Version table, error correction level M only.                       */
/* totalCodewords is asserted at runtime against the module count, so a */
/* typo in this table cannot silently ship.                            */
/* ------------------------------------------------------------------ */
const VERSIONS = {
  1: { totalCodewords: 26, ecPerBlock: 10, blocks: [16], align: [] },
  2: { totalCodewords: 44, ecPerBlock: 16, blocks: [28], align: [6, 18] },
  3: { totalCodewords: 70, ecPerBlock: 26, blocks: [44], align: [6, 22] },
  4: { totalCodewords: 100, ecPerBlock: 18, blocks: [32, 32], align: [6, 26] },
  5: { totalCodewords: 134, ecPerBlock: 24, blocks: [43, 43], align: [6, 30] }
};

/* ------------------------------------------------------------------ */
/* GF(256) arithmetic, primitive polynomial 0x11d.                     */
/* ------------------------------------------------------------------ */
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(function initGF() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}());

const gmul = (a, b) => (a === 0 || b === 0) ? 0 : EXP[LOG[a] + LOG[b]];

function generatorPoly(n) {
  let poly = [1];
  for (let i = 0; i < n; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= gmul(poly[j], 1);
      next[j + 1] ^= gmul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

function rsEncode(data, ecLen) {
  const gen = generatorPoly(ecLen);
  const res = new Array(ecLen).fill(0);
  for (let i = 0; i < data.length; i++) {
    const factor = data[i] ^ res[0];
    res.shift();
    res.push(0);
    if (factor !== 0) {
      for (let j = 0; j < ecLen; j++) res[j] ^= gmul(gen[j + 1], factor);
    }
  }
  return res;
}

/* Syndromes of a received block. All zero means the block is consistent. */
function syndromes(block, ecLen) {
  const out = [];
  for (let i = 0; i < ecLen; i++) {
    let s = 0;
    for (let j = 0; j < block.length; j++) s = gmul(s, EXP[i]) ^ block[j];
    out.push(s);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Bit stream                                                          */
/* ------------------------------------------------------------------ */
function makeBitBuffer() {
  const bits = [];
  return {
    bits,
    put(value, length) {
      for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
    }
  };
}

function encodeData(bytes, version) {
  const spec = VERSIONS[version];
  const dataCodewords = spec.blocks.reduce((a, b) => a + b, 0);
  const capacityBits = dataCodewords * 8;
  const buf = makeBitBuffer();
  buf.put(0b0100, 4);            // byte mode
  buf.put(bytes.length, 8);      // char count, 8 bits for versions 1 to 9
  for (const b of bytes) buf.put(b, 8);
  if (buf.bits.length > capacityBits) return null;

  const terminator = Math.min(4, capacityBits - buf.bits.length);
  buf.put(0, terminator);
  while (buf.bits.length % 8 !== 0) buf.bits.push(0);

  const codewords = [];
  for (let i = 0; i < buf.bits.length; i += 8) {
    let v = 0;
    for (let j = 0; j < 8; j++) v = (v << 1) | buf.bits[i + j];
    codewords.push(v);
  }
  const PAD = [0xec, 0x11];
  let p = 0;
  while (codewords.length < dataCodewords) codewords.push(PAD[p++ % 2]);
  return codewords;
}

function interleave(dataCodewords, version) {
  const spec = VERSIONS[version];
  const dataBlocks = [];
  const ecBlocks = [];
  let offset = 0;
  for (const size of spec.blocks) {
    const block = dataCodewords.slice(offset, offset + size);
    offset += size;
    dataBlocks.push(block);
    ecBlocks.push(rsEncode(block, spec.ecPerBlock));
  }
  const out = [];
  const maxData = Math.max(...spec.blocks);
  for (let i = 0; i < maxData; i++) {
    for (const b of dataBlocks) if (i < b.length) out.push(b[i]);
  }
  for (let i = 0; i < spec.ecPerBlock; i++) {
    for (const b of ecBlocks) out.push(b[i]);
  }
  return { stream: out, dataBlocks, ecBlocks };
}

/* ------------------------------------------------------------------ */
/* Matrix construction                                                 */
/* ------------------------------------------------------------------ */
function newGrid(size, fill) {
  return Array.from({ length: size }, () => new Array(size).fill(fill));
}

function buildFunctionPatterns(version) {
  const size = 17 + 4 * version;
  const m = newGrid(size, 0);
  const reserved = newGrid(size, false);

  const setF = (r, c, v) => { m[r][c] = v; reserved[r][c] = true; };

  // Finder patterns plus separators.
  const placeFinder = (top, left) => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const rr = top + r, cc = left + c;
        if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue;
        const onRing = (r >= 0 && r <= 6 && (c === 0 || c === 6)) ||
                       (c >= 0 && c <= 6 && (r === 0 || r === 6));
        const core = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        setF(rr, cc, (onRing || core) ? 1 : 0);
      }
    }
  };
  placeFinder(0, 0);
  placeFinder(0, size - 7);
  placeFinder(size - 7, 0);

  // Timing patterns.
  for (let i = 8; i < size - 8; i++) {
    const v = i % 2 === 0 ? 1 : 0;
    setF(6, i, v);
    setF(i, 6, v);
  }

  // Alignment patterns, skipping any that collide with a finder.
  const centers = VERSIONS[version].align;
  for (const r of centers) {
    for (const c of centers) {
      const nearFinder =
        (r < 8 && c < 8) || (r < 8 && c > size - 9) || (r > size - 9 && c < 8);
      if (nearFinder) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const ring = Math.max(Math.abs(dr), Math.abs(dc));
          setF(r + dr, c + dc, (ring === 1) ? 0 : 1);
        }
      }
    }
  }

  // Dark module.
  setF(4 * version + 9, 8, 1);

  // Reserve format information areas.
  for (let i = 0; i <= 8; i++) {
    if (!reserved[8][i]) { m[8][i] = 0; reserved[8][i] = true; }
    if (!reserved[i][8]) { m[i][8] = 0; reserved[i][8] = true; }
  }
  for (let i = 0; i < 8; i++) {
    if (!reserved[8][size - 1 - i]) { m[8][size - 1 - i] = 0; reserved[8][size - 1 - i] = true; }
    if (!reserved[size - 1 - i][8]) { m[size - 1 - i][8] = 0; reserved[size - 1 - i][8] = true; }
  }
  return { m, reserved, size };
}

/* The zigzag traversal, shared by writer and reader so the geometry can
   only be described once. Yields [row, col] in codeword bit order. */
function* dataPositions(size, reserved) {
  let upward = true;
  for (let right = size - 1; right >= 0; right -= 2) {
    if (right === 6) right = 5; // skip the vertical timing column
    for (let step = 0; step < size; step++) {
      const row = upward ? size - 1 - step : step;
      for (const col of [right, right - 1]) {
        if (col < 0) continue;
        if (!reserved[row][col]) yield [row, col];
      }
    }
    upward = !upward;
  }
}

const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r, c) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => ((((r * c) % 2) + ((r * c) % 3)) % 2) === 0,
  (r, c) => ((((r + c) % 2) + ((r * c) % 3)) % 2) === 0
];

/* Published format information strings for error correction level M,
   masks 0 through 7, bit 14 first. Used as a regression guard so an edit to
   the BCH code below cannot quietly ship a wrong format block. */
const FORMAT_M = [
  '101010000010010', '101000100100101', '101111001111100', '101101101001011',
  '100010111111001', '100000011001110', '100111110010111', '100101010100000'
];

function formatBits(maskIndex) {
  // Error correction level M is 0b00.
  const data = (0b00 << 3) | maskIndex;
  let rem = data << 10;
  for (let i = 4; i >= 0; i--) {
    if (rem & (1 << (i + 10))) rem ^= 0x537 << i;
  }
  return ((data << 10) | rem) ^ 0x5412;
}

/* Format information placement. Bit 14 is the most significant bit.
 * Copy 1 runs along row 8 from the left (bit 14 first, skipping the timing
 * column) and then up column 8. Copy 2 runs up column 8 from the bottom
 * (bits 14 down to 8) and along row 8 at the right (bits 7 down to 0).
 * This mapping was verified module for module against the CoreImage encoder. */
function placeFormat(m, size, maskIndex) {
  const fmt = formatBits(maskIndex);
  const bit = (i) => (fmt >> i) & 1;
  // Copy 1.
  for (let i = 0; i <= 5; i++) m[8][i] = bit(14 - i);
  m[8][7] = bit(8);
  m[8][8] = bit(7);
  m[7][8] = bit(6);
  for (let i = 0; i <= 5; i++) m[i][8] = bit(i);
  // Copy 2.
  for (let i = 0; i <= 6; i++) m[size - 1 - i][8] = bit(14 - i);
  for (let j = 0; j <= 7; j++) m[8][size - 8 + j] = bit(7 - j);
}

function readFormat(m, size, which) {
  let v = 0;
  const get = (r, c) => m[r][c] & 1;
  if (which === 0) {
    for (let i = 0; i <= 5; i++) v |= get(8, i) << (14 - i);
    v |= get(8, 7) << 8;
    v |= get(8, 8) << 7;
    v |= get(7, 8) << 6;
    for (let i = 0; i <= 5; i++) v |= get(i, 8) << i;
  } else {
    for (let i = 0; i <= 6; i++) v |= get(size - 1 - i, 8) << (14 - i);
    for (let j = 0; j <= 7; j++) v |= get(8, size - 8 + j) << (7 - j);
  }
  return v;
}

/* ------------------------------------------------------------------ */
/* Mask penalty scoring, rules 1 through 4.                            */
/* ------------------------------------------------------------------ */
function penalty(m, size) {
  let score = 0;

  const runScore = (line) => {
    let s = 0, run = 1;
    for (let i = 1; i < line.length; i++) {
      if (line[i] === line[i - 1]) {
        run++;
      } else {
        if (run >= 5) s += 3 + (run - 5);
        run = 1;
      }
    }
    if (run >= 5) s += 3 + (run - 5);
    return s;
  };

  for (let r = 0; r < size; r++) score += runScore(m[r]);
  for (let c = 0; c < size; c++) score += runScore(m.map(row => row[c]));

  // Rule 2: 2x2 blocks of one colour.
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = m[r][c];
      if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) score += 3;
    }
  }

  // Rule 3: finder-like 1011101 patterns with 4 light modules on a side.
  const A = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const B = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  const hasAt = (line, i, pat) => pat.every((v, k) => line[i + k] === v);
  const rule3 = (line) => {
    let s = 0;
    for (let i = 0; i + 11 <= line.length; i++) {
      if (hasAt(line, i, A) || hasAt(line, i, B)) s += 40;
    }
    return s;
  };
  for (let r = 0; r < size; r++) score += rule3(m[r]);
  for (let c = 0; c < size; c++) score += rule3(m.map(row => row[c]));

  // Rule 4: deviation from 50 percent dark.
  let dark = 0;
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) dark += m[r][c];
  const percent = (dark * 100) / (size * size);
  score += 10 * Math.floor(Math.abs(percent - 50) / 5);

  return score;
}

/* ------------------------------------------------------------------ */
/* Encode                                                              */
/* ------------------------------------------------------------------ */
function chooseVersion(byteLen) {
  for (const v of [1, 2, 3, 4, 5]) {
    const spec = VERSIONS[v];
    const dataBits = spec.blocks.reduce((a, b) => a + b, 0) * 8;
    if (4 + 8 + byteLen * 8 <= dataBits) return v;
  }
  return null;
}

function encode(text) {
  const bytes = Array.from(Buffer.from(text, 'utf8'));
  const version = chooseVersion(bytes.length);
  if (version === null) return { error: 'URL is longer than 84 bytes, which is past what this script supports.' };

  const spec = VERSIONS[version];
  const base = buildFunctionPatterns(version);

  // Consistency check: the module count must agree with the codeword table.
  let free = 0;
  for (let r = 0; r < base.size; r++) {
    for (let c = 0; c < base.size; c++) if (!base.reserved[r][c]) free++;
  }
  if (Math.floor(free / 8) !== spec.totalCodewords) {
    return { error: 'internal: version ' + version + ' free modules ' + free +
      ' implies ' + Math.floor(free / 8) + ' codewords, table says ' + spec.totalCodewords };
  }

  const dataCodewords = encodeData(bytes, version);
  if (!dataCodewords) return { error: 'internal: data did not fit the chosen version' };
  const { stream } = interleave(dataCodewords, version);
  if (stream.length !== spec.totalCodewords) {
    return { error: 'internal: interleaved stream length ' + stream.length + ' expected ' + spec.totalCodewords };
  }

  // Lay the bits down once, unmasked.
  const bitsOut = [];
  for (const cw of stream) for (let i = 7; i >= 0; i--) bitsOut.push((cw >> i) & 1);
  const raw = base.m.map(row => row.slice());
  let idx = 0;
  for (const [r, c] of dataPositions(base.size, base.reserved)) {
    raw[r][c] = idx < bitsOut.length ? bitsOut[idx] : 0;
    idx++;
  }

  // Evaluate every mask, keep the cheapest.
  let best = null;
  for (let maskIndex = 0; maskIndex < 8; maskIndex++) {
    const m = raw.map(row => row.slice());
    for (let r = 0; r < base.size; r++) {
      for (let c = 0; c < base.size; c++) {
        if (!base.reserved[r][c] && MASKS[maskIndex](r, c)) m[r][c] ^= 1;
      }
    }
    placeFormat(m, base.size, maskIndex);
    const p = penalty(m, base.size);
    if (best === null || p < best.penalty) best = { m, maskIndex, penalty: p };
  }

  return { matrix: best.m, size: base.size, version, maskIndex: best.maskIndex, penalty: best.penalty, bytes };
}

/* ------------------------------------------------------------------ */
/* Self check: decode the finished matrix with an independent read path */
/* ------------------------------------------------------------------ */
function selfCheck(matrix, size, expectedText) {
  const problems = [];
  const version = (size - 17) / 4;
  const spec = VERSIONS[version];

  // Format information, both copies, BCH verified.
  const f0 = readFormat(matrix, size, 0);
  const f1 = readFormat(matrix, size, 1);
  if (f0 !== f1) problems.push('the two format information copies disagree');
  const unmasked = f0 ^ 0x5412;
  let rem = unmasked;
  for (let i = 4; i >= 0; i--) {
    if (rem & (1 << (i + 10))) rem ^= 0x537 << i;
  }
  if (rem !== 0) problems.push('format information fails its BCH check');
  const ecLevelBits = (unmasked >> 13) & 0b11;
  const maskIndex = (unmasked >> 10) & 0b111;
  if (ecLevelBits !== 0b00) problems.push('format information does not say error correction level M');
  if (f0.toString(2).padStart(15, '0') !== FORMAT_M[maskIndex]) {
    problems.push('format information does not match the published level M table');
  }

  // Structural spot checks.
  const finderOk = (top, left) =>
    matrix[top + 3][left + 3] === 1 && matrix[top][left] === 1 &&
    matrix[top + 1][left + 1] === 0 && matrix[top + 2][left + 2] === 1;
  if (!finderOk(0, 0) || !finderOk(0, size - 7) || !finderOk(size - 7, 0)) problems.push('a finder pattern is malformed');
  for (let i = 8; i < size - 8; i++) {
    if (matrix[6][i] !== (i % 2 === 0 ? 1 : 0)) { problems.push('horizontal timing pattern is wrong'); break; }
  }
  for (let i = 8; i < size - 8; i++) {
    if (matrix[i][6] !== (i % 2 === 0 ? 1 : 0)) { problems.push('vertical timing pattern is wrong'); break; }
  }
  if (matrix[4 * version + 9][8] !== 1) problems.push('dark module missing');

  // Rebuild the reservation map from scratch, unmask, read the stream back.
  const fresh = buildFunctionPatterns(version);
  const unmaskedGrid = matrix.map(row => row.slice());
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (!fresh.reserved[r][c] && MASKS[maskIndex](r, c)) unmaskedGrid[r][c] ^= 1;
    }
  }
  const bits = [];
  for (const [r, c] of dataPositions(size, fresh.reserved)) bits.push(unmaskedGrid[r][c]);
  const stream = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    let v = 0;
    for (let j = 0; j < 8; j++) v = (v << 1) | bits[i + j];
    stream.push(v);
  }
  if (stream.length < spec.totalCodewords) problems.push('not enough codewords recovered from the matrix');

  // De-interleave.
  const nBlocks = spec.blocks.length;
  const dataBlocks = spec.blocks.map(() => []);
  const ecBlocks = spec.blocks.map(() => []);
  let pos = 0;
  const maxData = Math.max(...spec.blocks);
  for (let i = 0; i < maxData; i++) {
    for (let b = 0; b < nBlocks; b++) if (i < spec.blocks[b]) dataBlocks[b].push(stream[pos++]);
  }
  for (let i = 0; i < spec.ecPerBlock; i++) {
    for (let b = 0; b < nBlocks; b++) ecBlocks[b].push(stream[pos++]);
  }

  // Reed Solomon syndromes must all be zero.
  for (let b = 0; b < nBlocks; b++) {
    const s = syndromes(dataBlocks[b].concat(ecBlocks[b]), spec.ecPerBlock);
    if (s.some(v => v !== 0)) problems.push('block ' + (b + 1) + ' fails its Reed Solomon syndrome check');
  }

  // Parse the payload.
  const flat = [];
  for (const b of dataBlocks) flat.push(...b);
  const bitsOfFlat = [];
  for (const cw of flat) for (let i = 7; i >= 0; i--) bitsOfFlat.push((cw >> i) & 1);
  const take = (n, at) => {
    let v = 0;
    for (let i = 0; i < n; i++) v = (v << 1) | bitsOfFlat[at + i];
    return v;
  };
  const mode = take(4, 0);
  if (mode !== 0b0100) problems.push('recovered mode indicator is not byte mode');
  const count = take(8, 4);
  const outBytes = [];
  for (let i = 0; i < count; i++) outBytes.push(take(8, 12 + i * 8));
  const decoded = Buffer.from(outBytes).toString('utf8');
  if (decoded !== expectedText) {
    problems.push('round trip mismatch, recovered ' + JSON.stringify(decoded));
  }

  return { ok: problems.length === 0, problems, decoded, maskIndex };
}

/* ------------------------------------------------------------------ */
/* SVG                                                                 */
/* ------------------------------------------------------------------ */
function toSvg(matrix, size, url) {
  const MODULE = 8;
  const QUIET = 4;
  const dim = (size + QUIET * 2) * MODULE;
  const rects = [];
  for (let r = 0; r < size; r++) {
    let c = 0;
    while (c < size) {
      if (matrix[r][c] === 1) {
        let run = 1;
        while (c + run < size && matrix[r][c + run] === 1) run++;
        rects.push('<rect x="' + ((c + QUIET) * MODULE) + '" y="' + ((r + QUIET) * MODULE) +
          '" width="' + (run * MODULE) + '" height="' + MODULE + '"/>');
        c += run;
      } else {
        c++;
      }
    }
  }
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<svg xmlns="http://www.w3.org/2000/svg" width="' + dim + '" height="' + dim +
      '" viewBox="0 0 ' + dim + ' ' + dim + '" shape-rendering="crispEdges">',
    '<title>ASSET RELEASE TERMINAL</title>',
    '<desc>' + url.replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</desc>',
    '<rect width="' + dim + '" height="' + dim + '" fill="#ffffff"/>',
    '<g fill="#000000">',
    rects.join(''),
    '</g>',
    '</svg>',
    ''
  ].join('\n');
}

function asciiPreview(matrix, size) {
  const lines = [];
  const q = '  ';
  lines.push(q.repeat(size + 4));
  lines.push(q.repeat(size + 4));
  for (let r = 0; r < size; r++) {
    let s = q + q;
    for (let c = 0; c < size; c++) s += matrix[r][c] ? '██' : q;
    lines.push(s + q + q);
  }
  lines.push(q.repeat(size + 4));
  lines.push(q.repeat(size + 4));
  return lines.join('\n');
}

/* ------------------------------------------------------------------ */
function refuse(url, reason) {
  console.log('');
  console.log('QR GENERATION REFUSED.');
  console.log('Reason: ' + reason);
  console.log('');
  console.log('No qr.svg was written. A QR code that fails to scan is worse on a');
  console.log('physical sticker than no QR code at all, so this script stops here.');
  console.log('');
  console.log('Do this instead. Paste this exact string into any offline QR generator');
  console.log('and print the result at 25mm or larger:');
  console.log('');
  console.log('  ' + url);
  console.log('');
  console.log('Offline options that need no install:');
  console.log('  1. macOS Shortcuts, the "Generate QR Code" action, input set to Text.');
  console.log('  2. Chrome, open the page, click the address bar, then the QR icon.');
  console.log('  3. Any generator you trust. Set error correction to M or higher.');
  console.log('');
  console.log('Then scan the printed sticker with the actual phone camera before');
  console.log('anything gets zip tied to anything.');
  console.log('');
}

function main() {
  const url = process.argv[2] || DEFAULT_URL;

  console.log('ASSET RELEASE TERMINAL, QR builder');
  console.log('URL: ' + url);
  console.log('Bytes: ' + Buffer.byteLength(url, 'utf8'));

  const res = encode(url);
  if (res.error) {
    refuse(url, res.error);
    process.exitCode = 1;
    return;
  }

  const check = selfCheck(res.matrix, res.size, url);
  console.log('Version: ' + res.version + ' (' + res.size + 'x' + res.size + ' modules), EC level M');
  console.log('Mask: ' + res.maskIndex + ' (penalty ' + res.penalty + ', lowest of all 8)');
  console.log('Self check: ' + (check.ok ? 'PASS' : 'FAIL'));

  if (!check.ok) {
    refuse(url, 'self check failed: ' + check.problems.join('; '));
    process.exitCode = 1;
    return;
  }

  console.log('  format information BCH: ok');
  console.log('  finder, timing, dark module: ok');
  console.log('  Reed Solomon syndromes: all zero');
  console.log('  round trip decode: ' + JSON.stringify(check.decoded));

  const here = path.dirname(fileURLToPath(import.meta.url));
  const out = path.join(here, '..', 'qr.svg');
  writeFileSync(out, toSvg(res.matrix, res.size, url));

  console.log('');
  console.log(asciiPreview(res.matrix, res.size));
  console.log('');
  console.log('Wrote: ' + out);
  console.log('Print at 25mm or larger. Scan it with a real phone before it goes on the lockbox.');
  console.log(url);
}

main();
