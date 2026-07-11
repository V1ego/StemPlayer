/* demo-synth.js — synthesises a royalty-free multi-stem demo entirely in the
 * browser using OfflineAudioContext. Each stem is rendered to its own
 * AudioBuffer, so the 4 stems are perfectly isolated (no Demucs needed).
 *
 * Stems map: drums, bass, other (arp/melody), vocals (warm pad).
 * Progression Am - F - C - G, one chord per bar, 16 bars.
 */
(function (global) {
  "use strict";

  var SR = 44100;
  // Chord roots (Hz) and triad tones (MIDI) per chord, 4 chords = 1 cycle.
  // Am / F / C / G
  var BASS = [110.00, 87.31, 65.41, 98.00];          // A2 F2 C2 G2
  var TRIAD = [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]]; // MIDI

  function midi(n) { return 440 * Math.pow(2, (n - 69) / 12); }

  function offline(seconds) {
    var Ctx = global.OfflineAudioContext || global.webkitOfflineAudioContext;
    return new Ctx(2, Math.ceil(SR * seconds), SR);
  }

  // Generic oscillator note with a fast attack / exp decay envelope.
  function note(ctx, t, freq, dur, type, gain, dest) {
    var o = ctx.createOscillator();
    o.type = type || "sine";
    o.frequency.setValueAtTime(freq, t);
    var g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(dest);
    o.start(t); o.stop(t + dur + 0.02);
  }

  function noiseBurst(ctx, t, dur, hp, lp, gain, dest) {
    var n = Math.floor(SR * dur);
    var buf = ctx.createBuffer(1, n, SR);
    var d = buf.getChannelData(0);
    for (var i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    var src = ctx.createBufferSource(); src.buffer = buf;
    var hpF = ctx.createBiquadFilter(); hpF.type = "highpass"; hpF.frequency.value = hp || 4000;
    var lpF = ctx.createBiquadFilter(); lpF.type = "lowpass"; lpF.frequency.value = lp || 12000;
    var g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(hpF); hpF.connect(lpF); lpF.connect(g); g.connect(dest);
    src.start(t); src.stop(t + dur + 0.02);
  }

  // ---- DRUMS ----
  function renderDrums(bpm, punch) {
    var beat = 60 / bpm;
    var bars = 16, seconds = bars * 4 * beat + 1.0;
    var ctx = offline(seconds);
    var master = ctx.createGain(); master.gain.value = 0.9; master.connect(ctx.destination);

    for (var bar = 0; bar < bars; bar++) {
      var barT = bar * 4 * beat;
      var four = punch || (bar % 4 === 0); // four-on-floor on turnaround bars for nocturne
      for (var b = 0; b < 4; b++) {
        var t = barT + b * beat;
        // kick
        if (four || b === 0 || b === 2) {
          var o = ctx.createOscillator(); o.type = "sine";
          o.frequency.setValueAtTime(150, t);
          o.frequency.exponentialRampToValueAtTime(45, t + 0.12);
          var g = ctx.createGain();
          g.gain.setValueAtTime(1.0, t);
          g.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
          o.connect(g); g.connect(master); o.start(t); o.stop(t + 0.32);
        }
        // snare on 2 & 4
        if (b === 1 || b === 3) {
          noiseBurst(ctx, t, 0.18, 1800, 8000, 0.55, master);
        }
        // hats on 8ths
        noiseBurst(ctx, t, 0.05, 7000, 16000, 0.18, master);
        noiseBurst(ctx, t + beat / 2, 0.05, 7000, 16000, 0.12, master);
      }
    }
    return ctx.startRendering();
  }

  // ---- BASS ----
  function renderBass(bpm) {
    var beat = 60 / bpm;
    var bars = 16, seconds = bars * 4 * beat + 1.0;
    var ctx = offline(seconds);
    var master = ctx.createGain(); master.gain.value = 0.8; master.connect(ctx.destination);
    for (var bar = 0; bar < bars; bar++) {
      var root = BASS[bar % 4];
      var t0 = bar * 4 * beat;
      // root on beat 1 and 3, octave pulse on the and of 2
      note(ctx, t0, root, beat * 1.6, "sawtooth", 0.5, master);
      note(ctx, t0 + root * 0, root / 2, beat * 1.6, "sine", 0.6, master); // sub
      note(ctx, t0 + 2 * beat, root, beat * 1.5, "sawtooth", 0.45, master);
      note(ctx, t0 + 2.5 * beat, root * 1.5, beat * 0.8, "square", 0.25, master);
    }
    return ctx.startRendering();
  }

  // ---- OTHER (arp) ----
  function renderArp(bpm) {
    var beat = 60 / bpm;
    var bars = 16, seconds = bars * 4 * beat + 1.0;
    var ctx = offline(seconds);
    var master = ctx.createGain(); master.gain.value = 0.32; master.connect(ctx.destination);
    for (var bar = 0; bar < bars; bar++) {
      var tri = TRIAD[bar % 4];
      var t0 = bar * 4 * beat;
      var step = beat / 2; // 8th notes
      for (var s = 0; s < 8; s++) {
        var n = tri[s % 3] + 12; // one octave up
        note(ctx, t0 + s * step, midi(n), step * 0.9, "triangle", 0.22, master);
      }
    }
    return ctx.startRendering();
  }

  // ---- VOCALS (warm pad) ----
  function renderPad(bpm) {
    var beat = 60 / bpm;
    var bars = 16, seconds = bars * 4 * beat + 1.0;
    var ctx = offline(seconds);
    var master = ctx.createGain(); master.gain.value = 0.22; master.connect(ctx.destination);
    var lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 2600; lp.connect(master);
    for (var bar = 0; bar < bars; bar++) {
      var tri = TRIAD[bar % 4];
      var t0 = bar * 4 * beat;
      var dur = 4 * beat * 0.98;
      for (var v = 0; v < 3; v++) {
        var f = midi(tri[v] + 12);
        // detuned saws for warmth
        note(ctx, t0, f, dur, "sawtooth", 0.16, lp);
        note(ctx, t0, f * 1.003, dur, "sawtooth", 0.14, lp);
        note(ctx, t0, f * 0.997, dur, "sawtooth", 0.14, lp);
      }
      // slow filter swell on sustained chord
      lp.frequency.cancelScheduledValues(t0);
      lp.frequency.setValueAtTime(1400, t0);
      lp.frequency.linearRampToValueAtTime(3200, t0 + dur * 0.6);
      lp.frequency.linearRampToValueAtTime(1200, t0 + dur);
    }
    return ctx.startRendering();
  }

  function build(demoId) {
    var punch = demoId === "punch";
    var bpm = punch ? 120 : 92;
    return Promise.all([
      renderDrums(bpm, punch),
      renderBass(bpm),
      renderArp(bpm),
      renderPad(bpm)
    ]).then(function (bufs) {
      return { drums: bufs[0], bass: bufs[1], other: bufs[2], vocals: bufs[3], bpm: bpm };
    });
  }

  global.DemoSynth = { build: build };
})(window);
