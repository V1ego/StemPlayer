"""Flask application factory and routes."""
from pathlib import Path
from uuid import uuid4

import requests
from flask import Flask, request, jsonify, send_from_directory, abort

from . import jobs
from .ncm import decrypt_ncm
from .config import STATIC_DIR, JOBS_DIR, ALLOWED_EXT, MAX_UPLOAD_MB, STEMS, DATA_DIR
from .utils import allowed_file, clean_track_name

_NETEASE_PROXY = "http://127.0.0.1:4000"


def create_app() -> Flask:
    app = Flask(__name__, static_folder=str(STATIC_DIR), static_url_path="/static")
    app.config["MAX_CONTENT_LENGTH"] = MAX_UPLOAD_MB * 1024 * 1024

    @app.route("/")
    def index():
        return send_from_directory(str(STATIC_DIR), "index.html")

    @app.post("/api/separate")
    def separate():
        f = request.files.get("audio")
        if not f or not f.filename:
            return jsonify({"error": "no audio file provided"}), 400
        if not allowed_file(f.filename, ALLOWED_EXT):
            ext = Path(f.filename).suffix.lower()
            return jsonify({"error": f"不支持的格式 .{ext}"}), 400

        ext = Path(f.filename).suffix.lower().lstrip(".")
        job_id = uuid4().hex
        job_dir = JOBS_DIR / job_id
        job_dir.mkdir(parents=True, exist_ok=True)
        input_path = job_dir / f"input.{ext}"
        f.save(str(input_path))

        track_name = clean_track_name(f.filename)

        if ext == "ncm":
            try:
                decrypted, meta = decrypt_ncm(input_path, output_dir=job_dir)
                input_path = decrypted
                if meta and meta.get("musicName"):
                    track_name = clean_track_name(meta["musicName"])
            except (ValueError, OSError) as exc:
                return jsonify({"error": f"NCM 解密失败: {exc}"}), 400

        jobs.enqueue(job_id, str(input_path), track_name, str(job_dir))
        return jsonify({"job_id": job_id, "status": "processing", "track": track_name})

    @app.get("/api/status/<job_id>")
    def status(job_id: str):
        job = jobs.list_status(job_id)
        if not job:
            return jsonify({"error": "job not found"}), 404
        resp: dict = {
            "status": job["status"],
            "progress": job.get("progress", 0),
            "error": job.get("error"),
        }
        if job["status"] == "done":
            resp["stems"] = {s: f"/api/stems/{job_id}/{s}" for s in STEMS}
            resp["track"] = job.get("track_name")
        return jsonify(resp)

    @app.get("/api/stems/<job_id>/<stem>")
    def serve_stem(job_id: str, stem: str):
        if stem not in STEMS:
            abort(404)
        job = jobs.list_status(job_id)
        if not job or job["status"] != "done" or not job.get("stems"):
            abort(404)
        stem_path = Path(job["stems"].get(stem, ""))
        if not stem_path.exists():
            abort(404)
        return send_from_directory(str(stem_path.parent), stem_path.name)

    @app.get("/api/demos")
    def demos():
        return jsonify({"demos": [
            {"id": "nocturne", "name": "夜曲", "bpm": 92, "bars": 16, "palette": "amber"},
            {"id": "punch", "name": "冲击 808", "bpm": 120, "bars": 16, "palette": "acid"},
        ]})

    # ---- NetEase Cloud Music proxy ----

    def _proxy(proxy_path: str, method: str = "GET", json_body: dict | None = None,
               params: dict | None = None):
        url = f"{_NETEASE_PROXY}{proxy_path}"
        try:
            if method == "GET":
                r = requests.get(url, params=params, timeout=15)
            else:
                r = requests.post(url, json=json_body or {}, timeout=15)
            return jsonify(r.json()), r.status_code
        except requests.ConnectionError:
            return jsonify({"error": "NetEase 服务未启动"}), 503
        except requests.RequestException as e:
            return jsonify({"error": str(e)}), 500

    @app.get("/api/netease/status")
    def netease_status():
        return _proxy("/status")

    @app.post("/api/netease/qr/create")
    def netease_qr_create():
        try:
            r1 = requests.post(f"{_NETEASE_PROXY}/qr/key", timeout=15)
            key_data = r1.json()
            unikey = key_data.get("unikey", "")
            if not unikey:
                return jsonify({"error": "获取 QR key 失败"}), 500
            r2 = requests.post(f"{_NETEASE_PROXY}/qr/create",
                               json={"key": unikey}, timeout=15)
            qr_data = r2.json()
            return jsonify({
                "unikey": unikey,
                "qr_img": qr_data.get("qrimg", ""),
            })
        except requests.ConnectionError:
            return jsonify({"error": "NetEase 服务未启动"}), 503
        except requests.RequestException as e:
            return jsonify({"error": str(e)}), 500

    @app.post("/api/netease/qr/check")
    def netease_qr_check():
        data = request.get_json(silent=True) or {}
        unikey = data.get("unikey", "")
        if not unikey:
            return jsonify({"error": "missing unikey"}), 400
        result = _proxy("/qr/check", method="POST", json_body={"key": unikey})
        resp_data = result[0].get_json()
        if resp_data.get("code") == 803:
            try:
                r = requests.get(f"{_NETEASE_PROXY}/status", timeout=15)
                user_data = r.json()
                if user_data.get("logged_in"):
                    resp_data["user"] = user_data.get("user")
            except requests.RequestException:
                pass
        return jsonify(resp_data), result[1]

    @app.post("/api/netease/logout")
    def netease_logout():
        return _proxy("/logout", method="POST")

    @app.get("/api/netease/playlists")
    def netease_playlists():
        try:
            r = requests.get(f"{_NETEASE_PROXY}/status", timeout=15)
            user_data = r.json()
            if not user_data.get("logged_in"):
                return jsonify({"error": "not logged in"}), 401
            uid = user_data["user"]["id"]
            return _proxy("/playlists", params={"uid": uid})
        except requests.ConnectionError:
            return jsonify({"error": "NetEase 服务未启动"}), 503
        except requests.RequestException as e:
            return jsonify({"error": str(e)}), 500

    @app.get("/api/netease/playlist/<playlist_id>")
    def netease_playlist_detail(playlist_id: str):
        return _proxy("/playlist/detail", params={"id": playlist_id})

    @app.post("/api/netease/separate/<song_id>")
    def netease_separate(song_id: str):
        track_name = request.args.get("name", f"网易云歌曲_{song_id}")
        track_name = clean_track_name(track_name)

        try:
            r = requests.get(f"{_NETEASE_PROXY}/song/url",
                             params={"id": song_id}, timeout=15)
            song_data = r.json()
            url = song_data.get("url", "")
            if not url:
                return jsonify({"error": "无法获取歌曲播放地址"}), 400

            job_id = uuid4().hex
            job_dir = JOBS_DIR / job_id
            job_dir.mkdir(parents=True, exist_ok=True)
            input_path = job_dir / "input.mp3"

            resp = requests.get(url, stream=True, timeout=60)
            resp.raise_for_status()
            with open(str(input_path), "wb") as f:
                for chunk in resp.iter_content(chunk_size=8192):
                    f.write(chunk)

            jobs.enqueue(job_id, str(input_path), track_name, str(job_dir))
            return jsonify({
                "job_id": job_id,
                "status": "processing",
                "track": track_name,
            })
        except requests.ConnectionError:
            return jsonify({"error": "NetEase 服务未启动"}), 503
        except requests.RequestException as e:
            return jsonify({"error": f"下载或分离失败: {e}"}), 500

    @app.errorhandler(413)
    def too_large(_e):
        return jsonify({"error": f"file exceeds {MAX_UPLOAD_MB}MB limit"}), 413

    return app
