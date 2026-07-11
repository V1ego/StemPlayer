"""Entry point: run the Web Stem Player backend on http://127.0.0.1:5000"""
import os
import pathlib
import subprocess
import time

# --- Ensure FFmpeg shared DLLs are on PATH (for torchaudio/soundfile) ---
_FFMPEG_BIN = pathlib.Path(__file__).parent / ".ffmpeg" / "ffmpeg-master-latest-win64-gpl-shared" / "bin"
if _FFMPEG_BIN.exists():
    os.environ["PATH"] = str(_FFMPEG_BIN) + os.pathsep + os.environ.get("PATH", "")
    try:
        os.add_dll_directory(str(_FFMPEG_BIN))
    except AttributeError:
        pass  # Python < 3.8

# Also check extraResources path (packaged Electron app)
_PACKAGED_FFMPEG = pathlib.Path(os.environ.get("_APP_ROOT", "")) / ".ffmpeg" / "ffmpeg-master-latest-win64-gpl-shared" / "bin" if os.environ.get("_APP_ROOT") else None
if _PACKAGED_FFMPEG and _PACKAGED_FFMPEG.exists():
    os.environ["PATH"] = str(_PACKAGED_FFMPEG) + os.pathsep + os.environ.get("PATH", "")
    try:
        os.add_dll_directory(str(_PACKAGED_FFMPEG))
    except AttributeError:
        pass

from app.server import create_app

app = create_app()


def start_netease_proxy():
    """Start the Node.js NeteaseCloudMusicApi proxy server.

    Skipped when running under Electron (the main process handles it).
    """
    # Skip if Electron is managing the proxy (PROXY_BY_ELECTRON env var)
    if os.environ.get("ELECTRON_RUN_AS_NODE") or os.environ.get("PROXY_BY_ELECTRON"):
        return None

    proxy_script = pathlib.Path(__file__).parent / "netease_proxy.js"
    if not proxy_script.exists():
        print("[netease] proxy script not found, skipping")
        return None
    try:
        proc = subprocess.Popen(
            ["node", str(proxy_script)],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            cwd=str(pathlib.Path(__file__).parent),
        )
        time.sleep(1.5)
        print("[netease] proxy server started (PID %d)" % proc.pid)
        return proc
    except Exception as e:
        print("[netease] failed to start proxy: %s" % e)
        return None


if __name__ == "__main__":
    print("=" * 56)
    print("  分轨播放器 / Web Stem Player")
    print("  打开:  http://127.0.0.1:5000")
    print("  首次分轨会下载 Demucs 模型（约80MB）。")
    print("=" * 56)
    start_netease_proxy()
    app.run(host="127.0.0.1", port=5000, threaded=True)
