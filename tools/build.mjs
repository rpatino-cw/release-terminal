#!/usr/bin/env node
/*
 * build.mjs - compiles puzzles.src.json (plaintext, gitignored) into puzzles.js
 * (hashes + ciphertext only, safe to commit and to serve publicly).
 *
 * Usage:
 *   node tools/build.mjs                    (reads ./puzzles.src.json)
 *   node tools/build.mjs tools/fixture.example.json
 *
 * Node built-ins only. No dependencies.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes, pbkdf2Sync, createCipheriv } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

const GATE_COUNT = 5;   /* gated stages in the array. The reveal is generated. */
const DIGIT_COUNT = 4;  /* stages that carry a digit. The last stage carries none. */

const PBKDF2_ITERS = 150000;
const KEY_LEN = 32;
const SALT_LEN = 16;
const IV_LEN = 12;
const MAX_REBUILDS = 12;

const DEFAULT_TAUNT =
  'The lock was never the hard part. Enjoy the walk to the parking lot.';

/* This function must behave identically to normalize() in app.js. */
function normalize(s) {
  return String(s == null ? '' : s)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function die(msg) {
  console.error('\nBUILD FAILED: ' + msg + '\n');
  process.exit(1);
}

function sha256Hex(str) {
  return createHash('sha256').update(str, 'utf8').digest('hex');
}

function encrypt(obj, keyMaterial, saltBuf) {
  const key = pbkdf2Sync(keyMaterial, saltBuf, PBKDF2_ITERS, KEY_LEN, 'sha256');
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([
    cipher.update(JSON.stringify(obj), 'utf8'),
    cipher.final()
  ]);
  const tag = cipher.getAuthTag(); /* 16 bytes, appended so Web Crypto can verify */
  return {
    payload: Buffer.concat([body, tag]).toString('base64'),
    iv: iv.toString('base64')
  };
}

/* ------------------------------------------------------------------ load */

const srcArg = process.argv[2];
const SRC = srcArg ? resolve(process.cwd(), srcArg) : resolve(ROOT, 'puzzles.src.json');
const OUT = resolve(ROOT, 'puzzles.js');
const COMBO_FILE = resolve(ROOT, 'COMBO.txt');

if (!existsSync(SRC)) {
  die(
    'source file not found: ' + SRC +
    '\n  Agent B owns puzzles.src.json. To test the compiler alone, run:' +
    '\n    node tools/build.mjs tools/fixture.example.json'
  );
}

let src;
try {
  src = JSON.parse(readFileSync(SRC, 'utf8'));
} catch (err) {
  die('could not parse ' + SRC + ' as JSON: ' + err.message);
}

/* -------------------------------------------------------------- validate */

if (!src || typeof src !== 'object') die('source root must be a JSON object.');

const combo = String(src.combo == null ? '' : src.combo);
const stages = src.stages;

if (!Array.isArray(stages)) die('"stages" must be an array.');
if (stages.length !== GATE_COUNT) {
  die(
    'expected exactly ' + GATE_COUNT + ' gated stages, found ' + stages.length +
    '. Four carry a digit, the last is the gate-only human authorization stage. The reveal is generated and is not in the array.'
  );
}
if (combo.length !== 4) {
  die('"combo" must be exactly 4 characters, found ' + combo.length + ' ("' + combo + '").');
}
if (!/^[0-9]{4}$/.test(combo)) {
  die('"combo" must be 4 digits 0-9, found "' + combo + '".');
}

stages.forEach(function (st, i) {
  const n = i + 1;
  if (!st || typeof st !== 'object') die('stage ' + n + ' is not an object.');
  if (!Array.isArray(st.answers) || st.answers.length === 0) {
    die('stage ' + n + ' needs a non-empty "answers" array. answers[0] is canonical.');
  }
  st.answers.forEach(function (a, j) {
    if (typeof a !== 'string' || normalize(a).length === 0) {
      die('stage ' + n + ' answers[' + j + '] normalizes to an empty string. Use letters or digits.');
    }
  });
  if (typeof st.prompt !== 'string' || st.prompt.length === 0) {
    die('stage ' + n + ' needs a "prompt" string (trusted HTML).');
  }
  if (st.digit !== null && (typeof st.digit !== 'string' || !/^[0-9]$/.test(st.digit))) {
    die(
      'stage ' + n + ' "digit" must be a single character 0-9, or null for a gate-only stage. Found ' +
      JSON.stringify(st.digit) + '.'
    );
  }
  if (!Array.isArray(st.hints) || st.hints.length === 0) {
    die('stage ' + n + ' needs a non-empty "hints" array.');
  }
  if (st.hints.length !== 3) {
    console.warn('  warn: stage ' + n + ' has ' + st.hints.length + ' hints, the UI expects 3.');
  }
});

/* Exactly 4 digit carrying stages, exactly 1 gate-only stage, and it must be last. */
const nullAt = [];
stages.forEach(function (st, i) { if (st.digit === null) nullAt.push(i + 1); });

if (nullAt.length !== 1) {
  die(
    'expected exactly 1 gate-only stage (digit: null), found ' + nullAt.length +
    (nullAt.length ? ' at stage(s) ' + nullAt.join(', ') : '') + '.'
  );
}
/*
 * The gate-only stage may sit anywhere in the run. It must not be last, because
 * the final stage's answer is the key that unwraps the reveal payload, and the
 * run should end on a digit stage rather than on a human authorization step.
 */
if (nullAt[0] === GATE_COUNT) {
  die(
    'the gate-only stage (digit: null) must not be the last stage. Move it earlier ' +
    'so the run ends on a digit stage.'
  );
}

const digitStages = stages.filter(function (st) { return st.digit !== null; });
if (digitStages.length !== DIGIT_COUNT) {
  die('expected exactly ' + DIGIT_COUNT + ' stages carrying a digit, found ' + digitStages.length + '.');
}

const assembled = digitStages.map(function (s) { return s.digit; }).join('');
if (assembled !== combo) {
  die(
    'combo mismatch. "combo" is "' + combo + '" but the ' + DIGIT_COUNT +
    ' non-null stage digits concatenate to "' + assembled + '". They must be identical.'
  );
}

const taunt =
  (typeof src.taunt === 'string' && src.taunt) ||
  (src.final && typeof src.final.taunt === 'string' && src.final.taunt) ||
  DEFAULT_TAUNT;

/* -------------------------------------------------------- needle set-up */

/*
 * Every plaintext string that must never survive into puzzles.js.
 *
 * Strict needles (4 characters or more) are a hard gate: a hit means real
 * plaintext leaked. Short needles cannot be gated, because a 2 or 3 character
 * string turns up inside random base64 and hex by pure chance on most builds,
 * so a hit there proves nothing. Those are reported, not enforced, and the
 * stage that produced one gets a loud warning of its own.
 */
const STRICT_MIN = 4;
const needles = [];
const shortNeedles = [];
function addNeedle(s, always) {
  if (typeof s !== 'string' || !s.length) return;
  const variants = [s, s.toLowerCase(), normalize(s)];
  variants.forEach(function (v) {
    if (!v.length) return;
    if (v.length < STRICT_MIN) {
      if (always && shortNeedles.indexOf(v) === -1) shortNeedles.push(v);
      return;
    }
    if (!always && v.length < 8) return;
    if (needles.indexOf(v) === -1) needles.push(v);
  });
}
addNeedle(combo, true);
stages.forEach(function (st, i) {
  st.answers.forEach(function (a) { addNeedle(a, true); });
  addNeedle(st.prompt, false);
  addNeedle(st.placeholder, false);
  (st.hints || []).forEach(function (h) { addNeedle(h, false); });

  const shortest = st.answers.reduce(function (m, a) {
    return Math.min(m, normalize(a).length);
  }, Infinity);
  if (shortest < STRICT_MIN) {
    console.warn(
      '  WARN: stage ' + (i + 1) + ' accepts an answer only ' + shortest +
      ' character(s) long after normalize().\n' +
      '        Two problems. The output self-check cannot verify a string that short,\n' +
      '        and the hash gate for it is brute forceable in well under a second.\n' +
      '        Make answers[0] at least ' + STRICT_MIN + ' characters, or add a longer alias.'
    );
  }
});
addNeedle(taunt, false);

/* ------------------------------------------------------------ build loop */

function buildOnce() {
  const saltBuf = randomBytes(SALT_LEN);
  const saltB64 = saltBuf.toString('base64');

  const outStages = stages.map(function (st, i) {
    const keyMaterial = i === 0 ? 'boot' : normalize(stages[i - 1].answers[0]);
    const enc = encrypt(
      {
        label: typeof st.label === 'string' ? st.label : 'STAGE ' + (i + 1),
        prompt: st.prompt,
        placeholder: typeof st.placeholder === 'string' ? st.placeholder : 'answer',
        digit: st.digit,
        hints: st.hints
      },
      keyMaterial,
      saltBuf
    );
    /*
     * Alias unwrap blobs, one per accepted answer, parallel to hashes[].
     *
     * The next stage is always keyed off the CANONICAL answer, but the player
     * may type any accepted alias. So entry j holds the canonical answer
     * encrypted under a key derived from alias j. Supplying a correct alias is
     * the only way to open the matching blob and recover the chaining key.
     * Nothing here is readable without already having answered correctly.
     */
    const canon = normalize(st.answers[0]);
    const keys = st.answers.map(function (a) {
      return encrypt({ c: canon }, normalize(a), saltBuf);
    });

    return {
      id: typeof st.id === 'number' ? st.id : i + 1,
      hashes: st.answers.map(function (a) { return sha256Hex(saltB64 + normalize(a)); }),
      keys: keys,
      payload: enc.payload,
      iv: enc.iv
    };
  });

  /* The reveal is keyed off the LAST gated stage. */
  const finalEnc = encrypt(
    { combo: combo, taunt: taunt },
    normalize(stages[GATE_COUNT - 1].answers[0]),
    saltBuf
  );

  const body = {
    salt: saltB64,
    stages: outStages,
    finalPayload: finalEnc.payload,
    finalIv: finalEnc.iv
  };

  /*
   * The boot-screen profile card. Keyed off the literal 'boot' like stage 1, so
   * it renders for anyone who opens the page. It is encrypted anyway so that a
   * crawler fetching this file sees base64 rather than a named person, a job
   * title, a city, and a face.
   */
  if (src.profile) {
    const profEnc = encrypt(src.profile, 'boot', saltBuf);
    body.bootPayload = profEnc.payload;
    body.bootIv = profEnc.iv;
  }

  const text =
    '/* GENERATED FILE. Do not edit by hand.\n' +
    '   Built by tools/build.mjs from a gitignored source file.\n' +
    '   Contains only salted hashes and AES-256-GCM ciphertext. */\n' +
    'window.PUZZLES = ' + JSON.stringify(body, null, 2) + ';\n';

  return text;
}

let emitted = '';
let rebuilds = 0;
let lastHit = null;

for (;;) {
  emitted = buildOnce();
  lastHit = null;
  for (let i = 0; i < needles.length; i++) {
    if (emitted.indexOf(needles[i]) !== -1) { lastHit = needles[i]; break; }
  }
  if (!lastHit) break;
  rebuilds++;
  if (rebuilds > MAX_REBUILDS) {
    die(
      'self-check tripped ' + rebuilds + ' times on the string ' + JSON.stringify(lastHit) +
      '.\n  A short secret can collide with random base64 by chance, but repeated hits mean' +
      '\n  real plaintext is leaking into the output. Nothing was written.'
    );
  }
}

/* ----------------------------------------------------------------- write */

writeFileSync(OUT, emitted, 'utf8');
writeFileSync(
  COMBO_FILE,
  combo + '\n' +
  'Set the physical lockbox on the pack to this combo before you hand it over. Never commit this file.\n',
  'utf8'
);

const bytes = Buffer.byteLength(emitted, 'utf8');
console.log('');
console.log('BUILD OK');
console.log('  source        : ' + relative(ROOT, SRC));
console.log('  stages        : ' + stages.length + ' gated (' + DIGIT_COUNT + ' with a digit, 1 gate-only at stage ' + GATE_COUNT + ')');
console.log('  combo length  : ' + combo.length);
console.log('  salt          : ' + SALT_LEN + ' bytes (' + Buffer.from(emitted.match(/"salt": "([^"]+)"/)[1], 'base64').length + ' decoded, base64 in output)');
console.log('  pbkdf2        : ' + PBKDF2_ITERS + ' iterations, sha256, 32 byte key');
console.log('  output bytes  : ' + bytes);
console.log('  self-check    : no plaintext in output (' + needles.length + ' needles checked, ' + rebuilds + ' rebuild' + (rebuilds === 1 ? '' : 's') + ' for chance collisions)');
if (shortNeedles.length) {
  console.log('  self-check    : ' + shortNeedles.length + ' secret(s) under ' + STRICT_MIN + ' chars were NOT gated (see WARN above)');
}
console.log('  wrote         : puzzles.js');
console.log('  wrote         : COMBO.txt (gitignored, set the lockbox to it)');
console.log('');
