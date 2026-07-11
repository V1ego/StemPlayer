"""Central configuration for the Web Stem Player backend."""
import os
from pathlib import Path

BASE_DIR: Path = Path(__file__).resolve().parent.parent

# In packaged portable exe, redirect data to AppData for persistence
if os.environ.get("PROXY_BY_ELECTRON"):
    DATA_DIR: Path = Path(os.environ.get("APPDATA", str(Path.home()))) / "ilya" / "data"
else:
    DATA_DIR: Path = BASE_DIR / "data"

JOBS_DIR: Path = DATA_DIR / "jobs"
STATIC_DIR: Path = BASE_DIR / "static"

MODEL: str = "htdemucs"
USE_MP3: bool = True
STEMS: list[str] = ["vocals", "drums", "bass", "other"]

MAX_UPLOAD_MB: int = 500
ALLOWED_EXT: set[str] = {"mp3", "wav", "m4a", "flac", "ogg", "aac", "ncm"}

JOBS_DIR.mkdir(parents=True, exist_ok=True)
