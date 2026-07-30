/*
 * audio.js
 *
 * All sound is synthesized at runtime with the Web Audio API. There are no
 * audio files, no network requests, and no dependencies, so the page stays
 * self-contained and works offline.
 *
 * Browsers refuse to start audio without a user gesture, so nothing is created
 * until unlock() is called from a real click. Until then this module is inert.
 *
 * Public surface:
 *   window.SOUND.unlock()      create the context, resume it, start the loop
 *   window.SOUND.sfx(name)     one-shot effect
 *   window.SOUND.setMuted(b)   mute or unmute, persisted by the caller
 *   window.SOUND.isMuted()
 *   window.SOUND.stopMusic()
 */
(function () {
  'use strict';

  var AC = window.AudioContext || window.webkitAudioContext;

  var ctx = null;
  var master = null;      /* everything runs through here, so muting is one node */
  var musicBus = null;    /* bed sits lower than the effects */
  var sfxBus = null;
  var muted = false;
  var started = false;
  var loopTimer = null;
  var step = 0;

  /* A natural minor figure. Low, slow, and deliberately unresolved so it can
   * run for twenty minutes behind someone doing arithmetic without nagging. */
  var ROOT = 110.0; /* A2 */
  var SCALE = [0, 3, 5, 7, 10, 12, 10, 7]; /* semitone offsets, up and back */
  var STEP_MS = 900;

  function hz(semitones) {
    return ROOT * Math.pow(2, semitones / 12);
  }

  function now() { return ctx ? ctx.currentTime : 0; }

  /* ------------------------------------------------------------- plumbing */

  function build() {
    if (ctx || !AC) return;
    ctx = new AC();

    master = ctx.createGain();
    master.gain.value = muted ? 0 : 1;
    master.connect(ctx.destination);

    /* Gentle low pass keeps square and sawtooth edges from sounding harsh on
     * phone speakers, which is where this will actually be played. */
    var tame = ctx.createBiquadFilter();
    tame.type = 'lowpass';
    tame.frequency.value = 2600;
    tame.Q.value = 0.4;
    tame.connect(master);

    musicBus = ctx.createGain();
    musicBus.gain.value = 0.055;
    musicBus.connect(tame);

    sfxBus = ctx.createGain();
    sfxBus.gain.value = 0.16;
    sfxBus.connect(tame);
  }

  /* One enveloped oscillator. Everything below is built out of these. */
  function tone(opts) {
    if (!ctx) return;
    var bus = opts.bus || sfxBus;
    var t0 = (opts.at || now()) + (opts.delay || 0);
    var dur = opts.dur || 0.18;
    var peak = opts.gain == null ? 1 : opts.gain;

    var osc = ctx.createOscillator();
    osc.type = opts.type || 'triangle';
    osc.frequency.setValueAtTime(opts.freq, t0);
    if (opts.slideTo) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(1, opts.slideTo), t0 + dur);
    }

    var g = ctx.createGain();
    var atk = opts.attack == null ? 0.012 : opts.attack;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t0 + atk);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

    osc.connect(g);
    g.connect(bus);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  }

  /* Short filtered noise burst, used for the rejection buzz. */
  function noise(dur, gain, freq) {
    if (!ctx) return;
    var n = Math.floor(ctx.sampleRate * dur);
    var buf = ctx.createBuffer(1, n, ctx.sampleRate);
    var d = buf.getChannelData(0);
    for (var i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
    var src = ctx.createBufferSource();
    src.buffer = buf;
    var f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = freq || 220;
    f.Q.value = 1.1;
    var g = ctx.createGain();
    g.gain.value = gain == null ? 0.5 : gain;
    src.connect(f); f.connect(g); g.connect(sfxBus);
    src.start(now());
  }

  /* ---------------------------------------------------------------- music */

  function tick() {
    if (!ctx || muted) return;
    var deg = SCALE[step % SCALE.length];
    var t = now();

    /* Arpeggio voice. */
    tone({ bus: musicBus, freq: hz(deg + 12), type: 'triangle', dur: 1.1, gain: 0.9, attack: 0.03 });

    /* Sub pulse every other step gives it a heartbeat without a drum. */
    if (step % 2 === 0) {
      tone({ bus: musicBus, freq: hz(deg), type: 'sine', dur: 1.6, gain: 0.85, attack: 0.08 });
    }

    /* A fifth drifts in every eighth step so the bed does not feel like a loop. */
    if (step % 8 === 3) {
      tone({ bus: musicBus, freq: hz(deg + 19), type: 'sine', dur: 2.2, gain: 0.4, attack: 0.4, at: t + 0.2 });
    }

    step++;
  }

  function startMusic() {
    if (loopTimer || !ctx) return;
    tick();
    loopTimer = setInterval(tick, STEP_MS);
  }

  function stopMusic() {
    if (loopTimer) { clearInterval(loopTimer); loopTimer = null; }
  }

  /* ------------------------------------------------------------- one shots */

  var EFFECTS = {
    /* Stage cleared. Rising major triad, the "that was right" sound. */
    correct: function () {
      var t = now();
      [0, 4, 7, 12].forEach(function (s, i) {
        tone({ freq: hz(24 + s), type: 'triangle', dur: 0.24, gain: 0.7, at: t, delay: i * 0.075 });
      });
    },
    /* Wrong answer. Short, low, unpleasant but not startling. */
    wrong: function () {
      tone({ freq: hz(3), slideTo: hz(-6), type: 'sawtooth', dur: 0.26, gain: 0.5 });
      noise(0.16, 0.28, 180);
    },
    /* A digit landed on the rail. */
    digit: function () {
      var t = now();
      tone({ freq: hz(31), type: 'square', dur: 0.09, gain: 0.35, at: t });
      tone({ freq: hz(36), type: 'square', dur: 0.14, gain: 0.3, at: t, delay: 0.085 });
    },
    /* Hint taken. Deliberately a touch deflating. */
    hint: function () {
      tone({ freq: hz(19), slideTo: hz(14), type: 'sine', dur: 0.3, gain: 0.45 });
    },
    /* Human authorization accepted. */
    auth: function () {
      var t = now();
      [0, 7, 12, 19].forEach(function (s, i) {
        tone({ freq: hz(12 + s), type: 'sine', dur: 0.5, gain: 0.55, at: t, delay: i * 0.1 });
      });
    },
    /* The reveal. Longest cue in the set. */
    reveal: function () {
      var t = now();
      [0, 4, 7, 12, 16, 19, 24].forEach(function (s, i) {
        tone({ freq: hz(12 + s), type: 'triangle', dur: 0.85, gain: 0.6, at: t, delay: i * 0.11 });
      });
      tone({ freq: hz(0), type: 'sine', dur: 2.4, gain: 0.8, at: t, attack: 0.05 });
    },
    /* Terminal boot. */
    boot: function () {
      var t = now();
      tone({ freq: hz(-12), slideTo: hz(12), type: 'sawtooth', dur: 0.6, gain: 0.3, at: t });
      tone({ freq: hz(24), type: 'square', dur: 0.08, gain: 0.25, at: t, delay: 0.55 });
    }
  };

  /* ------------------------------------------------------------------ api */

  window.SOUND = {
    unlock: function () {
      if (!AC) return false;
      build();
      if (!ctx) return false;
      if (ctx.state === 'suspended' && ctx.resume) ctx.resume();
      if (!started) {
        started = true;
        EFFECTS.boot();
        if (!muted) startMusic();
      }
      return true;
    },

    sfx: function (name) {
      if (muted || !ctx || !EFFECTS[name]) return;
      if (ctx.state === 'suspended' && ctx.resume) ctx.resume();
      try { EFFECTS[name](); } catch (e) { /* audio must never break the puzzle */ }
    },

    setMuted: function (m) {
      muted = !!m;
      if (master) {
        master.gain.setTargetAtTime(muted ? 0 : 1, now(), 0.05);
      }
      if (muted) stopMusic();
      else if (started && ctx) startMusic();
    },

    isMuted: function () { return muted; },
    stopMusic: stopMusic,
    available: function () { return !!AC; }
  };
})();
