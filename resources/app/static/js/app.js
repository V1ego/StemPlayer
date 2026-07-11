/* app.js — main entry point / state machine for the Web Stem Player.
 *
 * Orchestrates: engine (audio), viz (generative art), ui (DOM controls).
 * Owns async flows: demo synthesis, file upload + Demucs separation polling.
 * Keyboard: Space = play/pause, Escape = close overlay.
 *
 * Per plan D6: transport visuals are driven solely by engine.onState.
 * Per plan D7: engine.onEnd resets playhead via seek(0) for replay safety.
 */
(function () {
  "use strict";

  var U = window.StemUtils;
  var Engine = window.StemPlayerEngine;

  var engine, viz, ui, neteaseUI;
  var pollTimer = null;
  var busy = false;

  // ---- playlist queue ----
  // Entry types: { type: 'job', jobId, name } | { type: 'demo', demo: {id,name,bpm} }
  var playlist = [];
  var currentIndex = -1;

  function ready(fn) {
    if (document.readyState !== "loading") fn();
    else document.addEventListener("DOMContentLoaded", fn);
  }

  ready(bootstrap);

  function bootstrap() {
    engine = new Engine();
    viz = window.createVisualizer(U.$("#viz-mount"));
    ui = new window.StemPlayerUI(engine);
    ui.bind();

    // NetEase Cloud Music
    neteaseUI = new window.NetEaseUI(ui);
    neteaseUI.bind();
    neteaseUI.onSongSelect = handleNetEaseSong;
    neteaseUI.onBatchComplete = handleBatchComplete;

    // ---- engine callbacks -> UI (D6) ----
    engine.onTick = function (pos) {
      ui.setProgress(pos);
    };
    engine.onState = function (s) {
      ui.setState(s);
    };
    engine.onEnd = function () {
      ui.setState("ended");
      engine.seek(0);  // D7: reset playhead so replay works
    };

    // ---- UI intents -> app async flows ----
    ui.onUploadFile = handleUpload;
    ui.onDemoSelect = handleDemo;
    ui.onPrev = handlePrev;
    ui.onNext = handleNext;

    // ---- keyboard (D6) ----
    U.on(document, "keydown", onKey);

    // ---- reduced motion (D13) ----
    if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      viz.frameRate(24);
    }

    // open source overlay immediately (nothing loaded yet)
    ui.openOverlay();

    // ---- init engine (async) ----
    engine.init().then(function () {
      viz.setEngine(engine);
      ui.setDuration(engine.duration || 0);
      loadDemoList();
    }).catch(function (err) {
      ui.showError("音频引擎启动失败：" + (err.message || err));
    });
  }

  // ---- keyboard ----

  function onKey(e) {
    // don't hijack form fields or buttons
    var t = e.target;
    if (t && t.closest && t.closest("input,textarea,select,button,[contenteditable='true']")) {
      // allow Escape on overlay backdrop
      if (e.key === "Escape" && !U.$("#source-overlay").hidden) {
        ui.closeOverlay();
      }
      return;
    }
    if (e.code === "Space") {
      e.preventDefault();
      if (engine.playing) engine.pause();
      else engine.play();
    } else if (e.key === "Escape" && !U.$("#source-overlay").hidden) {
      ui.closeOverlay();
    }
  }

  // ---- playlist helpers ----

  function updateNavButtons() {
    ui.setNavState(currentIndex > 0, currentIndex < playlist.length - 1);
  }

  function loadTrack(index) {
    if (busy || index < 0 || index >= playlist.length) return;
    var track = playlist[index];
    currentIndex = index;
    updateNavButtons();

    if (track.type === "demo") {
      busy = true;
      ui.showProcessing("合成 " + track.demo.name + " 中…", null);
      window.DemoSynth.build(track.demo.id).then(function (res) {
        engine.loadStemBuffers({
          vocals: res.vocals, drums: res.drums, bass: res.bass, other: res.other
        });
        ui.setDuration(engine.duration);
        ui.setTrackLabel(track.demo.name + "  -  " + res.bpm + " BPM");
        ui.hideProcessing();
        ui.closeOverlay();
        busy = false;
      }).catch(function (err) {
        ui.showError("示例加载失败：" + (err.message || err));
        ui.hideProcessing();
        busy = false;
      });
    } else if (track.type === "job") {
      busy = true;
      ui.showProcessing("加载 " + track.name + " 中…", 0);
      U.fetchJSON("/api/status/" + track.jobId).then(function (s) {
        if (s.status === "done" && s.stems) {
          ui.showProcessing("加载分轨中…", 100);
          return engine.loadStems(s.stems).then(function () {
            ui.setDuration(engine.duration);
            ui.setTrackLabel(track.name);
            ui.hideProcessing();
            ui.closeOverlay();
            busy = false;
            if (neteaseUI) neteaseUI.setBusy(false);
          });
        } else if (s.status === "error") {
          throw new Error(s.error || "分离失败");
        } else {
          // Still processing — poll
          ui.setTrackLabel(track.name);
          ui.showProcessing("分离中…", s.progress || 0);
          pollJob(track.jobId, track.name);
        }
      }).catch(function (err) {
        ui.showError(err.message || "加载失败");
        ui.hideProcessing();
        busy = false;
        if (neteaseUI) neteaseUI.setBusy(false);
      });
    }
  }

  function handlePrev() {
    if (busy || currentIndex <= 0) return;
    loadTrack(currentIndex - 1);
  }

  function handleNext() {
    if (busy || currentIndex >= playlist.length - 1) return;
    loadTrack(currentIndex + 1);
  }

  // ---- demo flow ----

  function handleDemo(demo) {
    if (busy) return;
    playlist = [{ type: "demo", demo: demo }];
    currentIndex = -1;
    loadTrack(0);
  }

  // ---- NetEase song flow ----

  function handleNetEaseSong(song) {
    if (busy) return;
    busy = true;
    neteaseUI.setBusy(true);
    ui.showProcessing("下载 " + song.name + " 中…", 0);

    var name = encodeURIComponent(song.name + " - " + song.artist);
    fetch("/api/netease/separate/" + song.id + "?name=" + name, {
      method: "POST",
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (data) {
        if (!r.ok) {
          var msg = data.error || "";
          throw new Error(msg || "下载失败（HTTP " + r.status + "），请稍后重试或更换歌曲");
        }
        if (data.error) throw new Error(data.error);
        return data;
      });
    }).then(function (data) {
      var trackName = data.track || song.name;
      playlist = [{ type: "job", jobId: data.job_id, name: trackName }];
      currentIndex = -1;
      busy = false;  // loadTrack will re-set busy
      loadTrack(0);
    }).catch(function (err) {
      ui.showError(err.message || "下载失败");
      ui.hideProcessing();
      busy = false;
      neteaseUI.setBusy(false);
    });
  }

  // ---- batch separation complete ----

  function handleBatchComplete(jobs) {
    if (!jobs || !jobs.length) return;
    // Add all batch jobs to the playlist for prev/next navigation
    playlist = jobs.map(function (job) {
      return { type: "job", jobId: job.job_id, name: job.track || "批量分离" };
    });
    currentIndex = -1;
    loadTrack(0);
  }

  // ---- upload + polling flow ----

  function handleUpload(file) {
    if (busy) return;
    busy = true;
    ui.showProcessing("上传中…", 0);

    var fd = new FormData();
    fd.append("audio", file);

    fetch("/api/separate", { method: "POST", body: fd }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (data) {
        if (!r.ok) {
          var msg = data.error || "";
          if (r.status === 413) msg = msg || "文件超过 80 MB 限制，请压缩或裁剪音频后重试";
          throw new Error(msg || "上传失败（HTTP " + r.status + "），请检查文件后重试");
        }
        if (data.error) throw new Error(data.error);
        return data;
      });
    }).then(function (data) {
      var trackName = data.track || "已上传曲目";
      playlist = [{ type: "job", jobId: data.job_id, name: trackName }];
      currentIndex = -1;
      busy = false;  // loadTrack will re-set busy
      loadTrack(0);
    }).catch(function (err) {
      ui.showError(err.message || "上传失败");
      ui.hideProcessing();
      busy = false;
    });
  }

  function pollJob(jobId, trackName) {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(function () {
      U.fetchJSON("/api/status/" + jobId).then(function (s) {
        if (s.status === "done") {
          clearInterval(pollTimer);
          pollTimer = null;
          ui.showProcessing("加载分轨中…", 100);
          return engine.loadStems(s.stems).then(function () {
            ui.setDuration(engine.duration);
            if (trackName) ui.setTrackLabel(trackName);
            ui.hideProcessing();
            ui.closeOverlay();
            busy = false;
            if (neteaseUI) neteaseUI.setBusy(false);
            updateNavButtons();
          });
        }
        if (s.status === "error") {
          clearInterval(pollTimer);
          pollTimer = null;
          ui.showError(s.error || "分离失败");
          ui.hideProcessing();
          busy = false;
          if (neteaseUI) neteaseUI.setBusy(false);
        } else {
          ui.showProcessing("分离中…", s.progress || 0);
        }
      }).catch(function (err) {
        clearInterval(pollTimer);
        pollTimer = null;
        ui.showError(err.message || "状态轮询失败");
        ui.hideProcessing();
        busy = false;
      });
    }, 1500);
  }

  // ---- demo list ----

  function loadDemoList() {
    U.fetchJSON("/api/demos").then(function (d) {
      ui.renderDemos(d.demos);
    }).catch(function () {
      // demos optional; silently ignore if backend unavailable
    });
  }
})();
