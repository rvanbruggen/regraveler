"""Runtime configuration, read from environment variables."""
import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent

# Directory holding the SQLite database.
DATA_DIR = Path(os.environ.get("DATA_DIR", BASE_DIR / "data")).resolve()
# Root of the GPX library. Files already inside this folder are referenced in
# place; uploaded files are copied to GPX_DIR/uploads/. Originals are never modified.
GPX_DIR = Path(os.environ.get("GPX_DIR", BASE_DIR / "gpx")).resolve()

DATABASE_URL = os.environ.get("DATABASE_URL", f"sqlite:///{DATA_DIR / 'routes.db'}")

# Start and end within this distance (metres) -> route is a loop.
LOOP_THRESHOLD_M = float(os.environ.get("LOOP_THRESHOLD_M", 200))
# Near-duplicate detection: two routes are "very similar" when at least
# SIMILAR_MIN_OVERLAP of each route lies within SIMILAR_TOLERANCE_M of the other.
SIMILAR_TOLERANCE_M = float(os.environ.get("SIMILAR_TOLERANCE_M", 50))
SIMILAR_MIN_OVERLAP = float(os.environ.get("SIMILAR_MIN_OVERLAP", 0.8))
# Map view: default and maximum distance (metres) for "routes near each other".
PROXIMITY_DISTANCE_M = float(os.environ.get("PROXIMITY_DISTANCE_M", 100))
PROXIMITY_MAX_DISTANCE_M = float(os.environ.get("PROXIMITY_MAX_DISTANCE_M", 5000))

# Combiner (phase 3): BRouter routing service.
BROUTER_URL = os.environ.get("BROUTER_URL", "http://localhost:17777").rstrip("/")
BROUTER_TIMEOUT_S = float(os.environ.get("BROUTER_TIMEOUT_S", 60))
# Profiles offered in the UI (must exist in BRouter's profiles2 folder); the first is the default.
BROUTER_PROFILES = [
    p.strip() for p in os.environ.get("BROUTER_PROFILES", "gravel,trekking,mtb,fastbike,shortest").split(",")
    if p.strip()
]
# Connection points closer than this are joined directly, without asking BRouter.
DIRECT_JOIN_M = float(os.environ.get("DIRECT_JOIN_M", 25))
