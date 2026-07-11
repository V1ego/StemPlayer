"""Small helpers shared by the backend."""
import re
from pathlib import Path

from .config import STEMS


def allowed_file(filename: str, allowed_ext: set[str]) -> bool:
    ext = Path(filename).suffix.lower().lstrip(".")
    return ext in allowed_ext


def clean_track_name(filename: str) -> str:
    """Derive a safe, short track name from an uploaded filename."""
    name = Path(filename).stem
    name = re.sub(r'[\\/:*?"<>|]', "", name).strip()
    return name[:40] or "track"


def collect_stems(out_root: str, model: str, use_mp3: bool = True) -> dict[str, str]:
    """Locate the 4 separated stem files produced by Demucs.

    Demucs writes to: <out_root>/<model>/<track>/<stem>.<ext>
    """
    ext = "mp3" if use_mp3 else "wav"
    root = Path(out_root) / model
    stems: dict[str, str] = {}
    for stem in STEMS:
        matches = list(root.glob(f"*/{stem}.{ext}"))
        if matches:
            stems[stem] = str(matches[0])
    return stems
