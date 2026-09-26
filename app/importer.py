"""Import GPX files into the library."""
from __future__ import annotations

import hashlib
import re
import shutil
import unicodedata
from dataclasses import dataclass, field
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

from . import config
from .gpxstats import GpxError, compute_stats, parse_gpx
from .models import Route
from .similarity import find_similar

# File names that describe the start rather than the route ("Start.gpx", "Start (48).gpx",
# "Start Aarschot.gpx"): the track name inside the file is the better route name.
_GENERIC_STEM = re.compile(r"^\s*(start\b.*|route|track|export|gpx)?\s*(\(\d+\))?\s*$", re.I)
# Web-download style names ("sportvlaanderen-gravelroute-mol"): the track name is nicer.
_SLUG_STEM = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)+$")
# Browser copy suffix: "Route (1).gpx"
_COPY_SUFFIX = re.compile(r"\s*\(\d+\)$")


@dataclass
class ImportResult:
    filename: str
    status: str  # "imported", "duplicate", "partial" (some tracks duplicate) or "error"
    message: str = ""
    routes: list[dict] = field(default_factory=list)  # newly created: {id, name}
    duplicates: list[dict] = field(default_factory=list)  # existing routes with same file+track
    similar: list[dict] = field(default_factory=list)  # near-duplicate geometry warnings


def slugify(text: str) -> str:
    text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    text = re.sub(r"[^a-zA-Z0-9]+", "-", text).strip("-").lower()
    return text or "route"


def unique_slug(session: Session, name: str) -> str:
    base = slugify(name)[:200]
    existing = set(
        session.scalars(select(Route.slug).where(Route.slug.like(f"{base}%"))).all()
    )
    slug, n = base, 2
    while slug in existing:
        slug = f"{base}-{n}"
        n += 1
    return slug


def file_hash(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def route_name(filename: str, track_name: str | None, track_count: int, index: int) -> str:
    stem = Path(filename).stem.strip()
    if track_count > 1:
        return track_name or f"{stem} #{index + 1}"
    if track_name and (_GENERIC_STEM.match(stem) or _SLUG_STEM.match(_COPY_SUFFIX.sub("", stem))):
        return track_name
    return stem or track_name or "Unnamed route"


def _safe_filename(name: str) -> str:
    name = Path(name).name  # strip any directory parts
    name = re.sub(r"[^\w\-. ()]+", "_", name).strip() or "route.gpx"
    if not name.lower().endswith(".gpx"):
        name += ".gpx"
    return name


def store_upload(data: bytes, filename: str, source_name: str | None) -> str:
    """Write an uploaded file under GPX_DIR/uploads/<source>/; returns path relative to GPX_DIR."""
    folder = config.GPX_DIR / "uploads" / slugify(source_name or "unsorted")
    folder.mkdir(parents=True, exist_ok=True)
    name = _safe_filename(filename)
    target = folder / name
    stem, suffix = target.stem, target.suffix
    n = 2
    while target.exists():
        if target.read_bytes() == data:
            break  # identical file already stored; reuse it
        target = folder / f"{stem} ({n}){suffix}"
        n += 1
    else:
        target.write_bytes(data)
    return target.relative_to(config.GPX_DIR).as_posix()


def store_derived(data: bytes, name: str) -> str:
    """Write a newly created route (e.g. a combination) under GPX_DIR/derived/."""
    folder = config.GPX_DIR / "derived"
    folder.mkdir(parents=True, exist_ok=True)
    base = slugify(name)[:150]
    target, n = folder / f"{base}.gpx", 2
    while target.exists():
        target = folder / f"{base}-{n}.gpx"
        n += 1
    target.write_bytes(data)
    return target.relative_to(config.GPX_DIR).as_posix()


def relative_to_library(path: Path) -> str | None:
    """Path relative to GPX_DIR if the file lives inside the library, else None."""
    try:
        return path.resolve().relative_to(config.GPX_DIR).as_posix()
    except ValueError:
        return None


def import_gpx(
    session: Session,
    data: bytes,
    filename: str,
    *,
    source_name: str | None = None,
    source_url: str | None = None,
    library_path: str | None = None,
    check_similar: bool = True,
    derived_from: list[int] | None = None,
    tags: list[str] | None = None,
    notes: str | None = None,
) -> ImportResult:
    """Import one GPX file (one route per track). Commits on success.

    library_path: path relative to GPX_DIR if the file already lives in the library
    (it is then referenced in place); otherwise the file is copied into uploads/.
    """
    result = ImportResult(filename=filename, status="imported")
    try:
        parsed = parse_gpx(data)
    except GpxError as exc:
        result.status, result.message = "error", str(exc)
        return result

    digest = file_hash(data)
    existing = {
        r.track_index: r
        for r in session.scalars(select(Route).where(Route.file_hash == digest)).all()
    }
    new_tracks = []
    for i, track in enumerate(parsed.tracks):
        if i in existing:
            result.duplicates.append({"id": existing[i].id, "name": existing[i].name})
        else:
            new_tracks.append((i, track))
    if not new_tracks:
        result.status = "duplicate"
        result.message = "Identical file already imported"
        return result

    try:
        stats = [(i, t, compute_stats(t.points)) for i, t in new_tracks]
    except GpxError as exc:
        result.status, result.message = "error", str(exc)
        return result

    if library_path is None:
        library_path = store_upload(data, filename, source_name)

    candidates = session.scalars(select(Route)).all() if check_similar else []
    source_url = source_url or parsed.link
    created: list[Route] = []
    for i, track, st in stats:
        name = route_name(filename, track.name, len(parsed.tracks), i)
        route = Route(
            name=name,
            slug=unique_slug(session, name),
            gpx_path=library_path,
            original_filename=Path(filename).name,
            track_index=i,
            track_name=track.name,
            file_hash=digest,
            distance_km=st.distance_km,
            elevation_gain_m=st.elevation_gain_m,
            elevation_loss_m=st.elevation_loss_m,
            min_elevation_m=st.min_elevation_m,
            max_elevation_m=st.max_elevation_m,
            start_lat=st.start_lat,
            start_lon=st.start_lon,
            end_lat=st.end_lat,
            end_lon=st.end_lon,
            min_lat=st.min_lat,
            min_lon=st.min_lon,
            max_lat=st.max_lat,
            max_lon=st.max_lon,
            is_loop=st.is_loop,
            geometry=st.geometry,
            tags=list(tags or []),
            notes=notes,
            derived_from=list(derived_from or []),
            source_name=source_name or None,
            source_url=source_url or None,
        )
        session.add(route)
        session.flush()  # assigns id and makes the slug visible to unique_slug
        created.append(route)

    if check_similar:
        for route in created:
            others = [c for c in list(candidates) + created if c.id != route.id]
            for sim in find_similar(route.geometry, route.bbox, others):
                if not sim.very_similar:
                    continue
                other = next(o for o in others if o.id == sim.other_id)
                result.similar.append(
                    {
                        "route_id": route.id,
                        "route_name": route.name,
                        "other_id": other.id,
                        "other_name": other.name,
                        "overlap": min(sim.a_in_b, sim.b_in_a),
                    }
                )

    session.commit()
    result.routes = [{"id": r.id, "name": r.name} for r in created]
    if result.duplicates:
        result.status = "partial"
        result.message = f"{len(result.duplicates)} track(s) already imported"
    return result


def import_folder(
    session: Session,
    folder: Path,
    *,
    source_name: str | None = None,
    source_url: str | None = None,
    source_from_folder: bool = True,
    progress=None,
) -> list[ImportResult]:
    """Import every .gpx file below `folder`.

    Files inside GPX_DIR are referenced in place; others are copied into uploads/.
    With source_from_folder, files in a subfolder get the subfolder's name as
    source name (unless source_name is given).
    """
    folder = folder.resolve()
    results = []
    files = sorted(
        (p for p in folder.rglob("*") if p.is_file() and p.suffix.lower() == ".gpx"),
        # "Route.gpx" before its copy "Route (1).gpx", so the original is the one kept.
        key=lambda p: (p.parent, _COPY_SUFFIX.sub("", p.stem).lower(), len(p.name), p.name),
    )
    for path in files:
        rel = path.relative_to(folder)
        src = source_name
        if not src and source_from_folder and len(rel.parts) > 1:
            src = rel.parts[0]
        res = import_gpx(
            session,
            path.read_bytes(),
            path.name,
            source_name=src,
            source_url=source_url,
            library_path=relative_to_library(path),
        )
        results.append(res)
        if progress:
            progress(res)
    return results
