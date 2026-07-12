/* app.js — main entry point / state machine for the Web Stem Player.
 *
 * Orchestrates: engine (audio), viz (generative art), ui (DOM controls).
 * Owns async flows: demo synthesis, file upload + Demucs separation polling.
 * Keyboard: Space = play/pause, Escape = close overlay.
 *
 * Playlist panel: shows all queued tracks with status indicators.
 * Background pre-separation: while current track plays, next track is
 * separated in the background so it's ready when the user advances.
 *
 * Per plan D6: transport visuals are driven solely by engine.onState.
 * Per plan D7: engine.onEnd resets playhead via seek(0) for replay safety.
 */
(function () {
  "use strict";

  var U = window.StemUtils;
  var Engine = window.StemPlayerEngine;

  var engine, viz, ui, neteaseUI;
  var busy = false;

  // ---- playlist queue ----
  // Entry types:
  //   { type: 'demo', demo: {id,name,bpm}, status: 'ready' }
  //   { type: 'job', jobId, name, status: 'processing'|'ready', stemsUrl }
  //   { type: 'netease', songId, name, artist,
  //     status: 'pending'|'processing'|'ready'|'error',
  //     jobId, stemsUrl, _promise }
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
    neteaseUI.onPlayAll = handlePlayAll;

    // ---- engine callbacks -> UI (D6) ----
    engine.onTick = function (pos) {
      ui.setProgress(pos);
    };
    engine.onState = function (s) {
      ui.setState(s);
      // When playback starts, pre-separate the next track in background
      if (s === "playing") prefetchNext();
    };
    engine.onEnd = function () {
      ui.setState("ended");
      engine.seek(0);  // D7: reset playhead so replay works
      // Auto-advance to next track if available
      if (currentIndex >= 0 && currentIndex < playlist.length - 1) {
        loadTrack(currentIndex + 1, true);
      }
    };

    // ---- UI intents -> app async flows ----
    ui.onUploadFile = handleUpload;
    ui.onDemoSelect = handleDemo;
    ui.onPrev = handlePrev;
    ui.onNext = handleNext;
    ui.onPlaylistItem = handlePlaylistItem;
    ui.onPlaylistPlay = handlePlaylistPlay;

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

  function renderPlaylist() {
    ui.renderPlaylist(playlist, currentIndex);
  }

  function updateNavButtons() {
    ui.setNavState(currentIndex > 0, currentIndex < playlist.length - 1);
  }

  function isCurrentEntry(entry) {
    return currentIndex >= 0 && playlist[currentIndex] === entry;
  }

  /**
   * Poll /api/status/<jobId> until the job is done or errors.
   * Returns a Promise that resolves with the status object (includes stems).
   * onProgress is called with progress percentage for foreground display.
   */
  function pollJobStatus(jobId, onProgress) {
    return new Promise(function (resolve, reject) {
      function check() {
        U.fetchJSON("/api/status/" + jobId).then(function (s) {
          if (s.status === "done" && s.stems) {
            resolve(s);
          } else if (s.status === "error") {
            reject(new Error(s.error || "分离失败"));
          } else {
            if (onProgress) onProgress(s.progress || 0);
            setTimeout(check, 1500);
          }
        }).catch(reject);
      }
      check();
    });
  }

  /**
   * Ensure a playlist entry is separated and ready to play.
   * - If already ready (stemsUrl cached): resolve immediately.
   * - If a separation promise is already running: return it.
   * - For 'job' type: poll the existing server job.
   * - For 'netease' type with 'pending' status: start separation then poll.
   * Returns a Promise<stemsUrl>.
   */
  function ensureSeparated(entry) {
    if (entry.stemsUrl) return Promise.resolve(entry.stemsUrl);
    if (entry.status === "error") return Promise.reject(new Error(entry.error || "分离失败"));
    if (entry._promise) return entry._promise;

    if (entry.type === "job") {
      entry._promise = pollJobStatus(entry.jobId, function (progress) {
        if (isCurrentEntry(entry)) ui.showProcessing("分离中…", progress);
      }).then(function (s) {
        entry.status = "ready";
        entry.stemsUrl = s.stems;
        renderPlaylist();
        entry._promise = null;
        return s.stems;
      }).catch(function (err) {
        entry.status = "error";
        entry.error = err.message;
        renderPlaylist();
        entry._promise = null;
        throw err;
      });
      return entry._promise;
    }

    if (entry.type === "netease" && entry.status === "pending") {
      entry.status = "processing";
      renderPlaylist();

      var nameParam = encodeURIComponent(
        entry.name + (entry.artist ? " - " + entry.artist : "")
      );
      entry._promise = fetch(
        "/api/netease/separate/" + entry.songId + "?name=" + nameParam,
        { method: "POST" }
      ).then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (data) {
          if (!r.ok || data.error) throw new Error(data.error || "HTTP " + r.status);
          return data;
        });
      }).then(function (data) {
        entry.jobId = data.job_id;
        if (data.track) entry.name = data.track;
        renderPlaylist();
        return pollJobStatus(entry.jobId, function (progress) {
          if (isCurrentEntry(entry)) ui.showProcessing("分离中…", progress);
        });
      }).then(function (s) {
        entry.status = "ready";
        entry.stemsUrl = s.stems;
        renderPlaylist();
        entry._promise = null;
        return s.stems;
      }).catch(function (err) {
        entry.status = "error";
        entry.error = err.message;
        renderPlaylist();
        entry._promise = null;
        throw err;
      });
      return entry._promise;
    }

    // Fallback: treat as ready
    return Promise.resolve(null);
  }

  /**
   * Load a track by index. If autoPlay is true, start playback after loading.
   * For entries that aren't separated yet, starts/reuses separation first.
   */
  function loadTrack(index, autoPlay) {
    if (busy || index < 0 || index >= playlist.length) return;
    var entry = playlist[index];
    currentIndex = index;
    updateNavButtons();
    renderPlaylist();

    // ---- demo: synth on demand ----
    if (entry.type === "demo") {
      busy = true;
      ui.showProcessing("合成 " + entry.demo.name + " 中…", null);
      window.DemoSynth.build(entry.demo.id).then(function (res) {
        engine.loadStemBuffers({
          vocals: res.vocals, drums: res.drums, bass: res.bass, other: res.other
        });
        ui.setDuration(engine.duration);
        ui.setTrackLabel(entry.demo.name + "  -  " + res.bpm + " BPM");
        ui.hideProcessing();
        ui.closeOverlay();
        busy = false;
        entry.status = "ready";
        renderPlaylist();
        if (autoPlay) engine.play();
        // prefetchNext is called by engine.onState("playing") — no need to duplicate
      }).catch(function (err) {
        ui.showError("示例加载失败：" + (err.message || err));
        ui.hideProcessing();
        busy = false;
      });
      return;
    }

    // ---- job / netease: ensure separated, then load ----
    busy = true;

    // If already ready with stems cached, load immediately
    if (entry.stemsUrl) {
      loadStemsAndPlay(entry, autoPlay);
      return;
    }

    // Show processing UI for foreground track
    ui.showProcessing("加载 " + entry.name + " 中…", 0);

    ensureSeparated(entry).then(function (stems) {
      loadStemsAndPlay(entry, autoPlay);
    }).catch(function (err) {
      ui.showError(err.message || "加载失败");
      ui.hideProcessing();
      busy = false;
      if (neteaseUI) neteaseUI.setBusy(false);
    });
  }

  /**
   * Load stem URLs into the engine and optionally auto-play.
   */
  function loadStemsAndPlay(entry, autoPlay) {
    ui.showProcessing("加载分轨中…", 100);
    engine.loadStems(entry.stemsUrl).then(function () {
      ui.setDuration(engine.duration);
      ui.setTrackLabel(entry.name);
      ui.hideProcessing();
      ui.closeOverlay();
      busy = false;
      if (neteaseUI) neteaseUI.setBusy(false);
      renderPlaylist();
      if (autoPlay) engine.play();
      // prefetchNext is called by engine.onState("playing") — no need to duplicate here
    }).catch(function (err) {
      ui.showError(err.message || "加载分轨失败");
      ui.hideProcessing();
      busy = false;
      if (neteaseUI) neteaseUI.setBusy(false);
    });
  }

  /**
   * Background pre-separation: while the current track plays,
   * start separating the next track so it's ready when needed.
   */
  function prefetchNext() {
    if (currentIndex < 0 || currentIndex >= playlist.length - 1) return;
    var next = playlist[currentIndex + 1];
    if (!next) return;
    if (next.stemsUrl || next.status === "ready" || next._promise) return;

    // Fire and forget — don't block UI
    ensureSeparated(next).catch(function (err) {
      // Error already handled in ensureSeparated (sets status to 'error')
      console.warn("[playlist] background prefetch failed:", err.message);
    });
  }

  function handlePrev() {
    if (busy || currentIndex <= 0) return;
    loadTrack(currentIndex - 1, false);
  }

  function handleNext() {
    if (busy || currentIndex >= playlist.length - 1) return;
    loadTrack(currentIndex + 1, false);
  }

  // ---- playlist panel interactions ----

  function handlePlaylistItem(index) {
    if (busy || index === currentIndex) return;
    loadTrack(index, false);  // switch without auto-play
  }

  function handlePlaylistPlay(index) {
    if (busy) return;
    if (index === currentIndex) {
      // Already current track — just play/pause
      if (engine.playing) engine.pause();
      else engine.play();
      return;
    }
    loadTrack(index, true);  // load and auto-play
  }

  // ---- demo flow ----

  function handleDemo(demo) {
    if (busy) return;
    playlist = [{ type: "demo", demo: demo, name: demo.name, status: "ready" }];
    currentIndex = -1;
    ui.setPlaylistButton(true);
    renderPlaylist();
    loadTrack(0, false);
  }

  // ---- NetEase song flow (single song) ----

  function handleNetEaseSong(song) {
    if (busy) return;
    playlist = [{
      type: "netease",
      songId: song.id,
      name: song.name,
      artist: song.artist,
      status: "pending"
    }];
    currentIndex = -1;
    ui.setPlaylistButton(true);
    ui.showPlaylistPanel();
    renderPlaylist();
    loadTrack(0, true);  // auto-play
  }

  // ---- NetEase play all ----

  function handlePlayAll(tracks) {
    if (busy) return;
    if (!tracks || !tracks.length) return;
    playlist = tracks.map(function (track) {
      return {
        type: "netease",
        songId: track.id,
        name: track.name,
        artist: track.artist,
        status: "pending"
      };
    });
    currentIndex = -1;
    ui.setPlaylistButton(true);
    ui.showPlaylistPanel();
    renderPlaylist();
    ui.closeOverlay();
    loadTrack(0, true);  // auto-play first track
  }

  // ---- batch separation complete ----

  function handleBatchComplete(jobs) {
    if (!jobs || !jobs.length) return;
    // Add all batch jobs to the playlist for prev/next navigation
    playlist = jobs.map(function (job) {
      return {
        type: "job",
        jobId: job.job_id,
        name: job.track || "批量分离",
        status: "processing"
      };
    });
    currentIndex = -1;
    ui.setPlaylistButton(true);
    ui.showPlaylistPanel();
    renderPlaylist();
    loadTrack(0, false);
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
      playlist = [{
        type: "job",
        jobId: data.job_id,
        name: trackName,
        status: "processing"
      }];
      currentIndex = -1;
      ui.setPlaylistButton(true);
      renderPlaylist();
      busy = false;  // loadTrack will re-set busy
      loadTrack(0, false);
    }).catch(function (err) {
      ui.showError(err.message || "上传失败");
      ui.hideProcessing();
      busy = false;
    });
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