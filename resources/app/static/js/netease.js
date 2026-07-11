/* netease.js — NetEase Cloud Music integration for Web Stem Player.
 *
 * Handles: tab switching, QR code login flow, playlist browsing,
 * and triggering separation of NetEase songs.
 *
 * Public surface (consumed by app.js via window.NetEaseUI):
 *   new NetEaseUI(uiInstance)
 *     .bind()                      // attach DOM listeners
 *     .onSongSelect = null         // (song: {id, name, artist}) => void
 *     .setBusy(boolean)            // show/hide processing overlay
 */
(function (global) {
  "use strict";

  var U = global.StemUtils;

  // DOM helper: create element with class, optional attrs
  function el(tag, cls, attrs) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === "text") e.textContent = attrs[k];
      else if (k === "html") e.innerHTML = attrs[k];
      else e.setAttribute(k, attrs[k]);
    });
    return e;
  }

  function NetEaseUI(ui) {
    this.ui = ui;
    this.onSongSelect = null;
    this.onBatchComplete = null;
    this._unikey = null;
    this._qrPollTimer = null;
    this._currentPlaylist = null;
    this._currentTracks = null;
    this._busy = false;
    this.el = {};
  }

  NetEaseUI.prototype.bind = function () {
    var self = this;
    var e = this.el;

    e.tabBtns = U.$$(".tab-btn");
    e.tabPanels = U.$$(".tab-panel");
    e.loginSection = U.$("#netease-login");
    e.loggedInSection = U.$("#netease-logged-in");
    e.tracksView = U.$("#netease-tracks-view");
    e.qrDiv = U.$("#netease-qr");
    e.qrStatus = U.$("#netease-qr-status");
    e.qrRefresh = U.$("#netease-qr-refresh");
    e.avatar = U.$("#netease-avatar");
    e.nickname = U.$("#netease-nickname");
    e.logoutBtn = U.$("#netease-logout-btn");
    e.playlists = U.$("#netease-playlists");
    e.playlistsCount = U.$("#netease-playlists-count");
    e.tracks = U.$("#netease-tracks");
    e.playlistName = U.$("#netease-playlist-name");
    e.backBtn = U.$("#netease-back-btn");
    e.selectAll = U.$("#netease-select-all");
    e.batchCount = U.$("#netease-batch-count");
    e.batchBtn = U.$("#netease-batch-btn");
    e.batchProgress = U.$("#netease-batch-progress");
    e.batchFill = U.$("#netease-batch-fill");
    e.batchPct = U.$("#netease-batch-pct");
    e.batchMsg = U.$("#netease-batch-msg");

    e.tabBtns.forEach(function (btn) {
      U.on(btn, "click", function () { self._switchTab(btn.getAttribute("data-tab")); });
    });
    U.on(e.qrRefresh, "click", function () { self._createQR(); });
    U.on(e.logoutBtn, "click", function () { self._logout(); });
    U.on(e.backBtn, "click", function () { self._showPlaylists(); });
    U.on(e.selectAll, "change", function () {
      var checked = e.selectAll.checked;
      var boxes = U.$$(".track-item__check", e.tracks);
      var count = 0;
      boxes.forEach(function (box) { box.checked = checked; if (checked) count++; });
      e.batchCount.textContent = "已选 " + count + " 首";
      e.batchBtn.disabled = count === 0 || self._busy;
    });
    U.on(e.batchBtn, "click", function () { self._startBatchSeparation(); });

    this._checkStatus();
  };

  NetEaseUI.prototype._updateBatchCount = function () {
    var e = this.el;
    var count = 0;
    U.$$(".track-item__check", e.tracks).forEach(function (b) { if (b.checked) count++; });
    e.batchCount.textContent = "已选 " + count + " 首";
    e.batchBtn.disabled = count === 0 || this._busy;
  };

  NetEaseUI.prototype._switchTab = function (tabName) {
    var e = this.el;
    e.tabBtns.forEach(function (btn) {
      var active = btn.getAttribute("data-tab") === tabName;
      btn.classList.toggle("tab-btn--active", active);
      btn.setAttribute("aria-selected", String(active));
    });
    e.tabPanels.forEach(function (panel) {
      var show = panel.getAttribute("data-panel") === tabName;
      panel.hidden = !show;
      panel.classList.toggle("tab-panel--active", show);
    });
  };

  // ---- Login status ----

  NetEaseUI.prototype._checkStatus = function () {
    var self = this;
    try {
      var cached = localStorage.getItem("netease_user");
      if (cached) self._showLoggedIn(JSON.parse(cached));
    } catch (e) { /* ignore */ }

    U.fetchJSON("/api/netease/status").then(function (data) {
      if (data.logged_in) {
        try { localStorage.setItem("netease_user", JSON.stringify(data.user)); } catch (e) {}
        self._showLoggedIn(data.user);
      } else {
        try { localStorage.removeItem("netease_user"); } catch (e) {}
        self._showLogin();
      }
    }).catch(function () {
      var cached = null;
      try { cached = localStorage.getItem("netease_user"); } catch (e) {}
      if (!cached) self._showLogin();
    });
  };

  NetEaseUI.prototype._showLogin = function () {
    var e = this.el;
    e.loginSection.hidden = false;
    e.loggedInSection.hidden = true;
    e.tracksView.hidden = true;
    if (!this._unikey) this._createQR();
  };

  NetEaseUI.prototype._showLoggedIn = function (user) {
    var e = this.el;
    e.loginSection.hidden = true;
    e.loggedInSection.hidden = false;
    e.tracksView.hidden = true;
    if (user) {
      e.nickname.textContent = user.nickname || "用户";
      if (user.avatar) e.avatar.src = user.avatar + "?param=80y80";
    }
    this._loadPlaylists();
  };

  // ---- QR Code login ----

  NetEaseUI.prototype._createQR = function () {
    var self = this;
    var e = this.el;

    this._stopQRPoll();
    e.qrDiv.innerHTML = "";
    e.qrStatus.hidden = false;
    e.qrStatus.textContent = "生成二维码中…";
    e.qrRefresh.hidden = true;

    U.fetchJSON("/api/netease/qr/create", { method: "POST" }).then(function (data) {
      if (data.error) {
        e.qrStatus.textContent = "生成失败: " + data.error + "，请点击刷新重试";
        e.qrRefresh.hidden = false;
        return;
      }
      self._unikey = data.unikey;
      if (!data.qr_img) {
        e.qrStatus.textContent = "二维码生成失败";
        e.qrRefresh.hidden = false;
        return;
      }
      var img = el("img", null, {
        src: data.qr_img, width: "176", height: "176",
        alt: "网易云音乐登录二维码", style: "width:100%;height:100%;image-rendering:pixelated"
      });
      e.qrDiv.appendChild(img);
      e.qrStatus.textContent = "请使用网易云音乐 App 扫码登录";
      e.qrRefresh.hidden = false;
      self._startQRPoll();
    }).catch(function (err) {
      e.qrStatus.textContent = "网络错误: " + (err.message || err) + "，请检查网络后点击刷新重试";
      e.qrRefresh.hidden = false;
    });
  };

  NetEaseUI.prototype._startQRPoll = function () {
    var self = this;
    var e = this.el;
    var attempts = 0;

    this._stopQRPoll();
    this._qrPollTimer = setInterval(function () {
      if (++attempts > 120) {
        self._stopQRPoll();
        e.qrStatus.textContent = "二维码已过期，请刷新";
        return;
      }

      U.fetchJSON("/api/netease/qr/check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ unikey: self._unikey }),
      }).then(function (data) {
        if (data.code === 803) {
          self._stopQRPoll();
          self._unikey = null;
          e.qrStatus.textContent = "登录成功！";
          if (data.user) {
            try { localStorage.setItem("netease_user", JSON.stringify(data.user)); } catch (e2) {}
          }
          setTimeout(function () { self._showLoggedIn(data.user); }, 500);
        } else if (data.code === 800) {
          self._stopQRPoll();
          self._unikey = null;
          e.qrStatus.textContent = "二维码已过期，正在刷新…";
          setTimeout(function () { self._createQR(); }, 1000);
        } else if (data.code === 802) {
          e.qrStatus.textContent = "已扫码，请在手机上确认";
        } else if (data.message) {
          e.qrStatus.textContent = data.message;
        }
      }).catch(function () { /* transient errors ignored */ });
    }, 2000);
  };

  NetEaseUI.prototype._stopQRPoll = function () {
    if (this._qrPollTimer) {
      clearInterval(this._qrPollTimer);
      this._qrPollTimer = null;
    }
  };

  // ---- Logout ----

  NetEaseUI.prototype._logout = function () {
    var self = this;
    var handler = function () {
      try { localStorage.removeItem("netease_user"); } catch (e) {}
      self._showLogin();
    };
    U.fetchJSON("/api/netease/logout", { method: "POST" }).then(handler).catch(handler);
  };

  // ---- Playlists ----

  NetEaseUI.prototype._loadPlaylists = function () {
    var self = this;
    var e = this.el;
    e.playlists.innerHTML = '<p class="netease__loading">加载中…</p>';

    U.fetchJSON("/api/netease/playlists").then(function (data) {
      if (data.error) {
        e.playlists.innerHTML = '<p class="netease__error">加载失败: ' + data.error + '</p>';
        return;
      }
      var playlists = data.playlists || [];
      e.playlistsCount.textContent = playlists.length + " 个";
      self._renderPlaylists(playlists);
    }).catch(function (err) {
      e.playlists.innerHTML = '<p class="netease__error">加载失败: ' + (err.message || err) + '</p>';
    });
  };

  NetEaseUI.prototype._renderPlaylists = function (playlists) {
    var self = this;
    var e = this.el;
    e.playlists.innerHTML = "";

    if (!playlists.length) {
      e.playlists.innerHTML = '<p class="netease__empty">暂无歌单</p>';
      return;
    }

    playlists.forEach(function (pl) {
      var label = pl.is_own ? "自建歌单" : "收藏歌单";
      var item = el("button", "playlist-item", {
        type: "button", "data-playlist-id": pl.id,
        "aria-label": pl.name + "（" + label + "，" + pl.track_count + " 首）"
      });

      var cover = el("div", "playlist-item__cover");
      if (pl.cover) {
        cover.appendChild(el("img", null, {
          src: pl.cover + "?param=120y120", alt: pl.name,
          width: "48", height: "48", loading: "lazy"
        }));
      }
      cover.appendChild(el("span", "playlist-item__count nums", { text: pl.track_count }));

      var info = el("div", "playlist-item__info");
      info.appendChild(el("span", "playlist-item__name", { text: pl.name }));
      info.appendChild(el("span", "playlist-item__meta", { text: label }));

      item.appendChild(cover);
      item.appendChild(info);
      U.on(item, "click", function () { self._openPlaylist(pl); });
      e.playlists.appendChild(item);
    });
  };

  // ---- Playlist tracks ----

  NetEaseUI.prototype._openPlaylist = function (playlist) {
    var self = this;
    var e = this.el;
    this._currentPlaylist = playlist;

    e.loggedInSection.hidden = true;
    e.tracksView.hidden = false;
    e.playlistName.textContent = playlist.name;
    e.tracks.innerHTML = '<p class="netease__loading">加载歌曲中…</p>';

    U.fetchJSON("/api/netease/playlist/" + playlist.id).then(function (data) {
      if (data.error) {
        e.tracks.innerHTML = '<p class="netease__error">加载失败: ' + data.error + '</p>';
        return;
      }
      self._renderTracks(data.tracks || []);
    }).catch(function (err) {
      e.tracks.innerHTML = '<p class="netease__error">加载失败: ' + (err.message || err) + '</p>';
    });
  };

  NetEaseUI.prototype._renderTracks = function (tracks) {
    var self = this;
    var e = this.el;
    e.tracks.innerHTML = "";
    e.selectAll.checked = false;
    e.batchBtn.disabled = true;
    e.batchCount.textContent = "已选 0 首";

    if (!tracks.length) {
      e.tracks.innerHTML = '<p class="netease__empty">歌单为空</p>';
      return;
    }

    self._currentTracks = tracks;

    tracks.forEach(function (track, idx) {
      var item = el("div", "track-item");

      var check = el("input", "track-item__check", {
        type: "checkbox", "data-track-idx": idx,
        "aria-label": "选择 " + track.name + " - " + track.artist
      });
      U.on(check, "change", function () { self._updateBatchCount(); });
      item.appendChild(check);

      item.appendChild(el("span", "track-item__num nums", { text: idx + 1 }));

      if (track.cover) {
        item.appendChild(el("img", "track-item__cover", {
          src: track.cover + "?param=80y80", alt: "",
          width: "36", height: "36", loading: "lazy"
        }));
      }

      var info = el("div", "track-item__info");
      info.appendChild(el("span", "track-item__name", { text: track.name }));
      info.appendChild(el("span", "track-item__artist", { text: track.artist }));
      item.appendChild(info);

      item.appendChild(el("span", "track-item__dur nums", { text: U.formatTime(track.duration) }));

      var btn = el("button", "btn btn--tag track-item__btn", {
        type: "button", text: "分离", "aria-label": "分离 " + track.name
      });
      U.on(btn, "click", function (ev) { ev.stopPropagation(); self._selectSong(track); });
      item.appendChild(btn);

      e.tracks.appendChild(item);
    });
  };

  NetEaseUI.prototype._showPlaylists = function () {
    this.el.tracksView.hidden = true;
    this.el.loggedInSection.hidden = false;
    this._currentPlaylist = null;
  };

  // ---- Batch separation ----

  NetEaseUI.prototype._startBatchSeparation = function () {
    var self = this;
    var e = this.el;
    if (this._busy) return;

    var selected = [];
    U.$$(".track-item__check", e.tracks).forEach(function (box) {
      if (box.checked) {
        var idx = parseInt(box.getAttribute("data-track-idx"), 10);
        if (self._currentTracks && self._currentTracks[idx]) {
          selected.push(self._currentTracks[idx]);
        }
      }
    });

    if (selected.length === 0) return;

    this._busy = true;
    this.setBusy(true);
    e.batchBtn.disabled = true;
    e.batchProgress.hidden = false;
    e.batchFill.style.transform = "scaleX(0)";
    e.batchPct.textContent = "0%";

    var total = selected.length;
    var failed = [];
    var completedJobs = [];

    function processNext(i) {
      if (i >= total) {
        e.batchFill.style.transform = "scaleX(1)";
        e.batchPct.textContent = "100%";
        if (failed.length > 0) {
          e.batchMsg.textContent = "完成 " + (total - failed.length) + "/" + total + " 首，" + failed.length + " 首失败，可重新勾选失败项后再试";
        } else {
          e.batchMsg.textContent = "全部完成！共 " + total + " 首";
        }
        self._busy = false;
        self.setBusy(false);
        e.batchBtn.disabled = false;
        if (completedJobs.length > 0 && typeof self.onBatchComplete === "function") {
          self.onBatchComplete(completedJobs);
        }
        return;
      }

      var track = selected[i];
      var pct = Math.round((i / total) * 100);
      e.batchFill.style.transform = "scaleX(" + (pct / 100) + ")";
      e.batchPct.textContent = pct + "%";
      e.batchMsg.textContent = "正在处理 " + (i + 1) + "/" + total + ": " + track.name;

      var name = encodeURIComponent(track.name + " - " + track.artist);
      fetch("/api/netease/separate/" + track.id + "?name=" + name, { method: "POST" })
        .then(function (r) {
          return r.json().catch(function () { return {}; }).then(function (data) {
            if (!r.ok || data.error) throw new Error(data.error || "HTTP " + r.status);
            return data;
          });
        }).then(function (data) {
          completedJobs.push(data);
          processNext(i + 1);
        }).catch(function (err) {
          failed.push({ track: track, error: err.message });
          processNext(i + 1);
        });
    }

    processNext(0);
  };

  // ---- Song selection ----

  NetEaseUI.prototype._selectSong = function (song) {
    if (this._busy) return;
    if (typeof this.onSongSelect === "function") this.onSongSelect(song);
  };

  NetEaseUI.prototype.setBusy = function (busy) {
    this._busy = !!busy;
  };

  global.NetEaseUI = NetEaseUI;
})(window);
