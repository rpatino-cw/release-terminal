/*
 * app.js - ASSET RELEASE TERMINAL stage machine.
 * Vanilla, no modules. Loaded after puzzles.js and mastermind.js.
 *
 * Nothing in this file knows an answer, a hint, or a digit. Everything is
 * decrypted from window.PUZZLES at the moment it is earned.
 */
(function () {
  'use strict';

  /* --------------------------------------------------------------- config */

  var STORAGE_KEY = 'art.state.v1';
  var STATE_VERSION = 1;
  var HINT_DELAY_MS = 10 * 60 * 1000; /* 10 minutes on the current stage */
  var PBKDF2_ITERS = 150000;
  var GATE_COUNT = 5;        /* gated stages: 1..5 */
  var DIGIT_SLOTS = 4;       /* rail slots. Stage 5 is gate-only and adds none. */
  var MASTERMIND_STAGE = 5;  /* the widget mounts here and nowhere else */
  var MUTE_KEY = 'release-terminal-muted';

  /*
   * Audio is optional and must never be load bearing. If audio.js is missing or
   * the browser refuses to give us a context, every call here is a no-op and the
   * puzzle behaves exactly as it did before.
   */
  function sfx(name) {
    if (window.SOUND && typeof window.SOUND.sfx === 'function') window.SOUND.sfx(name);
  }
  var REVEAL_STAGE = GATE_COUNT + 1;
  var RESET_TAPS = 5;
  var RESET_WINDOW_MS = 3000;

  /*
   * Romeo's own number. The site never reveals the combo. MERCY just opens a
   * text message so the player has to ask a human out loud.
   */
  var MERCY_SMS = 'sms:+18477759993&body=I%20give%20up%2C%20Romeo.';

  var REJECTIONS = [
    'REJECTED.',
    'NO MATCH.',
    'DENIED.',
    'NOT IT.',
    'INVALID TOKEN.',
    'CUSTODY HOLD MAINTAINED.'
  ];

  var BOOT_LINES = [
    'ASSET RELEASE TERMINAL v2.7',
    'POST ................ OK',
    'CUSTODY LEDGER ...... MOUNTED',
    'KEY BOX ............. SEALED',
    'KEY VAULT ........... SEALED (4 DIGIT)',
    'OPERATOR CLEARANCE .. NONE',
    '',
    'ASSET: ONE (1) KEY BOX, HELD UNDER CUSTODY.',
    'SUBJECT: YOU.',
    '',
    'RELEASE REQUIRES A 4 DIGIT CODE.',
    'FOUR STAGES YIELD ONE DIGIT EACH.',
    'TWO GATES REQUIRE ANOTHER HUMAN.',
    'NO SHORTCUTS. NO OVERRIDE.',
    ''
  ];

  /* ------------------------------------------------------------ utilities */

  /* Must behave identically to normalize() in tools/build.mjs. */
  function normalize(s) {
    return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  function $(id) { return document.getElementById(id); }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function reducedMotion() {
    return window.matchMedia &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function bytesFromB64(b64) {
    var bin = window.atob(b64);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function hex(buf) {
    var v = new Uint8Array(buf);
    var s = '';
    for (var i = 0; i < v.length; i++) s += (v[i] < 16 ? '0' : '') + v[i].toString(16);
    return s;
  }

  function utf8(s) { return new TextEncoder().encode(s); }

  /* --------------------------------------------------------------- crypto */

  var P = window.PUZZLES;
  var SALT_BYTES = null;

  function sha256Hex(str) {
    return crypto.subtle.digest('SHA-256', utf8(str)).then(hex);
  }

  function deriveKey(keyMaterial, iters) {
    return crypto.subtle
      .importKey('raw', utf8(keyMaterial), 'PBKDF2', false, ['deriveKey'])
      .then(function (base) {
        return crypto.subtle.deriveKey(
          {
            name: 'PBKDF2',
            salt: SALT_BYTES,
            iterations: iters || PBKDF2_ITERS,
            hash: 'SHA-256'
          },
          base,
          { name: 'AES-GCM', length: 256 },
          false,
          ['decrypt']
        );
      });
  }

  /* payload is base64(ciphertext || 16 byte auth tag), which is exactly the
     layout AES-GCM in Web Crypto expects. */
  function decryptPayload(payloadB64, ivB64, keyMaterial, iters) {
    return deriveKey(keyMaterial, iters).then(function (key) {
      return crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: bytesFromB64(ivB64), tagLength: 128 },
        key,
        bytesFromB64(payloadB64)
      );
    }).then(function (plain) {
      return JSON.parse(new TextDecoder().decode(plain));
    });
  }

  /* ---------------------------------------------------------------- state */

  var S = freshState();
  var payloads = {};   /* stage number -> decrypted payload object */
  var hintTimer = null;
  var rejectIndex = 0;

  function freshState() {
    return {
      v: STATE_VERSION,
      booted: false,
      stage: 0,              /* 0 boot, 1..5 gated stages, 6 reveal */
      answers: [],           /* normalized accepted answers, index 0 = stage 1 */
      t0: 0,                 /* first load */
      stageAt: {},           /* stage number -> arrival timestamp */
      attempts: {},          /* stage number -> wrong attempt count */
      hints: {}              /* stage number -> hints revealed */
    };
  }

  function loadState() {
    var raw;
    try {
      raw = window.localStorage.getItem(STORAGE_KEY);
    } catch (e) {
      return freshState();
    }
    if (!raw) return freshState();
    try {
      var o = JSON.parse(raw);
      if (!o || typeof o !== 'object') return freshState();
      if (o.v !== STATE_VERSION) return freshState();
      if (typeof o.stage !== 'number' || o.stage < 0 || o.stage > REVEAL_STAGE) return freshState();
      if (!Array.isArray(o.answers)) return freshState();
      for (var i = 0; i < o.answers.length; i++) {
        if (typeof o.answers[i] !== 'string') return freshState();
      }
      if (o.answers.length < Math.min(o.stage, REVEAL_STAGE) - 1) return freshState();
      var s = freshState();
      s.booted = !!o.booted;
      s.stage = o.stage;
      s.answers = o.answers.slice(0, GATE_COUNT);
      s.t0 = typeof o.t0 === 'number' ? o.t0 : 0;
      s.stageAt = (o.stageAt && typeof o.stageAt === 'object') ? o.stageAt : {};
      s.attempts = (o.attempts && typeof o.attempts === 'object') ? o.attempts : {};
      s.hints = (o.hints && typeof o.hints === 'object') ? o.hints : {};
      return s;
    } catch (e) {
      return freshState();
    }
  }

  function saveState() {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(S));
    } catch (e) { /* private mode or full quota. The run still works in memory. */ }
  }

  function clearState() {
    try { window.localStorage.removeItem(STORAGE_KEY); } catch (e) {}
  }

  /* --------------------------------------------------------------- chrome */

  function setSysline(txt) {
    var n = $('sysline');
    if (n) n.textContent = txt;
  }

  function earnedDigits() {
    /*
     * A digit is earned when its stage is SOLVED, not when it is shown.
     * Gate-only stages carry digit null and contribute nothing to the rail.
     */
    var solved = Math.max(0, Math.min(S.stage - 1, GATE_COUNT));
    var out = [];
    for (var i = 1; i <= solved; i++) {
      if (!payloads[i]) { out.push('#'); continue; }
      if (payloads[i].digit == null) continue; /* gate-only stage, no slot */
      out.push(payloads[i].digit);
    }
    return out.slice(0, DIGIT_SLOTS);
  }

  function renderRail() {
    var rail = $('rail');
    if (!rail) return;
    var digits = earnedDigits();
    /*
     * On the gate-only stage every digit is already earned, so a plain full rail
     * would read as "finished" while a stage is still outstanding. Hold the
     * display instead: assembled, not released.
     */
    var withheld = (S.stage === GATE_COUNT) && digits.length === DIGIT_SLOTS;
    rail.className = 'rail' + (withheld ? ' withheld' : '');
    rail.innerHTML = '';
    for (var i = 0; i < DIGIT_SLOTS; i++) {
      var got = digits[i] != null;
      var slot;
      if (withheld) {
        slot = el('span', 'slot filled held', '*');
        slot.setAttribute('aria-label', 'digit ' + (i + 1) + ' assembled, display withheld');
      } else {
        slot = el('span', 'slot' + (got ? ' filled' : ''), got ? digits[i] : '#');
        slot.setAttribute('aria-label', 'digit ' + (i + 1) + (got ? ' recovered' : ' locked'));
      }
      rail.appendChild(slot);
    }
    var caption = $('railnote');
    if (caption) {
      caption.textContent = withheld ? 'COMBINATION ASSEMBLED. RELEASE PENDING AUTHORIZATION.' : '';
      caption.hidden = !withheld;
    }
  }

  function view() { return $('view'); }

  function showFatal(title, body) {
    stopHintTimer();
    var v = view();
    v.innerHTML = '';
    var box = el('section', 'panel fatal');
    box.appendChild(el('h2', 'panel-title', title));
    box.appendChild(el('p', 'panel-body', body));
    v.appendChild(box);
  }

  /* ----------------------------------------------------------------- boot */

  function runBoot() {
    return new Promise(function (resolve) {
      var v = view();
      v.innerHTML = '';
      var pre = el('pre', 'boot');
      var cta = el('button', 'btn wide cta', 'TAP TO BEGIN');
      cta.hidden = true;
      v.appendChild(pre);
      v.appendChild(cta);

      var done = false;
      var i = 0;
      var timer = null;
      var fast = reducedMotion();

      var card = el('div', 'profile');
      card.hidden = true;
      v.insertBefore(card, cta);

      /*
       * The profile card ships encrypted under the same literal 'boot' key as
       * stage 1, so it renders for every visitor. The encryption is not a puzzle
       * gate, it is there so a crawler fetching puzzles.js gets base64 instead of
       * a real person's name, job title, city, and portrait.
       */
      function showProfile() {
        if (!P.bootPayload || !P.bootIv || card.dataset.done) return;
        card.dataset.done = '1';
        decryptPayload(P.bootPayload, P.bootIv, 'boot').then(function (p) {
          card.innerHTML = '';
          card.appendChild(el('div', 'profile-tag', 'PERSONNEL RECORD // ARCHIVO DE PERSONAL'));
          var art = el('pre', 'portrait', p.ascii || '');
          art.setAttribute('aria-label', 'ASCII portrait of ' + (p.name || 'the subject'));
          card.appendChild(art);
          card.appendChild(el('div', 'profile-name', p.name || ''));
          card.appendChild(el('div', 'profile-title', p.title || ''));
          card.appendChild(el('div', 'profile-origin', p.origin || ''));
          if (p.lines && p.lines.length) {
            var f = el('pre', 'profile-lines', p.lines.join('\n'));
            card.appendChild(f);
          }
          if (p.footer) card.appendChild(el('div', 'profile-footer', p.footer));
          card.hidden = false;
        }).catch(function (err) {
          console.warn('profile card unavailable', err);
        });
      }

      function finishPrinting() {
        if (timer) { clearTimeout(timer); timer = null; }
        pre.textContent = BOOT_LINES.join('\n');
        showProfile();
        cta.hidden = false;
      }

      function step() {
        if (i >= BOOT_LINES.length) { finishPrinting(); return; }
        pre.textContent += (i ? '\n' : '') + BOOT_LINES[i];
        i++;
        timer = setTimeout(step, 90);
      }

      function skipOrBegin(ev) {
        if (done || adminOpen) return;
        if (ev && ev.target && ev.target.id === 'mercy') return;
        if (ev && ev.target && (ev.target.id === 'mute' || ev.target.id === 'adminbtn')) return;
        if (cta.hidden) { finishPrinting(); return; }
        done = true;
        document.removeEventListener('click', skipOrBegin, true);
        /* This is the real user gesture, so it is the only place audio can start. */
        if (window.SOUND && !window.SOUND.isMuted()) window.SOUND.unlock();
        resolve();
      }

      document.addEventListener('click', skipOrBegin, true);

      if (fast) finishPrinting();
      else step();
    });
  }

  /* --------------------------------------------------------------- stages */

  function stageData(n) { return P.stages[n - 1]; }

  function keyMaterialFor(n) {
    return n === 1 ? 'boot' : S.answers[n - 2];
  }

  function ensurePayload(n) {
    if (payloads[n]) return Promise.resolve(payloads[n]);
    var st = stageData(n);
    var km = keyMaterialFor(n);
    if (km == null) return Promise.reject(new Error('missing key material for stage ' + n));
    return decryptPayload(st.payload, st.iv, km).then(function (obj) {
      payloads[n] = obj;
      return obj;
    });
  }

  function showWorking(msg) {
    var v = view();
    v.innerHTML = '';
    var box = el('section', 'panel');
    box.appendChild(el('p', 'panel-body blink', msg));
    v.appendChild(box);
  }

  function goStage(n) {
    S.stage = n;
    if (!S.t0) S.t0 = Date.now();
    if (!S.stageAt[n]) S.stageAt[n] = Date.now();
    saveState();
    renderRail();
    if (n === REVEAL_STAGE) return renderReveal();
    showWorking('DECRYPTING STAGE ' + n + ' ...');
    return ensurePayload(n).then(function (pl) {
      renderStage(n, pl);
    }).catch(function (err) {
      console.error('stage decrypt failed', err);
      hardReset('SESSION KEY MISMATCH. THE PUZZLE FILE CHANGED. RESTARTING RUN.');
    });
  }

  /*
   * The gate-only stage depends on another human being reachable, so MERCY
   * stops being a footnote there and becomes a primary control.
   */
  /*
   * A gate-only stage is identified by its payload carrying digit null, not by
   * its position. It can sit anywhere in the run.
   */
  function isGateStage(n) {
    return !!(payloads[n] && payloads[n].digit == null);
  }

  function setFooterMode(n) {
    var gate = isGateStage(n);
    document.body.classList.toggle('gate-stage', gate);
    var note = $('ftrnote');
    if (note) {
      note.textContent = gate
        ? 'NOBODY AROUND TO AUTHORIZE? USE MERCY.'
        : 'NO OVERRIDE ON THIS TERMINAL.';
    }
  }

  function renderStage(n, pl) {
    stopHintTimer();
    setSysline('STAGE ' + n + ' OF ' + GATE_COUNT +
      (pl.digit == null ? ' // STATUS: AWAITING AUTHORIZATION' : ' // STATUS: LOCKED'));
    setFooterMode(n);

    var v = view();
    v.innerHTML = '';

    var sec = el('section', 'stage');

    var head = el('div', 'stage-head');
    head.appendChild(el('span', 'stage-tag', 'STAGE ' + n + ' / ' + GATE_COUNT));
    head.appendChild(el('span', 'stage-label', String(pl.label || '')));
    sec.appendChild(head);

    var prompt = el('div', 'prompt');
    prompt.innerHTML = pl.prompt || ''; /* trusted content from the source file */
    sec.appendChild(prompt);

    var mount = el('div', 'mount');
    mount.id = 'mount';
    sec.appendChild(mount);

    var form = el('form', 'answer');
    form.id = 'ansform';
    form.setAttribute('autocomplete', 'off');
    var input = el('input', 'ans-input');
    input.id = 'ansinput';
    input.type = 'text';
    input.placeholder = String(pl.placeholder || 'answer');
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('autocorrect', 'off');
    input.setAttribute('autocapitalize', 'off');
    input.setAttribute('spellcheck', 'false');
    input.setAttribute('aria-label', 'your answer');
    var submit = el('button', 'btn', 'SUBMIT');
    submit.type = 'submit';
    form.appendChild(input);
    form.appendChild(submit);
    sec.appendChild(form);

    var reject = el('div', 'reject');
    reject.id = 'reject';
    reject.setAttribute('role', 'status');
    reject.setAttribute('aria-live', 'polite');
    sec.appendChild(reject);

    var meta = el('div', 'meta');
    var hintBtn = el('button', 'btn ghost', 'HINT');
    hintBtn.id = 'hintbtn';
    hintBtn.type = 'button';
    var attempts = el('span', 'attempts');
    attempts.id = 'attempts';
    meta.appendChild(hintBtn);
    meta.appendChild(attempts);
    sec.appendChild(meta);

    var hints = el('ol', 'hints');
    hints.id = 'hints';
    sec.appendChild(hints);

    v.appendChild(sec);

    renderAttempts(n);
    renderHints(n, pl);
    startHintTimer(n, pl);

    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var val = input.value;
      input.value = '';
      handleSubmit(n, pl, val);
    });

    hintBtn.addEventListener('click', function () {
      if (hintBtn.disabled) return;
      var used = S.hints[n] || 0;
      if (used >= (pl.hints || []).length) return;
      S.hints[n] = used + 1;
      sfx('hint');
      saveState();
      renderHints(n, pl);
      updateHintButton(n, pl);
    });

    if (n === MASTERMIND_STAGE) setupMastermindStage(n, pl, form, input);
    else input.focus({ preventScroll: true });
  }

  function renderAttempts(n) {
    var node = $('attempts');
    if (node) node.textContent = 'ATTEMPTS ' + (S.attempts[n] || 0);
  }

  function renderHints(n, pl) {
    var list = $('hints');
    if (!list) return;
    var used = S.hints[n] || 0;
    var all = pl.hints || [];
    list.innerHTML = '';
    for (var i = 0; i < used && i < all.length; i++) {
      list.appendChild(el('li', 'hint', all[i]));
    }
  }

  function updateHintButton(n, pl) {
    var btn = $('hintbtn');
    if (!btn) return;
    var all = pl.hints || [];
    var used = S.hints[n] || 0;
    var left = all.length - used;
    var since = Date.now() - (S.stageAt[n] || Date.now());
    var wait = HINT_DELAY_MS - since;

    if (wait > 0) {
      var secs = Math.ceil(wait / 1000);
      btn.disabled = true;
      btn.textContent = 'HINT ' + pad2(Math.floor(secs / 60)) + ':' + pad2(secs % 60);
      return;
    }
    if (left <= 0) {
      btn.disabled = true;
      btn.textContent = 'NO MORE HINTS';
      return;
    }
    btn.disabled = false;
    btn.textContent = 'HINT (' + left + ')';
  }

  function startHintTimer(n, pl) {
    stopHintTimer();
    updateHintButton(n, pl);
    hintTimer = setInterval(function () {
      if (S.stage !== n) { stopHintTimer(); return; }
      updateHintButton(n, pl);
    }, 1000);
  }

  function stopHintTimer() {
    if (hintTimer) { clearInterval(hintTimer); hintTimer = null; }
  }

  /* ----------------------------------------------------------- the gate */

  /*
   * Resolves to the stage's CANONICAL normalized answer when the input is
   * accepted, or null when it is not.
   *
   * The gate accepts aliases, but every key in the chain is derived from the
   * canonical answer. So on a hit we unwrap keys[j], which holds the canonical
   * answer encrypted under the alias the player actually typed. Typing an
   * accepted alias and typing the canonical answer therefore chain identically.
   */
  function matchesGate(n, raw) {
    var norm = normalize(raw);
    if (!norm) return Promise.resolve(null);
    var st = stageData(n);
    return sha256Hex(P.salt + norm).then(function (h) {
      var j = st.hashes.indexOf(h);
      if (j === -1) return null;
      if (!st.keys || !st.keys[j]) {
        console.warn('puzzles.js has no alias unwrap blob for stage ' + n + '. Rebuild it with: node tools/build.mjs');
        return norm;
      }
      return decryptPayload(st.keys[j].payload, st.keys[j].iv, norm).then(function (o) {
        return o && typeof o.c === 'string' ? o.c : norm;
      });
    });
  }

  function handleSubmit(n, pl, raw) {
    return matchesGate(n, raw).then(function (canon) {
      if (canon) return accept(n, pl, canon);
      rejectAttempt(n);
    }).catch(function (err) {
      console.error('gate error', err);
      rejectAttempt(n);
    });
  }

  function rejectAttempt(n) {
    S.attempts[n] = (S.attempts[n] || 0) + 1;
    sfx('wrong');
    saveState();
    renderAttempts(n);
    var msg = $('reject');
    if (msg) msg.textContent = REJECTIONS[rejectIndex++ % REJECTIONS.length];
    var input = $('ansinput');
    var target = (input && input.offsetParent !== null) ? input : $('mount');
    if (target) {
      target.classList.remove('shake');
      void target.offsetWidth; /* restart the animation */
      target.classList.add('shake');
    }
  }

  function accept(n, pl, canon) {
    S.answers[n - 1] = canon; /* canonical form, so the key chain is alias proof */
    saveState();
    stopHintTimer();
    /*
     * A gate-only stage clears with the authorization cue. A digit stage gets
     * the correct chime plus a second, shorter cue as the digit lands on the
     * rail. The last stage is silent here because renderReveal fires its own.
     */
    if (pl && pl.digit == null) {
      sfx('auth');
    } else if (n < GATE_COUNT) {
      sfx('correct');
      setTimeout(function () { sfx('digit'); }, 380);
    }
    if (n < GATE_COUNT) return goStage(n + 1);
    return goStage(REVEAL_STAGE);
  }

  /* --------------------------------------------- mastermind stage hook */

  function setupMastermindStage(n, pl, form, input) {
    var digits = earnedDigits(); /* stages 1..3, already solved to be here */
    var secret = digits.join('') + String(pl.digit);

    if (typeof window.mountMastermind !== 'function') {
      console.warn('mountMastermind is not defined. Falling back to the plain text input for the mastermind stage.');
      input.focus({ preventScroll: true });
      return;
    }
    if (secret.length !== DIGIT_SLOTS || /[^0-9]/.test(secret)) {
      console.warn('could not assemble a 4 digit secret for mastermind, got "' + secret + '". Falling back to the text input.');
      input.focus({ preventScroll: true });
      return;
    }

    form.hidden = true;
    var solvedOnce = false;

    try {
      window.mountMastermind($('mount'), {
        secret: secret,
        onWrong: function () { rejectAttempt(n); },
        onSolved: function () {
          if (solvedOnce) return;
          solvedOnce = true;
          matchesGate(n, secret).then(function (canon) {
            if (canon) return accept(n, pl, canon);
            /*
             * The widget was cracked but the assembled code is not an accepted
             * answer for stage 4, so the final payload key cannot be derived
             * from it. Hand the player back the text input rather than dead end.
             */
            console.warn('mastermind solved but the assembled code is not an accepted final stage answer. Set the final stage answers[0] to the combo in puzzles.src.json.');
            solvedOnce = false;
            form.hidden = false;
            var msg = $('reject');
            if (msg) msg.textContent = 'SEQUENCE ACCEPTED. RELEASE PHRASE STILL REQUIRED.';
            input.focus({ preventScroll: true });
          });
        }
      });
    } catch (err) {
      console.warn('mountMastermind threw, falling back to the text input.', err);
      form.hidden = false;
      input.focus({ preventScroll: true });
    }
  }

  /* --------------------------------------------------------------- reveal */

  function renderReveal() {
    stopHintTimer();
    showWorking('DECRYPTING RELEASE ORDER ...');
    var km = S.answers[GATE_COUNT - 1];
    if (km == null) {
      hardReset('CUSTODY LEDGER CORRUPT. RESTARTING RUN.');
      return Promise.resolve();
    }
    return decryptPayload(P.finalPayload, P.finalIv, km).then(function (fin) {
      sfx('reveal');
      setSysline('CUSTODY RELEASED // STATUS: OPEN');
      setFooterMode(REVEAL_STAGE);
      var v = view();
      v.innerHTML = '';
      var sec = el('section', 'reveal');
      sec.appendChild(el('div', 'reveal-kicker', 'RELEASE AUTHORIZED'));
      sec.appendChild(el('div', 'combo', String(fin.combo || '')));
      sec.appendChild(el('p', 'taunt', String(fin.taunt || '')));
      sec.appendChild(el('p', 'reveal-note', 'Take that code to the key box. What is inside is not the key.'));
      var stats = el('p', 'reveal-note dim', runStats());
      sec.appendChild(stats);
      v.appendChild(sec);
      renderRailAllFilled(String(fin.combo || ''));
    }).catch(function (err) {
      console.error('final decrypt failed', err);
      hardReset('RELEASE ORDER UNREADABLE. RESTARTING RUN.');
    });
  }

  function renderRailAllFilled(combo) {
    var rail = $('rail');
    if (!rail) return;
    rail.innerHTML = '';
    for (var i = 0; i < DIGIT_SLOTS; i++) {
      rail.appendChild(el('span', 'slot filled', combo.charAt(i) || '#'));
    }
  }

  function runStats() {
    var total = 0;
    for (var k in S.attempts) {
      if (Object.prototype.hasOwnProperty.call(S.attempts, k)) total += S.attempts[k];
    }
    var mins = S.t0 ? Math.max(1, Math.round((Date.now() - S.t0) / 60000)) : 0;
    var hints = 0;
    for (var j in S.hints) {
      if (Object.prototype.hasOwnProperty.call(S.hints, j)) hints += S.hints[j];
    }
    return 'ELAPSED ' + mins + ' MIN // WRONG ANSWERS ' + total + ' // HINTS USED ' + hints;
  }

  /* ---------------------------------------------------------------- reset */

  var resetGuard = 0;

  function hardReset(message) {
    stopHintTimer();
    resetGuard++;
    if (resetGuard > 2) {
      showFatal('TERMINAL FAULT', 'The puzzle file could not be decrypted. Rebuild it with: node tools/build.mjs');
      return;
    }
    clearState();
    S = freshState();
    payloads = {};
    S.booted = true; /* skip the boot log on an error restart */
    S.t0 = Date.now();
    saveState();
    renderRail();
    setSysline('NODE: RELEASE-01 // STATUS: LOCKED');
    goStage(1).then(function () {
      var msg = $('reject');
      if (msg && message) msg.textContent = message;
    });
  }

  function installHiddenReset() {
    var taps = [];
    document.addEventListener('keydown', function (ev) {
      if (ev.key !== 'r' && ev.key !== 'R') return;
      var t = ev.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
      var now = Date.now();
      taps.push(now);
      taps = taps.filter(function (x) { return now - x <= RESET_WINDOW_MS; });
      if (taps.length >= RESET_TAPS) {
        taps = [];
        clearState();
        window.location.reload();
      }
    });
  }

  /* ----------------------------------------------------------------- boot */

  /* ------------------------------------------------------------- admin */

  /*
   * Operator dashboard. Encrypted under a 4 digit PIN, which is the weakest key
   * in the file, so the build raises the PBKDF2 iteration count for this payload
   * specifically and we add an escalating lockout on wrong entries. That stops a
   * curious person poking at it. It does not stop a determined scripted attack,
   * and nothing here pretends otherwise.
   */
  var ADMIN_LOCK_KEY = 'release-terminal-admin-lock';

  /*
   * The boot screen listens for clicks at the document level to skip the
   * typewriter, so while the admin panel is open that listener has to stand
   * down or every click in here would start the run underneath us.
   */
  var adminOpen = false;

  /* Reload rather than re-render, so the run resumes from saved state cleanly. */
  function leaveAdmin() { window.location.reload(); }

  function adminLockState() {
    try {
      var o = JSON.parse(window.localStorage.getItem(ADMIN_LOCK_KEY) || '{}');
      return { fails: o.fails || 0, until: o.until || 0 };
    } catch (e) { return { fails: 0, until: 0 }; }
  }

  function setAdminLock(fails, until) {
    try {
      window.localStorage.setItem(ADMIN_LOCK_KEY, JSON.stringify({ fails: fails, until: until }));
    } catch (e) {}
  }

  function openAdmin() {
    adminOpen = true;
    document.body.classList.add('admin-open');
    var v = view();
    v.innerHTML = '';
    var sec = el('section', 'stage admin-gate');
    sec.appendChild(el('div', 'stage-tag', 'RESTRICTED // OPERATOR ACCESS'));
    sec.appendChild(el('p', 'panel-body', 'This panel is for the people setting the game up. It contains every answer. Enter the operator PIN.'));

    var form = el('form', 'answer');
    var input = el('input', 'ans-input');
    input.type = 'text';
    input.id = 'adminpin';
    input.setAttribute('inputmode', 'numeric');
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('placeholder', 'operator PIN');
    input.setAttribute('aria-label', 'Operator PIN');
    var go = el('button', 'btn wide', 'UNLOCK');
    go.type = 'submit';
    form.appendChild(input);
    form.appendChild(go);
    sec.appendChild(form);

    var msg = el('div', 'reject', '');
    msg.id = 'adminmsg';
    sec.appendChild(msg);

    var back = el('button', 'btn wide ghost', 'BACK TO THE TERMINAL');
    back.type = 'button';
    back.addEventListener('click', function () { leaveAdmin(); });
    sec.appendChild(back);

    v.appendChild(sec);
    setSysline('OPERATOR ACCESS // RESTRICTED');
    input.focus();

    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var lock = adminLockState();
      var now = Date.now();
      if (lock.until > now) {
        msg.textContent = 'LOCKED OUT. WAIT ' + Math.ceil((lock.until - now) / 1000) + 'S.';
        return;
      }
      var pin = normalize(input.value);
      if (!pin) return;
      msg.textContent = 'DERIVING KEY ...';
      decryptPayload(P.adminPayload, P.adminIv, 'admin:' + pin, P.adminIters)
        .then(function (data) {
          setAdminLock(0, 0);
          renderAdmin(data);
        })
        .catch(function () {
          var fails = lock.fails + 1;
          /* 5 free tries, then the wait doubles each time up to a minute. */
          var wait = fails <= 5 ? 0 : Math.min(60000, 1000 * Math.pow(2, fails - 5));
          setAdminLock(fails, wait ? Date.now() + wait : 0);
          sfx('wrong');
          msg.textContent = wait
            ? 'DENIED. LOCKED FOR ' + Math.round(wait / 1000) + 'S.'
            : 'DENIED.';
          input.select();
        });
    });
  }

  function adminList(parent, title, rows, render) {
    if (!rows || !rows.length) return;
    parent.appendChild(el('h3', 'admin-h', title));
    var ul = el('ul', 'admin-list');
    rows.forEach(function (r) {
      var li = el('li', 'admin-item');
      render(li, r);
      ul.appendChild(li);
    });
    parent.appendChild(ul);
  }

  function renderAdmin(a) {
    var v = view();
    v.innerHTML = '';
    setSysline('OPERATOR ACCESS // GRANTED');

    var sec = el('section', 'stage admin');
    sec.appendChild(el('h2', 'admin-title', a.title || 'OPERATOR DASHBOARD'));
    if (a.warning) sec.appendChild(el('p', 'admin-warn', a.warning));
    if (a.premise) {
      sec.appendChild(el('h3', 'admin-h', 'THE GAME'));
      sec.appendChild(el('p', 'admin-p', a.premise));
    }

    adminList(sec, 'THE FULL CHAIN', a.chain, function (li, r) { li.textContent = r; });

    if (a.siteRole) sec.appendChild(el('p', 'admin-p admin-note', a.siteRole));

    adminList(sec, 'STATUS', a.status, function (li, r) { li.textContent = r; });

    if (a.combo) {
      var box = el('div', 'admin-combo');
      box.appendChild(el('div', 'admin-combo-label', 'LOCKBOX COMBINATION'));
      box.appendChild(el('div', 'admin-combo-val', a.combo));
      if (a.comboNote) box.appendChild(el('div', 'admin-combo-note', a.comboNote));
      sec.appendChild(box);
    }

    adminList(sec, 'ANSWER KEY', a.answerKey, function (li, r) {
      li.appendChild(el('span', 'admin-k', r.stage));
      li.appendChild(el('span', 'admin-a', r.answer + (r.digit && r.digit !== 'none' ? '  ->  digit ' + r.digit : '  ->  no digit')));
      if (r.note) li.appendChild(el('span', 'admin-n', r.note));
    });

    if (a.qrSvg) {
      sec.appendChild(el('h3', 'admin-h', 'QR CODE FOR THE KEY BOX'));
      var qr = el('div', 'admin-qr');
      qr.innerHTML = a.qrSvg; /* trusted, generated at build time */
      sec.appendChild(qr);
      if (a.qrNote) sec.appendChild(el('p', 'admin-p admin-note', a.qrNote));
    }

    adminList(sec, 'MATERIALS', a.materials, function (li, r) { li.textContent = r; });

    adminList(sec, 'SETUP ORDER', a.setup, function (li, r) {
      li.appendChild(el('span', 'admin-k', r.step + '.  ' + r.who));
      li.appendChild(el('span', 'admin-n', r.do));
    });

    if (a.setupNote) sec.appendChild(el('p', 'admin-p admin-note', a.setupNote));

    adminList(sec, 'GROUND RULES', a.rules, function (li, r) { li.textContent = r; });
    adminList(sec, 'FAILSAFES', a.failsafe, function (li, r) { li.textContent = r; });

    /*
     * The printable handouts live in here so nobody has to be sent files. Open
     * the dashboard, print or screenshot the block, done.
     */
    function doc(title, body) {
      if (!body) return;
      sec.appendChild(el('h3', 'admin-h', title));
      sec.appendChild(el('pre', 'admin-doc', body));
    }
    doc('PRINT: BRIEF FOR JAMES', a.supervisorBrief);
    doc('PRINT: BRIEF FOR ALEX', a.alexBrief);
    doc('PRINT: BRIEF FOR THE TEAM', a.teamBrief);

    if (a.spoilerFree) {
      sec.appendChild(el('h3', 'admin-h', 'FOR A HELPER WHO WANTS NO SPOILERS'));
      sec.appendChild(el('p', 'admin-p', a.spoilerFree));
    }

    var back = el('button', 'btn wide ghost', 'BACK TO THE TERMINAL');
    back.type = 'button';
    back.addEventListener('click', function () { leaveAdmin(); });
    sec.appendChild(back);

    v.appendChild(sec);
    v.scrollTop = 0;
    window.scrollTo(0, 0);
  }

  function wireFooter() {
    var m = $('mercy');
    if (m) m.setAttribute('href', MERCY_SMS);

    var ab = $('adminbtn');
    if (ab) {
      if (!P.adminPayload) ab.hidden = true;
      else ab.addEventListener('click', function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        openAdmin();
      });
    }

    var mute = $('mute');
    if (!mute) return;
    if (!window.SOUND || !window.SOUND.available()) { mute.hidden = true; return; }

    var saved = false;
    try { saved = window.localStorage.getItem(MUTE_KEY) === '1'; } catch (e) {}
    applyMute(saved);

    mute.addEventListener('click', function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      var next = !window.SOUND.isMuted();
      applyMute(next);
      try { window.localStorage.setItem(MUTE_KEY, next ? '1' : '0'); } catch (e) {}
      /* Unmuting is itself a gesture, so it can start audio mid run. */
      if (!next) window.SOUND.unlock();
    });

    function applyMute(m2) {
      window.SOUND.setMuted(m2);
      mute.textContent = m2 ? 'SOUND OFF' : 'SOUND ON';
      mute.setAttribute('aria-pressed', m2 ? 'true' : 'false');
    }
  }

  function replay() {
    /* Rebuild every payload we are entitled to, in order. */
    var chain = Promise.resolve();
    var upTo = Math.min(S.stage, GATE_COUNT);
    for (var i = 1; i <= upTo; i++) {
      (function (n) {
        chain = chain.then(function () { return ensurePayload(n); });
      })(i);
    }
    if (S.stage === REVEAL_STAGE) {
      for (var j = 1; j <= GATE_COUNT; j++) {
        (function (n) {
          chain = chain.then(function () { return ensurePayload(n); });
        })(j);
      }
    }
    return chain;
  }

  function start() {
    if (!window.PUZZLES || !Array.isArray(window.PUZZLES.stages) ||
        window.PUZZLES.stages.length !== GATE_COUNT) {
      showFatal('NO PUZZLE FILE', 'puzzles.js is missing or malformed. Run: node tools/build.mjs');
      return;
    }
    if (!window.crypto || !window.crypto.subtle) {
      showFatal(
        'INSECURE CONTEXT',
        'This terminal needs Web Crypto, which browsers only expose over https or on localhost. Open the https link.'
      );
      return;
    }

    P = window.PUZZLES;
    SALT_BYTES = bytesFromB64(P.salt);

    wireFooter();
    installHiddenReset();

    S = loadState();
    if (!S.t0) S.t0 = Date.now();
    renderRail();

    if (!S.booted) {
      showWorking('POWERING ON ...');
      runBoot().then(function () {
        S.booted = true;
        S.stage = 1;
        saveState();
        return goStage(1);
      });
      return;
    }

    showWorking('RESTORING SESSION ...');
    replay().then(function () {
      renderRail();
      return goStage(S.stage < 1 ? 1 : S.stage);
    }).catch(function (err) {
      console.error('replay failed', err);
      hardReset('SESSION KEY MISMATCH. RESTARTING RUN.');
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
