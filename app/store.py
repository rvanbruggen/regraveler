"""The library store: routes (JSON documents), original route files (GPX, TCX, FIT), "not duplicates" pairs and
settings. No route logic here: the page computes everything, the server keeps it.

Backups use the same zip format as the browser version (web/js/backup.js): library.json plus
gpx/<sha256>.<gpx|tcx|fit> for every original file (its own extension).
"""
from __future__ import annotations

import hashlib
import io
import json
import re
import unicodedata
import zipfile
from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from . import __version__, config
from .models import Doc, IgnoredFile, IgnoredPair, RouteDoc, Setting, StoredFile

BACKUP_FORMAT = "rerouter-backup"
HASH_RE = re.compile(r"^[0-9a-f]{64}$")
PAIR_RE = re.compile(r"^\d+_\d+$")


class StoreError(ValueError):
    def __init__(self, message: str, status: int = 422):
        super().__init__(message)
        self.status = status


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


# ------------------------------------------------------------------ reading


def route_out(doc: RouteDoc) -> dict:
    return {**doc.data, "id": doc.id, "updated_at": doc.updated_at}


def library(session: Session) -> dict:
    """Everything except the file bytes, as the page loads it at start-up."""
    return {
        "routes": [route_out(d) for d in session.scalars(select(RouteDoc).order_by(RouteDoc.id))],
        "ignored": [p.key for p in session.scalars(select(IgnoredPair))],
        "settings": {s.key: s.value for s in session.scalars(select(Setting))},
        "docs": [d.data for d in session.scalars(select(Doc).order_by(Doc.key))],
    }


# ------------------------------------------------------------------ routes


def put_routes(session: Session, records: list[dict], base: dict[str, str | None] | None = None) -> list[dict]:
    """Save new and changed routes; returns [{id, updated_at}] in the same order.

    base: {id: updated_at the page loaded}. A route that was saved since then (by another
    page) is not overwritten: the whole batch is refused with 409.
    """
    base = {str(k): v for k, v in (base or {}).items()}
    known_files = set(session.scalars(select(StoredFile.hash)))
    stamp = now()
    docs = []
    conflicts = []
    for rec in records:
        if not isinstance(rec, dict):
            raise StoreError("A route must be an object")
        file_hash = rec.get("file_hash")
        if not isinstance(file_hash, str) or file_hash not in known_files:
            raise StoreError(f"Route '{rec.get('name')}': its GPX file is not stored (store the file first)")
        if not isinstance(rec.get("name"), str) or not rec["name"].strip():
            raise StoreError("A route needs a name")
        rid = rec.get("id")
        doc = session.get(RouteDoc, rid) if rid is not None else None
        if doc is not None and str(rid) in base and base[str(rid)] != doc.updated_at:
            conflicts.append(doc.data.get("name", f"#{rid}"))
        docs.append((rec, rid, doc))
    if conflicts:
        session.rollback()
        raise StoreError(
            f"Changed elsewhere since this page loaded it: {', '.join(conflicts)}. Reload the page and try again.", 409
        )
    out = []
    for rec, rid, doc in docs:
        data = {k: v for k, v in rec.items() if k not in ("id", "updated_at")}
        if doc is None:
            doc = RouteDoc(id=rid) if rid is not None else RouteDoc()
            session.add(doc)
        doc.file_hash = data["file_hash"]
        doc.track_hash = data.get("track_hash")
        doc.updated_at = stamp
        doc.data = data
        session.flush()  # assigns the id
        out.append({"id": doc.id, "updated_at": stamp})
    session.commit()
    return out


def delete_routes(session: Session, ids: list[int]) -> int:
    """Remove routes (their GPX files stay on disk) and their "not duplicates" pairs."""
    ids = [int(i) for i in ids]
    n = session.execute(delete(RouteDoc).where(RouteDoc.id.in_(ids))).rowcount
    gone = {str(i) for i in ids}
    for pair in session.scalars(select(IgnoredPair)).all():
        if gone & set(pair.key.split("_")):
            session.delete(pair)
    session.commit()
    return n


# ------------------------------------------------------------------ files


def _safe_part(text: str, fallback: str) -> str:
    text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    text = re.sub(r"[^a-zA-Z0-9]+", "-", text).strip("-").lower()
    return text or fallback


# Route file formats: the original file is stored as it is, with its own extension.
TRACK_SUFFIXES = (".gpx", ".tcx", ".fit")
MEDIA_TYPES = {".gpx": "application/gpx+xml", ".tcx": "application/vnd.garmin.tcx+xml", ".fit": "application/vnd.ant.fit"}


def suffix_of(name: str) -> str:
    """.gpx, .tcx or .fit (anything else counts as .gpx)."""
    suffix = Path(name or "").suffix.lower()
    return suffix if suffix in TRACK_SUFFIXES else ".gpx"


def media_type(name: str) -> str:
    return MEDIA_TYPES[suffix_of(name)]


def _safe_filename(name: str) -> str:
    name = Path(name or "").name  # strip any directory parts
    name = re.sub(r"[^\w\-. ()]+", "_", name).strip() or "route.gpx"
    if not name.lower().endswith(TRACK_SUFFIXES):
        name += ".gpx"
    return name


def _folder(folder: str | None) -> Path:
    """uploads/<source>, derived or restored (anything else goes to uploads/unsorted)."""
    parts = [p for p in (folder or "").split("/") if p]
    if parts[:1] == ["derived"]:
        return Path("derived")
    if parts[:1] == ["restored"]:
        return Path("restored")
    source = parts[1] if parts[:1] == ["uploads"] and len(parts) > 1 else "unsorted"
    return Path("uploads") / _safe_part(source, "unsorted")


# Hashes of the GPX files on disk, so a file that is already in the GPX folder is referenced
# where it is instead of being copied: {relative path: (mtime_ns, size, hash)}
_disk_cache: dict[str, tuple[int, int, str]] = {}


def disk_index() -> dict[str, str]:
    """{sha256: relative path} of every route file (.gpx, .tcx, .fit) under GPX_DIR (first path wins)."""
    root = config.GPX_DIR
    seen: dict[str, str] = {}
    if not root.is_dir():
        return seen
    live = set()
    for path in sorted(root.rglob("*")):
        if not path.is_file() or path.suffix.lower() not in TRACK_SUFFIXES or any(p.startswith(".") for p in path.relative_to(root).parts):
            continue
        rel = path.relative_to(root).as_posix()
        st = path.stat()
        hit = _disk_cache.get(rel)
        if not hit or hit[0] != st.st_mtime_ns or hit[1] != st.st_size:
            hit = (st.st_mtime_ns, st.st_size, sha256(path.read_bytes()))
            _disk_cache[rel] = hit
        live.add(rel)
        seen.setdefault(hit[2], rel)
    for rel in set(_disk_cache) - live:
        del _disk_cache[rel]
    return seen


def resolve(rel: str) -> Path:
    """An absolute path inside GPX_DIR (refuses anything that points outside it)."""
    path = (config.GPX_DIR / rel).resolve()
    if not path.is_relative_to(config.GPX_DIR):
        raise StoreError("Path outside the GPX folder", 400)
    return path


def put_file(session: Session, file_hash: str, data: bytes, name: str, folder: str | None = None) -> str:
    """Store an original GPX file; returns its path relative to GPX_DIR.

    An identical file already in the GPX folder is referenced where it is; otherwise the file
    is written to uploads/<source>/, derived/ or restored/ (never overwriting another file).
    """
    if not HASH_RE.match(file_hash or ""):
        raise StoreError("Not a SHA-256 hash", 400)
    if sha256(data) != file_hash:
        raise StoreError("The file does not match its hash (damaged upload?)", 400)
    if len(data) > config.MAX_FILE_BYTES:
        raise StoreError("The file is too large", 413)
    existing = session.get(StoredFile, file_hash)
    if existing and resolve(existing.path).is_file():
        return existing.path
    rel = disk_index().get(file_hash)
    if rel is None:
        target_dir = config.GPX_DIR / _folder(folder)
        target_dir.mkdir(parents=True, exist_ok=True)
        fname = _safe_filename(name)
        target = target_dir / fname
        stem, suffix, n = target.stem, target.suffix, 2
        while target.exists():
            target = target_dir / f"{stem} ({n}){suffix}"
            n += 1
        target.write_bytes(data)
        rel = target.relative_to(config.GPX_DIR).as_posix()
    if existing:
        existing.path = rel
        existing.name = Path(name or existing.name).name
    else:
        session.add(StoredFile(hash=file_hash, name=Path(name or rel).name, path=rel))
    session.commit()
    return rel


def get_file(session: Session, file_hash: str) -> tuple[StoredFile, Path]:
    f = session.get(StoredFile, file_hash)
    if f is None:
        raise StoreError("GPX file not in the library", 404)
    path = resolve(f.path)
    if not path.is_file():
        # Moved inside the GPX folder? Find it again by its content.
        rel = disk_index().get(file_hash)
        if rel is None:
            raise StoreError(f"GPX file not found on disk: {f.path}", 404)
        f.path = rel
        session.commit()
        path = resolve(rel)
    return f, path


def disk_files(session: Session) -> dict:
    """GPX files in the GPX folder whose content is not in the library yet (and not ignored):
    {"files": [{path, size}], "ignored": number of ignored files still in the folder}."""
    known = set(session.scalars(select(RouteDoc.file_hash)))
    ignored = set(session.scalars(select(IgnoredFile.hash)))
    out, n_ignored = [], 0
    for h, rel in disk_index().items():
        if h in known:
            continue
        if h in ignored:
            n_ignored += 1
            continue
        out.append({"path": rel, "size": resolve(rel).stat().st_size})
    return {"files": sorted(out, key=lambda f: f["path"].lower()), "ignored": n_ignored}


def ignore_disk_files(session: Session, items: list[dict]) -> int:
    """Stop offering these files for import: items [{path, reason}] (paths relative to
    GPX_DIR). Ignored by content, so other copies of the same file are ignored too."""
    disk_index()  # refreshes the cache, which has every copy (not only the first)
    by_path = {rel: h for rel, (_, _, h) in _disk_cache.items()}
    added = 0
    for item in items:
        rel = str(item.get("path", ""))
        h = by_path.get(rel)
        if h is None:
            path = resolve(rel)
            if not path.is_file():
                raise StoreError(f"No such GPX file: {rel}", 404)
            h = sha256(path.read_bytes())
        reason = (str(item.get("reason") or "")[:300]) or None
        row = session.get(IgnoredFile, h)
        if row is None:
            session.add(IgnoredFile(hash=h, path=rel, reason=reason, ignored_at=now()))
            added += 1
        else:
            row.reason = reason or row.reason
    session.commit()
    return added


def unignore_disk_files(session: Session) -> int:
    """Offer every ignored file again."""
    n = session.execute(delete(IgnoredFile)).rowcount
    session.commit()
    return n


# ------------------------------------------------------------------ pairs and settings


def put_ignored(session: Session, keys: list[str]) -> int:
    added = 0
    for key in keys:
        if not PAIR_RE.match(str(key)):
            raise StoreError(f"Not a pair of route ids: {key}")
        a, b = sorted(int(x) for x in key.split("_"))
        key = f"{a}_{b}"
        if session.get(IgnoredPair, key) is None:
            session.add(IgnoredPair(key=key))
            added += 1
    session.commit()
    return added


def delete_ignored(session: Session, keys: list[str]) -> int:
    n = session.execute(delete(IgnoredPair).where(IgnoredPair.key.in_([str(k) for k in keys]))).rowcount
    session.commit()
    return n


def put_settings(session: Session, settings: dict) -> None:
    for key, value in settings.items():
        s = session.get(Setting, str(key))
        if s is None:
            session.add(Setting(key=str(key), value=value))
        else:
            s.value = value
    session.commit()


DOC_KEY_RE = re.compile(r"^[a-z_]{1,40}:[\w.-]{1,150}$")


def put_docs(session: Session, docs: list[dict]) -> int:
    """Save documents ({kind, id, ...}) under "<kind>:<id>" (replacing what was there)."""
    for d in docs:
        if not isinstance(d, dict):
            raise StoreError("A document must be an object")
        key = f"{d.get('kind')}:{d.get('id')}"
        if not DOC_KEY_RE.match(key):
            raise StoreError(f"Not a valid document kind and id: {key!r}")
        data = {**d, "key": key}
        doc = session.get(Doc, key)
        if doc is None:
            session.add(Doc(key=key, kind=d["kind"], data=data))
        else:
            doc.data = data
    session.commit()
    return len(docs)


def delete_docs(session: Session, keys: list[str]) -> int:
    n = session.execute(delete(Doc).where(Doc.key.in_([str(k) for k in keys]))).rowcount
    session.commit()
    return n


def clear(session: Session) -> None:
    """Remove every route, pair, setting and document (and forget the files; they stay on disk)."""
    for model in (RouteDoc, IgnoredPair, Setting, Doc, StoredFile, IgnoredFile):
        session.execute(delete(model))
    session.commit()


# ------------------------------------------------------------------ backups


def backup_zip(session: Session) -> bytes:
    """The whole library as a backup zip (only the files the routes use)."""
    lib = library(session)
    used = {r["file_hash"] for r in lib["routes"]}
    files = []
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for f in session.scalars(select(StoredFile).where(StoredFile.hash.in_(used))).all():
            try:
                _, path = get_file(session, f.hash)
            except StoreError:
                continue  # missing on disk: the routes are still in library.json
            zf.writestr(f"gpx/{f.hash}{suffix_of(f.name)}", path.read_bytes())
            files.append({"hash": f.hash, "name": f.name})
        manifest = {
            "format": BACKUP_FORMAT,
            "version": 1,
            "app_version": __version__,
            "created_at": now(),
            **lib,
            "files": files,
        }
        zf.writestr("library.json", json.dumps(manifest, ensure_ascii=False))
    return buf.getvalue()


def read_backup(data: bytes) -> dict:
    try:
        zf = zipfile.ZipFile(io.BytesIO(data))
        manifest = json.loads(zf.read("library.json"))
    except (zipfile.BadZipFile, KeyError, ValueError):
        raise StoreError("This is not a rerouter backup (no library.json in a zip file)", 400)
    if manifest.get("format") != BACKUP_FORMAT:
        raise StoreError("This is not a rerouter backup", 400)
    files = []
    for f in manifest.get("files", []):
        try:
            names = (f"gpx/{f['hash']}{suffix_of(f.get('name') or '')}", f"gpx/{f['hash']}.gpx")
            content = next(zf.read(n) for n in names if n in zf.namelist())
        except (KeyError, StopIteration):
            raise StoreError(f"The backup is incomplete: {f.get('name')} is missing", 400)
        files.append({**f, "data": content})
    return {
        "routes": manifest.get("routes", []),
        "ignored": manifest.get("ignored", []),
        "settings": manifest.get("settings", {}),
        "docs": [d for d in manifest.get("docs", []) if isinstance(d, dict)],
        "files": files,
    }


def restore(session: Session, data: bytes) -> dict:
    """Replace the library with a backup. Files the GPX folder already has are referenced in
    place; the others are written to GPX_DIR/restored/. Route ids are kept."""
    backup = read_backup(data)
    clear(session)
    for f in backup["files"]:
        put_file(session, f["hash"], f["data"], f.get("name") or f"{f['hash']}.gpx", "restored")
    routes = [r for r in backup["routes"] if isinstance(r, dict) and "id" in r]
    put_routes(session, routes)
    put_ignored(session, backup["ignored"])
    put_settings(session, backup["settings"])
    put_docs(session, backup["docs"])
    return {"routes": len(routes), "files": len(backup["files"])}
