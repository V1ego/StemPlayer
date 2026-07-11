"""NetEase Cloud Music API module.

Implements weapi encryption, QR code login, playlist browsing, and song
downloading using the unofficial NetEase Cloud Music web API.
"""
import base64
import io
import json
import os
import random
import secrets
import string
from pathlib import Path

import qrcode
import requests
from Crypto.Cipher import AES
from Crypto.Util.Padding import pad

_BASE = "https://music.163.com"
_WEAPI = _BASE + "/weapi"
_PRESET_KEY = b"0CoJUm6Qyw8W8jud"
_IV = b"0102030405060708"
_PUB_KEY = "010001"
_PUB_MODULUS = (
    "00e0b509f6259df8642dbc35662901477df22677ec152b5ff68ace615bb7"
    "b725152b3ab17a876aea8a5aa76d2e417629ec4ee341f56135fccf695280"
    "104e0312ecbda92557c93870114af6c9d05c4f7f0c3685b7a46bee255932"
    "575cce10b424d813cfe4875d3e82047b97ddef52741d546b8e289dc6935b"
    "3ece0462db0a22b8e7"
)

_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)


def _random_str(length: int = 16) -> str:
    chars = string.ascii_letters + string.digits
    return "".join(secrets.choice(chars) for _ in range(length))


def _aes_encrypt(data: bytes, key: bytes) -> bytes:
    cipher = AES.new(key, AES.MODE_CBC, _IV)
    padded = pad(data, AES.block_size)
    return cipher.encrypt(padded)


def _rsa_encrypt(text: str) -> str:
    text_bytes = text.encode("utf-8")
    reversed_bytes = text_bytes[::-1]
    m = int.from_bytes(reversed_bytes, "big")
    e = int(_PUB_KEY, 16)
    n = int(_PUB_MODULUS, 16)
    result = pow(m, e, n)
    return format(result, "0256x")


def weapi_encrypt(payload: dict) -> dict[str, str]:
    plaintext = json.dumps(payload, ensure_ascii=False,
                           separators=(",", ":")).encode("utf-8")
    first = _aes_encrypt(plaintext, _PRESET_KEY)
    first_b64 = base64.b64encode(first).decode("utf-8")
    random_key = _random_str(16)
    second = _aes_encrypt(first_b64.encode("utf-8"), random_key.encode("utf-8"))
    params = base64.b64encode(second).decode("utf-8")
    enc_sec_key = _rsa_encrypt(random_key)
    return {"params": params, "encSecKey": enc_sec_key}


def _post(path: str, data: dict, session: requests.Session,
          extra_headers: dict | None = None) -> dict:
    enc = weapi_encrypt(data)
    headers: dict[str, str] = {
        "User-Agent": _USER_AGENT,
        "Referer": _BASE + "/",
        "Origin": _BASE,
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "application/json, text/plain, */*",
        "X-Real-IP": "116.25.146.37",
    }
    if extra_headers:
        headers.update(extra_headers)
    url = _WEAPI + path
    resp = session.post(url, data=enc, headers=headers, timeout=15)
    resp.raise_for_status()
    try:
        return resp.json()
    except json.JSONDecodeError:
        return {"code": -1, "msg": resp.text[:200]}


def qr_create(session: requests.Session) -> dict[str, str]:
    key_data = _post("/login/qrcode/unikey", {"type": 1}, session)
    unikey = key_data.get("unikey", "")
    if not unikey:
        raise RuntimeError(f"Failed to get QR key: {key_data}")

    qr_url = f"{_BASE}/login?codekey={unikey}"
    qr = qrcode.QRCode(
        version=1,
        error_correction=qrcode.constants.ERROR_CORRECT_M,
        box_size=8,
        border=2,
    )
    qr.add_data(qr_url)
    qr.make(fit=True)
    img = qr.make_image(fill_color="black", back_color="white")

    buf = io.BytesIO()
    img.save(buf, format="PNG")
    qr_img = "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode("utf-8")

    return {"unikey": unikey, "qr_img": qr_img}


def qr_check(session: requests.Session, unikey: str) -> dict:
    return _post("/login/qrcode/client/login", {"key": unikey, "type": 1}, session)


def get_login_status(session: requests.Session) -> dict:
    return _post("/w/nuser/account/get", {}, session)


def get_user_playlists(session: requests.Session, uid: int,
                       limit: int = 100) -> dict:
    return _post("/user/playlist", {
        "uid": uid,
        "limit": limit,
        "offset": 0,
        "includeVideo": True,
    }, session)


def get_playlist_detail(session: requests.Session, playlist_id: int) -> dict:
    return _post("/v6/playlist/detail", {
        "id": playlist_id,
        "n": 100000,
        "s": 8,
    }, session)


def get_song_url(session: requests.Session, song_id: int,
                 level: str = "standard") -> dict:
    return _post("/song/url/v1", {
        "id": song_id,
        "level": level,
        "encodeType": "mp3",
    }, session)


def get_song_detail(session: requests.Session, song_ids: list[int]) -> dict:
    ids_str = ",".join(str(s) for s in song_ids)
    return _post("/song/detail", {"ids": ids_str}, session)


class NetEaseClient:
    """High-level NetEase Cloud Music client with session management."""

    def __init__(self, cookie_path: str | None = None) -> None:
        self.session = requests.Session()
        self.session.headers.update({
            "User-Agent": _USER_AGENT,
            "Referer": _BASE + "/",
            "Origin": _BASE,
            "X-Real-IP": "116.25.146.37",
        })
        self.cookie_path = cookie_path
        self._user_info: dict | None = None
        self._load_cookies()

    def _load_cookies(self) -> None:
        if self.cookie_path and os.path.exists(self.cookie_path):
            try:
                with open(self.cookie_path, "r", encoding="utf-8") as f:
                    cookies = json.load(f)
                for k, v in cookies.items():
                    self.session.cookies.set(k, v, domain=".music.163.com")
            except (json.JSONDecodeError, OSError):
                pass

    def _save_cookies(self) -> None:
        if not self.cookie_path:
            return
        cookies = {c.name: c.value for c in self.session.cookies
                   if c.domain.endswith("music.163.com")}
        os.makedirs(os.path.dirname(self.cookie_path), exist_ok=True)
        with open(self.cookie_path, "w", encoding="utf-8") as f:
            json.dump(cookies, f, ensure_ascii=False, indent=2)

    def qr_create(self) -> dict[str, str]:
        return qr_create(self.session)

    def qr_check(self, unikey: str) -> dict:
        result = qr_check(self.session, unikey)
        if result.get("code") == 803:
            self._save_cookies()
            self._user_info = None
        return result

    def get_user_info(self) -> dict | None:
        if self._user_info:
            return self._user_info
        try:
            data = get_login_status(self.session)
            if data.get("code") == 200 and data.get("profile"):
                self._user_info = data["profile"]
                return self._user_info
        except requests.RequestException:
            pass
        return None

    def is_logged_in(self) -> bool:
        return self.get_user_info() is not None

    def logout(self) -> None:
        self.session.cookies.clear()
        self._user_info = None
        if self.cookie_path and os.path.exists(self.cookie_path):
            os.remove(self.cookie_path)

    def get_my_playlists(self) -> list[dict]:
        user = self.get_user_info()
        if not user:
            return []
        uid = user.get("userId")
        if not uid:
            return []
        data = get_user_playlists(self.session, uid, limit=200)
        if data.get("code") != 200:
            return []
        return [{
            "id": p.get("id"),
            "name": p.get("name"),
            "cover": p.get("coverImgUrl"),
            "track_count": p.get("trackCount", 0),
            "description": p.get("description", ""),
            "creator": p.get("creator", {}).get("nickname", ""),
            "is_own": (p.get("creator", {}).get("userId") == uid),
        } for p in data.get("playlist", [])]

    def get_playlist_tracks(self, playlist_id: int) -> list[dict]:
        data = get_playlist_detail(self.session, playlist_id)
        if data.get("code") != 200:
            return []
        track_ids = data.get("playlist", {}).get("trackIds", [])
        ids = [t["id"] for t in track_ids[:500]]
        if not ids:
            return []
        detail_data = get_song_detail(self.session, ids)
        return [{
            "id": s.get("id"),
            "name": s.get("name"),
            "artist": " / ".join(a.get("name", "") for a in s.get("ar", [])),
            "album": s.get("al", {}).get("name", ""),
            "cover": s.get("al", {}).get("picUrl", ""),
            "duration": s.get("dt", 0) // 1000,
        } for s in detail_data.get("songs", [])]

    def get_song_stream_url(self, song_id: int) -> str | None:
        data = get_song_url(self.session, song_id, level="exhigh")
        if data.get("code") != 200:
            return None
        data_list = data.get("data", [])
        if not data_list:
            return None
        return data_list[0].get("url")

    def download_song(self, song_id: int, output_dir: str,
                      filename: str | None = None) -> str | None:
        url = self.get_song_stream_url(song_id)
        if not url:
            return None
        os.makedirs(output_dir, exist_ok=True)
        if not filename:
            filename = f"{song_id}.mp3"
        filepath = os.path.join(output_dir, filename)
        resp = self.session.get(url, stream=True, timeout=30)
        resp.raise_for_status()
        with open(filepath, "wb") as f:
            for chunk in resp.iter_content(chunk_size=8192):
                f.write(chunk)
        return filepath
