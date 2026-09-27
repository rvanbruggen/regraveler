"""Runtime configuration, read from environment variables."""
import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent

# Directory holding the SQLite database.
DATA_DIR = Path(os.environ.get("DATA_DIR", BASE_DIR / "data")).resolve()
# Root of the GPX library. Files already inside this folder are referenced in place; files
# uploaded from the page go to GPX_DIR/uploads/<source>/, routes made in the page (combined,
# new start point) to GPX_DIR/derived/, restored backups to GPX_DIR/restored/. Originals are
# never modified or deleted.
GPX_DIR = Path(os.environ.get("GPX_DIR", BASE_DIR / "gpx")).resolve()

DATABASE_URL = os.environ.get("DATABASE_URL", f"sqlite:///{DATA_DIR / 'routes.db'}")

# The page (the whole app: all the route logic runs in the browser).
WEB_DIR = Path(os.environ.get("WEB_DIR", BASE_DIR / "web")).resolve()

# BRouter, reached by the page through /brouter on this server. Empty: no proxy (the page's
# settings can still point at another BRouter, such as the public brouter.de).
BROUTER_URL = os.environ.get("BROUTER_URL", "http://localhost:17777").rstrip("/")
BROUTER_TIMEOUT_S = float(os.environ.get("BROUTER_TIMEOUT_S", 120))

# Largest GPX file the page may store (bytes).
MAX_FILE_BYTES = int(os.environ.get("MAX_FILE_BYTES", 50_000_000))

# Import from a link: GPX files the page can't read straight from another site are fetched by
# the server (only from public internet addresses, never from this network).
LINK_FETCH_TIMEOUT_S = float(os.environ.get("LINK_FETCH_TIMEOUT_S", 20))
LINK_FETCH_MAX_BYTES = int(os.environ.get("LINK_FETCH_MAX_BYTES", 20_000_000))
