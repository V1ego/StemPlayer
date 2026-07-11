/* StemPlayerEngine — core Web Audio engine for the Web Stem Player.
 *
 * Design (verified against MDN):
 *  - 4 AudioBufferSourceNodes started with the SAME `when`/`offset` => sample sync.
 *  - start() is one-shot per node, so seek = stop old sources + rebuild 4 new ones.
 *  - loop/loopStart/loopEnd are hot-updatable on running sources (no rebuild).
 *  - playbackRate & detune are COUPLED (computedPlaybackRate = rate * 2^(detune/1200)),
 *    so independent tempo/pitch needs SoundTouch. If the worklet is unavailable we
 *    fall back to native playbackRate (tape varispeed): tempo works, pitch disabled.
 *
 * Per-stem graph:
 *   worklet mode : source -> worklet -> { gain -> master -> destination,
 *                                         analyser (leaf tap) }
 *   fallback     : source -> { gain -> master -> destination, analyser (leaf tap) }
 * The analyser taps PRE-gain so mute/solo does not blank the visualizer.
 */
(function (global) {
  "use strict";

  var STEMS = ["vocals", "drums", "bass", "other"];

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  function StemPlayerEngine() {
    this.ctx = null;
    this.master = null;
    this.masterAnalyser = null;
    this.hasWorklet = false;
    this.stems = {};           // name -> {buffer, gain, analyser, worklet, source}
    this.muteSolo = {};
    STEMS.forEach(function (n) { this.muteSolo[n] = { vol: 1.0, mute: false, solo: false }; }, this);
    this.duration = 0;
    this.playing = false;
    this.loop = false;
    this.loopStart = 0;
    this.loopEnd = 0;
    this.tempo = 1.0;          // 0.25..4.0 (1.0 = original)
    this.pitch = 0;           // cents (-1200..1200)
    this._bufPos = 0;
    this._playStartCtx = 0;
    this._playStartOffset = 0;
    this.onTick = null;       // (posSec) => void
    this.onEnd = null;        // () => void
    this.onState = null;      // (state) => void
    this._raf = null;
  }

  StemPlayerEngine.prototype.init = async function () {
    var Ctx = global.AudioContext || global.webkitAudioContext;
    this.ctx = new Ctx();
    this.master = this.ctx.createGain();
    this.master.gain.value = 1.0;
    this.master.connect(this.ctx.destination);
    this.masterAnalyser = this.ctx.createAnalyser();
    this.masterAnalyser.fftSize = 1024;
    this.master.connect(this.masterAnalyser);

    try {
      await this.ctx.audioWorklet.addModule("/static/js/soundtouch-processor.js");
      this.hasWorklet = await this._probeWorklet();
    } catch (e) {
      this.hasWorklet = false;
    }
    if (this.hasWorklet) console.log("[stem] SoundTouch worklet active — independent tempo/pitch");
    else console.warn("[stem] tape-varispeed fallback (tempo only, pitch disabled)");
  };

  StemPlayerEngine.prototype._probeWorklet = function () {
    var self = this;
    return new Promise(function (resolve) {
      try {
        var probe = new AudioWorkletNode(self.ctx, "soundtouch-processor");
        var to = setTimeout(function () {
          try { probe.disconnect(); } catch (e) {}
          resolve(false);
        }, 2000);
        probe.port.onmessage = function (e) {
          if (e.data && e.data.type === "ready") {
            clearTimeout(to);
            try { probe.disconnect(); } catch (e) {}
            resolve(!!e.data.hasST);
          }
        };
        probe.port.postMessage("ping");
      } catch (e) { resolve(false); }
    });
  };

  StemPlayerEngine.prototype._resume = function () {
    if (this.ctx && this.ctx.state === "suspended") this.ctx.resume();
  };

  StemPlayerEngine.prototype._createChain = function () {
    var st = { buffer: null, source: null };
    var gain = this.ctx.createGain();
    gain.gain.value = 1.0;
    var analyser = this.ctx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.82;
    gain.connect(this.master);
    st.gain = gain;
    st.analyser = analyser;
    if (this.hasWorklet) {
      var w = new AudioWorkletNode(this.ctx, "soundtouch-processor");
      w.parameters.get("tempo").value = this.tempo;
      w.parameters.get("pitch").value = this.pitch;
      w.connect(gain);
      w.connect(analyser);
      st.worklet = w;
    }
    return st;
  };

  StemPlayerEngine.prototype.loadStems = async function (urls) {
    var self = this;
    this._disposeSources();
    this._disposeChains();
    this.stems = {};
    this._setState("loading");
    var bufs = await Promise.all(STEMS.map(function (n) {
      return fetch(urls[n]).then(function (r) {
        if (!r.ok) throw new Error("Failed to load " + n + " stem (HTTP " + r.status + ")");
        return r.arrayBuffer();
      })
        .then(function (ab) { return self.ctx.decodeAudioData(ab); });
    }));
    this.duration = Math.max.apply(null, bufs.map(function (b) { return b.duration; }));
    STEMS.forEach(function (n, i) {
      var st = self._createChain();
      st.buffer = bufs[i];
      self.stems[n] = st;
    });
    this._bufPos = 0;
    this._setState("ready");
    this._applyGains();
  };

  StemPlayerEngine.prototype.loadStemBuffers = function (map) {
    this._disposeSources();
    this._disposeChains();
    this.stems = {};
    var self = this;
    this.duration = Math.max.apply(null, STEMS.map(function (n) { return map[n].duration; }));
    STEMS.forEach(function (n) {
      var st = self._createChain();
      st.buffer = map[n];
      self.stems[n] = st;
    });
    this._bufPos = 0;
    this._setState("ready");
    this._applyGains();
  };

  StemPlayerEngine.prototype._disposeSources = function () {
    var self = this;
    STEMS.forEach(function (n) {
      var st = self.stems[n];
      if (!st || !st.source) return;
      try { st.source.onended = null; st.source.stop(); } catch (e) {}
      try { st.source.disconnect(); } catch (e) {}
      st.source = null;
    });
  };

  StemPlayerEngine.prototype._disposeChains = function () {
    var self = this;
    STEMS.forEach(function (n) {
      var st = self.stems[n];
      if (!st) return;
      try { st.worklet && st.worklet.disconnect(); } catch (e) {}
      try { st.gain && st.gain.disconnect(); } catch (e) {}
      try { st.analyser && st.analyser.disconnect(); } catch (e) {}
    });
  };

  StemPlayerEngine.prototype.play = function (offset) {
    var self = this;
    if (this.playing) return;
    if (!this.duration) return;
    offset = (offset == null) ? (this._bufPos || 0) : offset;
    offset = clamp(offset, 0, this.duration);
    this._disposeSources();
    this._resume();
    var when = this.ctx.currentTime + 0.06;   // shared look-ahead => sync
    STEMS.forEach(function (n) {
      var st = self.stems[n];
      if (!st || !st.buffer) return;
      var s = self.ctx.createBufferSource();
      s.buffer = st.buffer;
      s.loop = self.loop;
      s.loopStart = self.loopStart;
      s.loopEnd = self.loopEnd;
      if (st.worklet) {
        s.connect(st.worklet);
      } else {
        s.playbackRate.value = self.tempo;
        s.connect(st.gain);
        s.connect(st.analyser);
      }
      s.onended = function () {
        st.source = null;
        if (!self._stopping) self._checkEnded();
      };
      s.start(when, offset);
      st.source = s;
    });
    this._playStartCtx = when;
    this._playStartOffset = offset;
    this.playing = true;
    this._stopping = false;
    this._setState("playing");
    this._startTick();
  };

  StemPlayerEngine.prototype.pause = function () {
    if (!this.playing) return;
    this._bufPos = this.getPosition();
    this._stopping = true;
    this.playing = false;
    this._disposeSources();
    this._stopTick();
    this._setState("paused");
  };

  StemPlayerEngine.prototype.stop = function () {
    this._bufPos = 0;
    this._stopping = true;
    this.playing = false;
    this._disposeSources();
    this._stopTick();
    this._setState("stopped");
  };

  StemPlayerEngine.prototype.seek = function (sec) {
    var was = this.playing;
    if (was) this.pause();
    this._bufPos = clamp(sec, 0, this.duration);
    if (was) this.play(this._bufPos);
    else this._emitTick();
  };

  StemPlayerEngine.prototype._checkEnded = function () {
    if (this.playing) {
      var allDone = STEMS.every(function (n) { var st = this.stems[n]; return !st || !st.source; }, this);
      if (allDone && !this.loop) {
        this.playing = false;
        this._bufPos = this.duration;
        this._stopTick();
        this._setState("ended");
        if (this.onEnd) this.onEnd();
      }
    }
  };

  StemPlayerEngine.prototype.getPosition = function () {
    if (!this.playing || !this._playStartCtx) return this._bufPos || 0;
    var rate = this.tempo;
    var p = this._playStartOffset + (this.ctx.currentTime - this._playStartCtx) * rate;
    if (this.loop && this.loopEnd > this.loopStart) {
      var span = this.loopEnd - this.loopStart;
      p = this.loopStart + (((p - this.loopStart) % span) + span) % span;
    }
    return clamp(p, 0, this.duration);
  };

  StemPlayerEngine.prototype.setLoop = function (lenSec) {
    if (!lenSec || lenSec <= 0) {
      this.loop = false;
    } else {
      this.loop = true;
      this.loopStart = this.getPosition();
      if (this.loopStart >= this.duration - 0.05) this.loopStart = 0;
      this.loopEnd = Math.min(this.loopStart + lenSec, this.duration);
    }
    var self = this;
    STEMS.forEach(function (n) {
      var s = self.stems[n] && self.stems[n].source;
      if (!s) return;
      s.loop = self.loop;
      s.loopStart = self.loopStart;
      s.loopEnd = self.loopEnd;
    });
  };

  StemPlayerEngine.prototype.setLoopOff = function () {
    this.loop = false;
    var self = this;
    STEMS.forEach(function (n) {
      var s = self.stems[n] && self.stems[n].source;
      if (s) s.loop = false;
    });
  };

  StemPlayerEngine.prototype.setStemVolume = function (name, vol) {
    if (!this.muteSolo[name]) return;
    this.muteSolo[name].vol = vol;
    this._applyGains();
  };
  StemPlayerEngine.prototype.toggleMute = function (name) {
    var ms = this.muteSolo[name]; if (!ms) return;
    ms.mute = !ms.mute;
    this._applyGains();
    return ms.mute;
  };
  StemPlayerEngine.prototype.toggleSolo = function (name) {
    var ms = this.muteSolo[name]; if (!ms) return;
    ms.solo = !ms.solo;
    this._applyGains();
    return ms.solo;
  };
  StemPlayerEngine.prototype._applyGains = function () {
    if (!this.ctx) return;
    var anySolo = false;
    var self = this;
    STEMS.forEach(function (n) { if (self.muteSolo[n] && self.muteSolo[n].solo) anySolo = true; });
    var t = this.ctx.currentTime;
    STEMS.forEach(function (n) {
      var st = self.stems[n]; if (!st) return;
      var ms = self.muteSolo[n];
      var g = ms.mute ? 0 : (anySolo && !ms.solo ? 0 : ms.vol);
      st.gain.gain.setTargetAtTime(g, t, 0.015);
    });
  };

  StemPlayerEngine.prototype.setTempo = function (t) {
    this.tempo = t;
    var self = this;
    STEMS.forEach(function (n) {
      var st = self.stems[n]; if (!st) return;
      if (st.worklet) st.worklet.parameters.get("tempo").value = t;
      else if (st.source) st.source.playbackRate.setTargetAtTime(t, self.ctx.currentTime, 0.02);
    });
  };

  StemPlayerEngine.prototype.setPitch = function (cents) {
    this.pitch = cents;
    if (!this.hasWorklet) return;
    var self = this;
    STEMS.forEach(function (n) {
      var st = self.stems[n];
      if (st && st.worklet) st.worklet.parameters.get("pitch").value = cents;
    });
  };

  StemPlayerEngine.prototype.getAnalyser = function (name) {
    var st = this.stems[name];
    return st ? st.analyser : null;
  };

  StemPlayerEngine.prototype._setState = function (s) {
    if (this.onState) this.onState(s);
  };

  StemPlayerEngine.prototype._startTick = function () {
    var self = this;
    if (this._raf) return;
    function loop() {
      self._emitTick();
      self._raf = requestAnimationFrame(loop);
    }
    this._raf = requestAnimationFrame(loop);
  };
  StemPlayerEngine.prototype._stopTick = function () {
    if (this._raf) { cancelAnimationFrame(this._raf); this._raf = null; }
  };
  StemPlayerEngine.prototype._emitTick = function () {
    if (this.onTick) this.onTick(this.getPosition());
  };

  StemPlayerEngine.prototype.dispose = function () {
    this._stopTick();
    this._disposeSources();
    this._disposeChains();
    if (this.ctx && this.ctx.state !== "closed") this.ctx.close();
  };

  global.StemPlayerEngine = StemPlayerEngine;
  global.STEM_STEMS = STEMS;
})(window);
