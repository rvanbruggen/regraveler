"""One-time move of a library from the Python version (up to 0.7.x) to the page-centred store.

The old version kept one row per route in the "routes" table (stats computed in Python) and
the "not duplicates" pairs in "ignored_duplicates". Those rows become route documents in the
same shape the page writes, with the same ids; the GPX files stay where they are.

The old tables are left untouched, so the old version still works on the same database.
Runs at start-up when the new tables are empty and the old ones are not.
"""
from __future__ import annotations

import json
import logging
from datetime import datetime, timezone

from sqlalchemy import inspect, select, text
from sqlalchemy.orm import Session

from .models import RouteDoc, StoredFile
from .store import StoreError, now, put_ignored, put_settings, resolve, sha256

log = logging.getLogger(__name__)

# Route fields the page uses, in the order it writes them (see importGpx in web/js/service.js).
FIELDS = [
    "name", "slug", "original_filename", "track_index", "track_name", "file_hash", "track_hash",
    "distance_km", "elevation_gain_m", "elevation_loss_m", "min_elevation_m", "max_elevation_m",
    "start_lat", "start_lon", "end_lat", "end_lon", "min_lat", "min_lon", "max_lat", "max_lon",
    "is_loop", "geometry", "activity", "quality_rating", "paved_pct", "paved_source", "surface",
    "tags", "notes", "source_name", "source_url", "imported_at", "derived_from",
]
JSON_FIELDS = {"geometry", "surface", "tags", "derived_from"}


def needed(session: Session) -> bool:
    insp = inspect(session.get_bind())
    if not insp.has_table("routes") or "gpx_path" not in {c["name"] for c in insp.get_columns("routes")}:
        return False
    if session.scalar(select(RouteDoc.id).limit(1)) is not None:
        return False
    return bool(session.execute(text("SELECT 1 FROM routes LIMIT 1")).first())


def _iso(value) -> str:
    if isinstance(value, datetime):
        dt = value
    else:
        dt = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def migrate(session: Session) -> dict:
    """Copy the old tables into the new store. Returns counts (routes, files, missing files)."""
    rows = session.execute(text("SELECT * FROM routes ORDER BY id")).mappings().all()
    stamp = now()
    files: dict[str, StoredFile] = {}
    missing = []
    for row in rows:
        path = row["gpx_path"]
        file_hash = row["file_hash"]
        try:
            full = resolve(path)
        except StoreError:
            full = None
        if full is None or not full.is_file():
            missing.append(path)
        elif file_hash not in files:
            actual = sha256(full.read_bytes())
            if actual != file_hash:  # should never happen: originals are never modified
                log.warning("%s changed on disk since it was imported", path)
        if file_hash not in files:
            files[file_hash] = StoredFile(hash=file_hash, name=row["original_filename"], path=path)
            session.add(files[file_hash])

        data = {}
        for field in FIELDS:
            value = row.get(field)
            if field in JSON_FIELDS and isinstance(value, str):
                value = json.loads(value)
            if field == "is_loop":
                value = bool(value)
            if field == "imported_at" and value is not None:
                value = _iso(value)
            data[field] = value
        data["activity"] = data["activity"] or "gravel"
        data["tags"] = data["tags"] or []
        data["derived_from"] = data["derived_from"] or []
        session.add(RouteDoc(id=row["id"], file_hash=file_hash, track_hash=data["track_hash"], updated_at=stamp, data=data))
    session.flush()

    insp = inspect(session.get_bind())
    pairs = []
    if insp.has_table("ignored_duplicates"):
        pairs = [f"{a}_{b}" for a, b in session.execute(text("SELECT a_id, b_id FROM ignored_duplicates"))]
    session.commit()
    put_ignored(session, pairs)
    put_settings(session, {"migrated_from_python_version_at": stamp})
    result = {"routes": len(rows), "files": len(files), "missing_files": missing, "ignored_pairs": len(pairs)}
    log.info("Moved the library of the Python version: %s", result)
    return result


def migrate_if_needed(session: Session) -> dict | None:
    return migrate(session) if needed(session) else None

