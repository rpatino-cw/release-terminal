/* mastermind.js - stage 4 widget for ASSET RELEASE TERMINAL.
   Exposes window.mountMastermind(containerEl, opts).
   opts = { secret: "4831", onSolved: function () {} }
   No dependencies. No storage. No inline styles.
   Allowed classes only: mm-wrap mm-input mm-btn mm-history mm-row mm-guess mm-score */
(function () {
  'use strict';

  var LEN = 4;

  /* Bulls and cows scoring that is correct for repeated digits.
     Pass 1: count exact position matches and pull them out of both pools.
     Pass 2: count remaining overlap by frequency, so a digit is credited
     only as many times as it actually remains available. */
  function scoreGuess(secret, guess) {
    var exact = 0;
    var close = 0;
    var pool = {};
    var leftovers = [];
    var i, d;

    for (i = 0; i < LEN; i++) {
      if (secret.charAt(i) === guess.charAt(i)) {
        exact++;
      } else {
        d = secret.charAt(i);
        pool[d] = (pool[d] || 0) + 1;
        leftovers.push(guess.charAt(i));
      }
    }
    for (i = 0; i < leftovers.length; i++) {
      d = leftovers[i];
      if (pool[d] > 0) {
        pool[d]--;
        close++;
      }
    }
    return { exact: exact, close: close };
  }

  function el(tag, cls) {
    var n = document.createElement(tag);
    if (cls) { n.className = cls; }
    return n;
  }

  window.mountMastermind = function mountMastermind(containerEl, opts) {
    if (!containerEl) { return null; }
    opts = opts || {};

    var secret = String(opts.secret || '').replace(/\D/g, '');
    if (secret.length !== LEN) {
      return null;
    }
    if (containerEl.getAttribute('data-mm-mounted') === '1') {
      return null;
    }
    containerEl.setAttribute('data-mm-mounted', '1');
    containerEl.textContent = '';

    var solved = false;
    var fired = false;

    var wrap = el('div', 'mm-wrap');

    /* styles.css lays out ".mm-wrap .mm-controls" as the flex row holding the
       input and the button. Without it .mm-input inherits the column axis from
       .mm-wrap and renders 120px tall. */
    var controls = el('div', 'mm-controls');

    var input = el('input', 'mm-input');
    input.type = 'text';
    input.inputMode = 'numeric';
    input.setAttribute('inputmode', 'numeric');
    input.setAttribute('pattern', '[0-9]*');
    input.setAttribute('maxlength', String(LEN));
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('autocorrect', 'off');
    input.setAttribute('autocapitalize', 'off');
    input.setAttribute('spellcheck', 'false');
    input.setAttribute('aria-label', 'four digit guess');
    input.placeholder = '0000';

    var btn = el('button', 'mm-btn');
    btn.type = 'button';
    btn.textContent = 'GUESS';

    var status = el('div', 'mm-score');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    /* .mm-score is white-space: nowrap, so every status string stays short
       enough to sit on one line at 390px. */
    status.textContent = 'ENTER 4 DIGITS';

    var history = el('div', 'mm-history');
    history.setAttribute('aria-label', 'guess history');

    controls.appendChild(input);
    controls.appendChild(btn);
    wrap.appendChild(controls);
    wrap.appendChild(status);
    wrap.appendChild(history);
    containerEl.appendChild(wrap);

    function flag(msg) {
      input.setAttribute('aria-invalid', 'true');
      status.textContent = msg;
    }

    function clearFlag() {
      input.removeAttribute('aria-invalid');
    }

    function addRow(guess, res) {
      var row = el('div', 'mm-row');
      var g = el('span', 'mm-guess');
      g.textContent = guess.split('').join(' ');
      var s = el('span', 'mm-score');
      s.textContent = res.exact + ' EXACT / ' + res.close + ' CLOSE';
      row.appendChild(g);
      row.appendChild(s);
      if (history.firstChild) {
        history.insertBefore(row, history.firstChild);
      } else {
        history.appendChild(row);
      }
    }

    function submit() {
      if (solved) { return; }
      var raw = input.value || '';
      var digits = raw.replace(/\D/g, '');

      if (digits.length !== LEN || digits !== raw.trim()) {
        flag('REJECTED: 4 DIGITS ONLY');
        return;
      }
      clearFlag();

      var res = scoreGuess(secret, digits);
      addRow(digits, res);
      input.value = '';

      if (res.exact === LEN) {
        solved = true;
        status.textContent = 'LOCK OPEN: ' + digits;
        input.disabled = true;
        btn.disabled = true;
        if (!fired) {
          fired = true;
          if (typeof opts.onSolved === 'function') {
            try { opts.onSolved(); } catch (e) { /* host callback is not our problem */ }
          }
        }
      } else {
        status.textContent = res.exact + ' EXACT / ' + res.close + ' CLOSE';
      }
      input.focus();
    }

    btn.addEventListener('click', submit);
    input.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        submit();
      }
    });
    input.addEventListener('input', function () {
      clearFlag();
    });

    return { submit: submit, isSolved: function () { return solved; } };
  };

  /* Inert unless the page is loaded with ?mmtest in the query string. */
  if (typeof location !== 'undefined' && location.search && location.search.indexOf('mmtest') !== -1) {
    (function selfTest() {
      var cases = [
        ['1234', '1234', 4, 0],
        ['1234', '4321', 0, 4],
        ['5863', '6835', 1, 3],
        ['1111', '1234', 1, 0],
        ['1234', '1111', 1, 0],
        ['1123', '3211', 0, 4],
        ['1122', '2211', 0, 4],
        ['0000', '0011', 2, 0],
        ['5863', '5555', 1, 0],
        ['5863', '0000', 0, 0],
        ['5863', '3333', 1, 0],
        ['5863', '3000', 0, 1],
        ['5863', '8653', 1, 3]
      ];
      var pass = 0;
      for (var i = 0; i < cases.length; i++) {
        var c = cases[i];
        var r = scoreGuess(c[0], c[1]);
        var ok = (r.exact === c[2] && r.close === c[3]);
        if (ok) { pass++; }
        console.log((ok ? 'PASS' : 'FAIL') + ' secret=' + c[0] + ' guess=' + c[1] +
          ' got ' + r.exact + '/' + r.close + ' want ' + c[2] + '/' + c[3]);
      }
      console.log('mastermind self-test: ' + pass + '/' + cases.length + ' passed');
    }());
  }
}());
