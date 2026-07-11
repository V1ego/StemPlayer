/* ui.js — DOM controller for the Web Stem Player.
 *
 * Architecture (plan D5):
 *  - UI calls engine directly for real-time audio controls (volume/mute/solo/
 *    play/stop/seek).
 *  - UI emits intents to app.js only for async flows (file upload, demo select).
 *
 * Public surface (consumed by app.js):
 *  new StemPlayerUI(engine)
 *  .onUploadFile = null    // (file: File) => void
 *  .onDemoSelect = null    // (demo: {id,name,bpm}) => void
 *  .onPrev = null           // () => void — go to previous track
 *  .onNext = null           // () => void — go to next track
 *  .bind()                 // query DOM + attach listeners (call once after DOM ready)
 *  .setState(s)             // 'loading'|'ready'|'playing'|'paused'|'stopped'|'ended'
 *  .setProgress(pos)       // called from engine.onTick
 *  .setDuration(dur)       // set seek.max + total time
 *  .setTrackLabel(name)
 *  .setNavState(canPrev, canNext)  // enable/disable prev/next buttons
 *  .openOverlay() / .closeOverlay()
 *    .renderDemos(demos)     // build demo buttons
 *    .showProcessing(msg, pct) / .hideProcessing()
 *    .showError(msg)
 */
(function (global) {
  "use strict";

  var U = global.StemUtils;
  var STEMS = global.STEM_STEMS;

  function StemPlayerUI(engine) {
    this.engine = engine;
    this.onUploadFile = null;
    this.onDemoSelect = null;
    this.onPrev = null;
    this.onNext = null;

    this._programmaticSeek = false;
    this._seeking = false;
    this._toastT = null;

    // element refs (populated in bind)
    this.el = {};
  }

  StemPlayerUI.prototype.bind = function () {
    var self = this;
    var e = this.el;

    // cache elements
    e.overlay = U.$("#source-overlay");
    e.overlayClose = U.$("#overlay-close");
    e.btnSource = U.$("#btn-source");
    e.btnPlay = U.$("#btn-play");
    e.btnStop = U.$("#btn-stop");
    e.btnPrev = U.$("#btn-prev");
    e.btnNext = U.$("#btn-next");
    e.seek = U.$("#seek");
    e.timeCurrent = U.$("#time-current");
    e.timeTotal = U.$("#time-total");
    e.trackLabel = U.$("#track-label");
    e.uploadZone = U.$("#upload-zone");
    e.fileInput = U.$("#file-input");
    e.uploadStatus = U.$("#upload-status");
    e.uploadMsg = U.$("#upload-msg");
    e.uploadBarFill = U.$("#upload-bar-fill");
    e.uploadPct = U.$("#upload-pct");
    e.demoList = U.$("#demo-list");
    e.demoNote = U.$("#demo-note");
    e.toast = U.$("#toast");

    // ---- stem volume step buttons (5 discrete levels: 0/25/50/75/100) ----
    // Supports both click (tap) and drag-to-scrub across buttons.
    // Per client-event-listeners: document listeners only during active drag.
    U.$$(".stem__steps").forEach(function (steps) {
      var name = steps.getAttribute("data-stem");
      var vol = parseFloat(steps.getAttribute("data-vol") || "1");
      self._setStepVisual(steps, vol);

      function applyVol(v) {
        self._setStepVisual(steps, v);
        self.engine.setStemVolume(name, v);
      }

      // click still works for simple taps
      U.$$(".btn--step", steps).forEach(function (btn) {
        U.on(btn, "click", function () {
          applyVol(parseFloat(btn.getAttribute("data-vol")));
        });
      });

      // drag-to-scrub: press on a button, move across siblings
      var dragging = false;

      function btnFromPoint(clientX, clientY) {
        var el = document.elementFromPoint(clientX, clientY);
        if (el && el.classList && el.classList.contains("btn--step") &&
            steps.contains(el)) {
          return el;
        }
        return null;
      }

      function onMove(e) {
        if (!dragging) return;
        e.preventDefault();
        var cx = (e.touches && e.touches.length) ? e.touches[0].clientX : e.clientX;
        var cy = (e.touches && e.touches.length) ? e.touches[0].clientY : e.clientY;
        var btn = btnFromPoint(cx, cy);
        if (btn) applyVol(parseFloat(btn.getAttribute("data-vol")));
      }

      function onEnd() {
        if (!dragging) return;
        dragging = false;
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onEnd);
        document.removeEventListener("touchmove", onMove);
        document.removeEventListener("touchend", onEnd);
      }

      U.on(steps, "mousedown", function (e) {
        if (!e.target.classList || !e.target.classList.contains("btn--step")) return;
        dragging = true;
        // immediately apply the pressed button
        onMove(e);
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onEnd);
        document.addEventListener("touchmove", onMove, { passive: false });
        document.addEventListener("touchend", onEnd);
      });

      U.on(steps, "touchstart", function (e) {
        if (!e.target.classList || !e.target.classList.contains("btn--step")) return;
        dragging = true;
        onMove(e);
        document.addEventListener("touchmove", onMove, { passive: false });
        document.addEventListener("touchend", onEnd);
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onEnd);
      }, { passive: false });
    });

    // ---- mute / solo ----
    U.$$("[data-mute]").forEach(function (btn) {
      var name = btn.getAttribute("data-mute");
      U.on(btn, "click", function () {
        var muted = self.engine.toggleMute(name);
        btn.setAttribute("aria-pressed", String(muted));
        btn.classList.toggle("btn--active", muted);
      });
    });
    U.$$("[data-solo]").forEach(function (btn) {
      var name = btn.getAttribute("data-solo");
      U.on(btn, "click", function () {
        var solo = self.engine.toggleSolo(name);
        btn.setAttribute("aria-pressed", String(solo));
        btn.classList.toggle("btn--active", solo);
      });
    });

    // ---- transport ----
    U.on(e.btnPlay, "click", function () {
      if (self.engine.playing) self.engine.pause();
      else self.engine.play();
    });
    U.on(e.btnStop, "click", function () {
      self.engine.stop();
    });
    U.on(e.btnPrev, "click", function () {
      if (typeof self.onPrev === "function") self.onPrev();
    });
    U.on(e.btnNext, "click", function () {
      if (typeof self.onNext === "function") self.onNext();
    });

    // ---- seek bar ----
    U.on(e.seek, "pointerdown", function () { self._seeking = true; });
    U.on(e.seek, "pointerup", function () { self._seeking = false; });
    U.on(e.seek, "pointercancel", function () { self._seeking = false; });
    U.on(e.seek, "input", function () {
      if (self._programmaticSeek) return;
      self.engine.seek(parseFloat(e.seek.value));
    });

    // ---- source overlay ----
    U.on(e.btnSource, "click", function () { self.openOverlay(); });
    U.on(e.overlayClose, "click", function () { self.closeOverlay(); });
    U.on(U.$(".overlay__backdrop"), "click", function () { self.closeOverlay(); });

    // Escape to close overlay
    U.on(document, "keydown", function (ev) {
      if (ev.key === "Escape" && !e.overlay.hidden) {
        self.closeOverlay();
      }
    });

    // ---- upload zone ----
    U.on(e.uploadZone, "click", function () { e.fileInput.click(); });
    U.on(e.uploadZone, "keydown", function (ev) {
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        e.fileInput.click();
      }
    });
    U.on(e.uploadZone, "dragenter", function (ev) {
      ev.preventDefault();
      e.uploadZone.classList.add("upload__zone--drag");
    });
    U.on(e.uploadZone, "dragover", function (ev) {
      ev.preventDefault();
    });
    U.on(e.uploadZone, "dragleave", function (ev) {
      ev.preventDefault();
      e.uploadZone.classList.remove("upload__zone--drag");
    });
    U.on(e.uploadZone, "drop", function (ev) {
      ev.preventDefault();
      e.uploadZone.classList.remove("upload__zone--drag");
      var file = ev.dataTransfer.files[0];
      if (file && typeof self.onUploadFile === "function") {
        self.onUploadFile(file);
      }
    });
    U.on(e.fileInput, "change", function () {
      if (e.fileInput.files && e.fileInput.files[0]) {
        if (typeof self.onUploadFile === "function") {
          self.onUploadFile(e.fileInput.files[0]);
        }
      }
      e.fileInput.value = "";
    });
  };

  // ---- state-driven updates ----

  StemPlayerUI.prototype.setState = function (s) {
    var e = this.el;
    var canPlay = (s === "ready" || s === "playing" || s === "paused" ||
                   s === "stopped" || s === "ended");
    e.btnPlay.disabled = !canPlay;
    e.btnStop.disabled = !canPlay;
    e.seek.disabled = !canPlay;

    // play/pause icon swap
    if (s === "playing") {
      U.$(".icon--play", e.btnPlay).hidden = true;
      U.$(".icon--pause", e.btnPlay).hidden = false;
      e.btnPlay.setAttribute("aria-label", "暂停");
    } else {
      U.$(".icon--play", e.btnPlay).hidden = false;
      U.$(".icon--pause", e.btnPlay).hidden = true;
      e.btnPlay.setAttribute("aria-label", "播放");
    }
  };

  StemPlayerUI.prototype.setProgress = function (pos) {
    var e = this.el;
    if (!this._seeking) {
      this._programmaticSeek = true;
      e.seek.value = pos;
      this._programmaticSeek = false;
    }
    e.timeCurrent.textContent = U.formatTime(pos);
  };

  StemPlayerUI.prototype.setDuration = function (dur) {
    var e = this.el;
    e.seek.max = dur || 1;
    e.timeTotal.textContent = U.formatTime(dur || 0);
  };

  StemPlayerUI.prototype.setTrackLabel = function (name) {
    this.el.trackLabel.textContent = name || "未加载曲目";
  };

  // Enable/disable prev/next nav buttons based on playlist position
  StemPlayerUI.prototype.setNavState = function (canPrev, canNext) {
    var e = this.el;
    e.btnPrev.disabled = !canPrev;
    e.btnNext.disabled = !canNext;
  };

  // ---- overlay ----

  StemPlayerUI.prototype.openOverlay = function () {
    var e = this.el;
    e.overlay.hidden = false;
    // focus first focusable element inside overlay
    var focusable = e.overlayClose;
    if (focusable) focusable.focus();
  };

  StemPlayerUI.prototype.closeOverlay = function () {
    var e = this.el;
    e.overlay.hidden = true;
    if (e.btnSource) e.btnSource.focus();
  };

  // ---- demos ----

  StemPlayerUI.prototype.renderDemos = function (demos) {
    var self = this;
    var e = this.el;
    e.demoList.innerHTML = "";
    (demos || []).forEach(function (demo) {
      var btn = document.createElement("button");
      btn.className = "demo-btn";
      btn.type = "button";
      btn.setAttribute("data-demo-id", demo.id);

      var name = document.createElement("span");
      name.className = "demo-btn__name";
      name.textContent = demo.name;

      var meta = document.createElement("span");
      meta.className = "demo-btn__meta";
      meta.textContent = demo.bpm + " BPM";

      btn.appendChild(name);
      btn.appendChild(meta);

      U.on(btn, "click", function () {
        if (typeof self.onDemoSelect === "function") {
          self.onDemoSelect({ id: demo.id, name: demo.name, bpm: demo.bpm });
        }
      });
      e.demoList.appendChild(btn);
    });
  };

  // ---- processing / errors ----

  StemPlayerUI.prototype.showProcessing = function (msg, pct) {
    var e = this.el;
    e.uploadZone.hidden = true;
    e.uploadStatus.hidden = false;
    e.uploadMsg.textContent = msg || "处理中...";
    if (pct != null) {
      e.uploadBarFill.style.width = pct + "%";
      e.uploadPct.textContent = pct + "%";
    }
  };

  StemPlayerUI.prototype.hideProcessing = function () {
    var e = this.el;
    e.uploadStatus.hidden = true;
    e.uploadBarFill.style.width = "0%";
    e.uploadPct.textContent = "0%";
    e.uploadZone.hidden = false;
  };

  StemPlayerUI.prototype.showError = function (msg) {
    var self = this;
    var e = this.el;
    e.toast.textContent = msg;
    e.toast.hidden = false;
    clearTimeout(this._toastT);
    this._toastT = setTimeout(function () {
      e.toast.hidden = true;
    }, 4000);
  };

  // ---- internal helpers ----

  // Update step button visuals: light up buttons at or below vol,
  // mark the exact selected button as active.
  StemPlayerUI.prototype._setStepVisual = function (steps, vol) {
    steps.setAttribute("data-vol", vol);
    var btns = U.$$(".btn--step", steps);
    btns.forEach(function (btn) {
      var btnVol = parseFloat(btn.getAttribute("data-vol"));
      var lit = btnVol <= vol + 0.001;
      var active = Math.abs(btnVol - vol) < 0.001;
      btn.classList.toggle("step--lit", lit);
      btn.classList.toggle("step--active", active);
    });
  };

  global.StemPlayerUI = StemPlayerUI;
})(window);
