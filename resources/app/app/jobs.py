"""Background job registry + worker that runs Demucs.

Single-user, local: one daemon worker thread processes separation jobs
serially to avoid CPU contention. A simple in-memory dict tracks state.
"""
import re
import sys
import queue
import threading
import subprocess

from .config import JOBS_DIR, MODEL, USE_MP3
from .utils import collect_stems
from .config import STEMS as STEM_NAMES

_jobs: dict[str, dict] = {}
_lock = threading.Lock()
_q: queue.Queue = queue.Queue()


def list_status(job_id: str) -> dict | None:
    with _lock:
        job = _jobs.get(job_id)
    return dict(job) if job else None


def enqueue(job_id: str, input_path: str, track_name: str, out_root: str) -> None:
    with _lock:
        _jobs[job_id] = {
            "status": "processing",
            "progress": 0,
            "error": None,
            "stems": None,
            "track_name": track_name,
            "out_root": out_root,
        }
    _q.put((job_id, input_path, out_root))


def _set(job_id: str, **kw) -> None:
    with _lock:
        if job_id in _jobs:
            _jobs[job_id].update(kw)


def _run_demucs(job_id: str, input_path: str, out_root: str) -> dict[str, str]:
    cmd = [
        sys.executable, "-m", "demucs.separate",
        "-n", MODEL,
        "-o", out_root,
    ]
    if USE_MP3:
        cmd.append("--mp3")
    cmd.append(input_path)

    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
        bufsize=1,
    )
    for line in iter(proc.stdout.readline, ""):
        m = re.search(r"(\d+)\s*%", line)
        if m:
            _set(job_id, progress=int(m.group(1)))
    proc.wait()

    stems = collect_stems(out_root, MODEL, USE_MP3)
    if len(stems) == len(STEM_NAMES):
        return stems

    if proc.returncode != 0:
        raise RuntimeError(f"demucs 退出码 {proc.returncode}，未能生成分轨文件")
    raise RuntimeError(
        f"期望 {len(STEM_NAMES)} 条分轨，实际找到 {len(stems)} 条: {list(stems)}"
    )


def _worker() -> None:
    while True:
        job_id, input_path, out_root = _q.get()
        try:
            stems = _run_demucs(job_id, input_path, out_root)
            _set(job_id, status="done", stems=stems, progress=100)
        except Exception as exc:
            _set(job_id, status="error", error=str(exc))
        finally:
            _q.task_done()


threading.Thread(target=_worker, daemon=True, name="demucs-worker").start()
