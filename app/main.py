"""FastAPI application: JSON API + static single-page frontend."""
from __future__ import annotations

import io
import json
import zipfile
from contextlib import asynccontextmanager
from functools import lru_cache
from datetime import datetime
from pathlib import Path
from typing import Annotated

from fastapi import Depends, FastAPI, File, Form, HTTPException, Query, UploadFile
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from . import __version__, brouter, combiner, config, db, places, surface
from .gpxstats import compute_stats, parse_gpx, write_gpx
from .importer import file_hash, import_gpx, normalise_tags, store_derived, track_hash, unique_slug
from .models import IgnoredDuplicate, Route
from .similarity import duplicate_pairs, find_similar, group_pairs, proximity_pairs, simplify_latlon

STATIC_DIR = Path(__file__).parent / "static"


@asynccontextmanager
async def lifespan(_app: FastAPI):
    if db.engine is None:
        db.init_db()
    config.GPX_DIR.mkdir(parents=True, exist_ok=True)
    backfill_track_hashes()
    backfill_activity()
    yield


def backfill_activity() -> None:
    """Routes from before activities existed were all gravel routes."""
    with db.SessionLocal() as session:
        for route in session.scalars(select(Route).where(Route.activity.is_(None))).all():
            route.activity = config.ACTIVITIES[0]
        session.commit()


def backfill_track_hashes() -> None:
    """Routes imported before track hashes existed get one from their GPX file."""
    with db.SessionLocal() as session:
        for route in session.scalars(select(Route).where(Route.track_hash.is_(None))).all():
            path = config.GPX_DIR / route.gpx_path
            try:
                tracks = parse_gpx(path.read_bytes()).tracks
                route.track_hash = track_hash(tracks[route.track_index].points)
            except Exception:
                continue  # missing or unreadable file: leave it empty
        session.commit()


app = FastAPI(title="rerouter", version=__version__, lifespan=lifespan)
# Map and proximity responses are mostly coordinates, which compress very well.
app.add_middleware(GZipMiddleware, minimum_size=2000)
SessionDep = Annotated[Session, Depends(db.get_session)]


# ---------------------------------------------------------------- schemas


class RouteSummary(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    slug: str
    original_filename: str
    track_name: str | None
    distance_km: float
    elevation_gain_m: float | None
    elevation_loss_m: float | None
    min_elevation_m: float | None
    max_elevation_m: float | None
    start_lat: float
    start_lon: float
    end_lat: float
    end_lon: float
    is_loop: bool
    quality_rating: int | None
    activity: str | None
    paved_pct: float | None
    paved_source: str | None
    tags: list[str]
    notes: str | None
    source_name: str | None
    source_url: str | None
    imported_at: datetime
    derived_from: list[int]


class RouteDetail(RouteSummary):
    gpx_path: str
    track_index: int
    min_lat: float
    min_lon: float
    max_lat: float
    max_lon: float
    geometry: list[list[float]]
    surface: dict | None


class RouteUpdate(BaseModel):
    """Editable metadata. Only fields that are sent are changed."""

    name: str | None = Field(default=None, min_length=1, max_length=300)
    activity: str | None = None
    quality_rating: int | None = Field(default=None, ge=1, le=5)
    paved_pct: float | None = Field(default=None, ge=0, le=100)
    tags: list[str] | None = None
    notes: str | None = None
    source_name: str | None = None
    source_url: str | None = None

    @field_validator("activity")
    @classmethod
    def _check_activity(cls, v):
        return check_activity(v) if v is not None else v

    @field_validator("tags")
    @classmethod
    def _normalise_tags(cls, v):
        return normalise_tags(v) if v is not None else v


def check_activity(value: str) -> str:
    value = value.strip().lower()
    if value not in config.ACTIVITIES:
        raise ValueError(f"activity must be one of {', '.join(config.ACTIVITIES)}")
    return value


# ---------------------------------------------------------------- routes

SORTABLE = {
    "name", "distance_km", "elevation_gain_m", "paved_pct", "quality_rating",
    "source_name", "imported_at", "is_loop", "activity",
}


def filter_routes(
    session: Session,
    q: str | None = None,
    min_distance: float | None = None,
    max_distance: float | None = None,
    min_gain: float | None = None,
    max_gain: float | None = None,
    min_paved: float | None = None,
    max_paved: float | None = None,
    min_quality: int | None = None,
    tags: list[str] | None = None,
    source: str | None = None,
    loop: bool | None = None,
    sort: str = "name",
    order: str = "asc",
    ids: list[int] | None = None,
    activity: str | None = None,
) -> list[Route]:
    """Shared filter logic for the library table, the map and proximity."""
    stmt = select(Route)
    if q:
        stmt = stmt.where(Route.name.ilike(f"%{q}%") | Route.notes.ilike(f"%{q}%"))
    if min_distance is not None:
        stmt = stmt.where(Route.distance_km >= min_distance)
    if max_distance is not None:
        stmt = stmt.where(Route.distance_km <= max_distance)
    if min_gain is not None:
        stmt = stmt.where(Route.elevation_gain_m >= min_gain)
    if max_gain is not None:
        stmt = stmt.where(Route.elevation_gain_m <= max_gain)
    if min_paved is not None:
        stmt = stmt.where(Route.paved_pct >= min_paved)
    if max_paved is not None:
        stmt = stmt.where(Route.paved_pct <= max_paved)
    if min_quality is not None:
        stmt = stmt.where(Route.quality_rating >= min_quality)
    if source:
        stmt = stmt.where(Route.source_name == source)
    if loop is not None:
        stmt = stmt.where(Route.is_loop == loop)
    if activity:
        stmt = stmt.where(Route.activity == activity)
    if ids:
        stmt = stmt.where(Route.id.in_(ids))

    col = getattr(Route, sort if sort in SORTABLE else "name")
    if sort in ("name", "source_name") or sort not in SORTABLE:
        col = func.lower(col)
    col = col.desc() if order == "desc" else col.asc()
    # Empty values last, whatever the direction.
    stmt = stmt.order_by(col.nulls_last(), func.lower(Route.name).asc())
    routes = list(session.scalars(stmt).all())

    wanted = normalise_tags(tags or [])
    if wanted:
        routes = [r for r in routes if all(t in (r.tags or []) for t in wanted)]
    return routes


def _get_route(session: Session, route_id: int) -> Route:
    route = session.get(Route, route_id)
    if route is None:
        raise HTTPException(404, "Route not found")
    return route


def route_filters(
    q: str | None = None,
    min_distance: float | None = None,
    max_distance: float | None = None,
    min_gain: float | None = None,
    max_gain: float | None = None,
    min_paved: float | None = None,
    max_paved: float | None = None,
    min_quality: int | None = None,
    tags: Annotated[list[str] | None, Query()] = None,
    source: str | None = None,
    loop: bool | None = None,
    sort: str = "name",
    order: str = "asc",
    ids: Annotated[list[int] | None, Query()] = None,
    activity: str | None = None,
) -> dict:
    """Query parameters shared by every endpoint that works on a filtered set of routes."""
    return dict(
        q=q, min_distance=min_distance, max_distance=max_distance, min_gain=min_gain,
        max_gain=max_gain, min_paved=min_paved, max_paved=max_paved, min_quality=min_quality,
        tags=tags, source=source, loop=loop, sort=sort, order=order, ids=ids, activity=activity,
    )


FiltersDep = Annotated[dict, Depends(route_filters)]


@app.get("/api/routes", response_model=list[RouteSummary])
def list_routes(session: SessionDep, filters: FiltersDep):
    return filter_routes(session, **filters)


@app.get("/api/map")
def map_routes(
    session: SessionDep,
    filters: FiltersDep,
    tolerance_m: Annotated[float, Query(ge=0, le=100)] = 10,
):
    """Filtered routes with a (further simplified) geometry, for the overview map."""
    return [
        {
            "id": r.id,
            "name": r.name,
            "distance_km": r.distance_km,
            "elevation_gain_m": r.elevation_gain_m,
            "is_loop": r.is_loop,
            "activity": r.activity,
            "quality_rating": r.quality_rating,
            "tags": r.tags,
            "source_name": r.source_name,
            "geometry": simplify_latlon(r.geometry, tolerance_m),
        }
        for r in filter_routes(session, **filters)
    ]


@app.get("/api/proximity")
def proximity(
    session: SessionDep,
    filters: FiltersDep,
    distance_m: Annotated[float | None, Query(ge=0)] = None,
):
    """Pairs of (filtered) routes that overlap or come within distance_m of each other."""
    d = config.PROXIMITY_DISTANCE_M if distance_m is None else distance_m
    if d > config.PROXIMITY_MAX_DISTANCE_M:
        raise HTTPException(422, f"distance_m can be at most {config.PROXIMITY_MAX_DISTANCE_M:g}")
    routes = filter_routes(session, **filters)
    return {
        "distance_m": d,
        "pairs": [p.__dict__ for p in proximity_pairs(routes, d)],
    }


@app.get("/api/routes/{route_id}", response_model=RouteDetail)
def get_route(route_id: int, session: SessionDep):
    return _get_route(session, route_id)


@app.patch("/api/routes/{route_id}", response_model=RouteDetail)
def update_route(route_id: int, update: RouteUpdate, session: SessionDep):
    route = _get_route(session, route_id)
    changes = update.model_dump(exclude_unset=True)
    for key, value in changes.items():
        if key == "name" and not value:
            continue
        if isinstance(value, str):
            value = value.strip() or None
        setattr(route, key, value)
    if "paved_pct" in changes:
        # A value typed by the user wins over the estimate; clearing it falls back to the estimate.
        if changes["paved_pct"] is not None:
            route.paved_source = "manual"
        elif route.surface and route.surface.get("paved_pct") is not None:
            route.paved_pct = route.surface["paved_pct"]
            route.paved_source = "estimated"
        else:
            route.paved_source = None
    session.commit()
    return route


class RouteIds(BaseModel):
    ids: list[int] = Field(min_length=1)


class TagChange(BaseModel):
    ids: list[int] = Field(min_length=1)
    add: list[str] = []
    remove: list[str] = []


@app.post("/api/routes/tags")
def change_tags(body: TagChange, session: SessionDep):
    """Add and/or remove tags on several routes at once."""
    add, remove = normalise_tags(body.add), set(normalise_tags(body.remove))
    if not add and not remove:
        raise HTTPException(422, "Give at least one tag to add or remove")
    updated = 0
    for route in session.scalars(select(Route).where(Route.id.in_(body.ids))).all():
        tags = [t for t in (route.tags or []) if t not in remove]
        tags += [t for t in add if t not in tags]
        if tags != (route.tags or []):
            route.tags = tags
            updated += 1
    session.commit()
    return {"updated": updated}


class ActivityChange(BaseModel):
    ids: list[int] = Field(min_length=1)
    activity: str

    @field_validator("activity")
    @classmethod
    def _check(cls, v):
        return check_activity(v)


@app.post("/api/routes/activity")
def set_activity(body: ActivityChange, session: SessionDep):
    """Set the activity of several routes."""
    updated = 0
    for route in session.scalars(select(Route).where(Route.id.in_(body.ids))).all():
        if route.activity != body.activity:
            route.activity = body.activity
            updated += 1
    session.commit()
    return {"updated": updated}


@app.post("/api/routes/delete")
def delete_routes(body: RouteIds, session: SessionDep):
    """Remove several routes from the library. GPX files on disk are left untouched."""
    routes = session.scalars(select(Route).where(Route.id.in_(body.ids))).all()
    for route in routes:
        session.delete(route)
    ids = [r.id for r in routes]
    for row in session.scalars(
        select(IgnoredDuplicate).where(IgnoredDuplicate.a_id.in_(ids) | IgnoredDuplicate.b_id.in_(ids))
    ).all():
        session.delete(row)
    session.commit()
    return {"deleted": len(routes)}


@app.get("/api/export/gpx.zip")
def export_zip(session: SessionDep, ids: Annotated[list[int], Query(min_length=1)]):
    """The original GPX files of the given routes as one zip file.

    Routes that come from the same multi-track file share one entry.
    """
    routes = session.scalars(select(Route).where(Route.id.in_(ids)).order_by(func.lower(Route.name))).all()
    if not routes:
        raise HTTPException(404, "No routes found")
    buf = io.BytesIO()
    seen_paths: set[str] = set()
    used_names: set[str] = set()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for route in routes:
            if route.gpx_path in seen_paths:
                continue
            path = (config.GPX_DIR / route.gpx_path).resolve()
            if not path.is_relative_to(config.GPX_DIR) or not path.is_file():
                continue
            seen_paths.add(route.gpx_path)
            name = Path(route.original_filename).name or f"route-{route.id}.gpx"
            stem, suffix, n = Path(name).stem, Path(name).suffix or ".gpx", 2
            while name.lower() in used_names:
                name = f"{stem} ({n}){suffix}"
                n += 1
            used_names.add(name.lower())
            zf.write(path, name)
    if not seen_paths:
        raise HTTPException(404, "GPX files not found on disk")
    return Response(
        buf.getvalue(),
        media_type="application/zip",
        headers={"Content-Disposition": 'attachment; filename="routes.zip"'},
    )


@app.delete("/api/routes/{route_id}", status_code=204)
def delete_route(route_id: int, session: SessionDep):
    """Remove the route from the library. The GPX file on disk is left untouched."""
    route = _get_route(session, route_id)
    session.delete(route)
    session.commit()


@app.get("/api/routes/{route_id}/gpx")
def download_gpx(route_id: int, session: SessionDep):
    route = _get_route(session, route_id)
    path = (config.GPX_DIR / route.gpx_path).resolve()
    if not path.is_relative_to(config.GPX_DIR) or not path.is_file():
        raise HTTPException(404, "GPX file not found on disk")
    return FileResponse(path, media_type="application/gpx+xml", filename=route.original_filename)


@app.get("/api/routes/{route_id}/similar")
def similar_routes(route_id: int, session: SessionDep):
    """Routes that overlap strongly with this one (either direction)."""
    route = _get_route(session, route_id)
    others = session.scalars(select(Route).where(Route.id != route.id)).all()
    by_id = {o.id: o for o in others}
    return [
        {
            "id": s.other_id,
            "name": by_id[s.other_id].name,
            "this_covered_pct": round(s.a_in_b * 100),
            "other_covered_pct": round(s.b_in_a * 100),
            "very_similar": s.very_similar,
        }
        for s in find_similar(route.geometry, route.bbox, others)
    ]


@app.get("/api/version")
def version():
    return {"version": __version__}


@app.get("/api/config")
def client_config():
    """Settings the frontend needs."""
    return {
        "proximity_distance_m": config.PROXIMITY_DISTANCE_M,
        "proximity_max_distance_m": config.PROXIMITY_MAX_DISTANCE_M,
        "brouter_profiles": config.BROUTER_PROFILES,
        "activities": config.ACTIVITIES,
        "activity_profiles": config.ACTIVITY_PROFILES,
    }


@app.get("/api/facets")
def facets(session: SessionDep):
    """Values for the filter controls, plus client settings."""
    routes = session.scalars(select(Route)).all()
    tag_counts: dict[str, int] = {}
    for r in routes:
        for t in r.tags or []:
            tag_counts[t] = tag_counts.get(t, 0) + 1
    return {
        "count": len(routes),
        "proximity_distance_m": config.PROXIMITY_DISTANCE_M,
        "proximity_max_distance_m": config.PROXIMITY_MAX_DISTANCE_M,
        "sources": sorted({r.source_name for r in routes if r.source_name}),
        "tags": sorted(tag_counts.items(), key=lambda kv: (-kv[1], kv[0])),
    }


def _split_tags(value) -> list[str]:
    """Tags given as "a, b" or ["a", "b"]."""
    if not value:
        return []
    items = value.split(",") if isinstance(value, str) else [str(v) for v in value]
    return [t for t in items if t.strip()]


@app.post("/api/import")
async def import_files(
    session: SessionDep,
    files: Annotated[list[UploadFile], File()],
    source_name: Annotated[str | None, Form()] = None,
    source_url: Annotated[str | None, Form()] = None,
    activity: Annotated[str | None, Form()] = None,
    tags: Annotated[str | None, Form()] = None,  # comma separated, for the whole batch
    # JSON list aligned with `files`:
    # [{"source_name": ..., "source_url": ..., "activity": ..., "tags": "extra, tags"}, ...]
    overrides: Annotated[str | None, Form()] = None,
):
    try:
        per_file = json.loads(overrides) if overrides else []
    except json.JSONDecodeError:
        raise HTTPException(400, "overrides must be a JSON list")
    results = []
    try:
        batch_activity = check_activity(activity) if activity else None
        file_activities = [
            check_activity(ov["activity"]) if isinstance(ov, dict) and ov.get("activity") else None
            for ov in per_file
        ]
    except ValueError as exc:
        raise HTTPException(422, str(exc))
    batch_tags = _split_tags(tags)
    for i, upload in enumerate(files):
        ov = per_file[i] if i < len(per_file) and isinstance(per_file[i], dict) else {}
        data = await upload.read()
        res = import_gpx(
            session,
            data,
            upload.filename or f"upload-{i + 1}.gpx",
            source_name=(ov.get("source_name") or source_name or "").strip() or None,
            source_url=(ov.get("source_url") or source_url or "").strip() or None,
            activity=(file_activities[i] if i < len(file_activities) else None) or batch_activity,
            # Per-file tags are added to the batch tags.
            tags=batch_tags + _split_tags(ov.get("tags")),
        )
        results.append(res.__dict__)
    new_ids = [r["id"] for res in results for r in res["routes"]]
    if new_ids and config.SURFACE_AUTO_ESTIMATE:
        surface.worker.enqueue(new_ids)
    return {"results": results}



# ---------------------------------------------------------------- combiner (phase 3)


@lru_cache(maxsize=64)
def _cached_track(path: str, track_index: int, mtime_ns: int, is_loop: bool) -> combiner.Track:
    tracks = parse_gpx(Path(path).read_bytes()).tracks
    return combiner.make_track(tracks[track_index].points, is_loop=is_loop)


def load_track(route: Route) -> combiner.Track:
    """Full-resolution track of a route, read from its (never modified) GPX file."""
    path = (config.GPX_DIR / route.gpx_path).resolve()
    if not path.is_file():
        raise HTTPException(404, f"GPX file of '{route.name}' not found on disk")
    return _cached_track(str(path), route.track_index, path.stat().st_mtime_ns, route.is_loop)


def _latlon(p) -> list[float]:
    return [round(p[0], 6), round(p[1], 6)]


@app.get("/api/combine/suggest")
def combine_suggest(
    session: SessionDep,
    a_id: int,
    b_id: int,
    count: Annotated[int, Query(ge=1, le=2)] = 1,
):
    """Suggested connection point pairs: where routes A and B come closest."""
    if a_id == b_id:
        raise HTTPException(422, "Choose two different routes")
    a, b = load_track(_get_route(session, a_id)), load_track(_get_route(session, b_id))
    try:
        connections = combiner.suggest_connections(a, b, count)
        # The same suggestion as four points: loop (count=2) or point to point (count=1).
        parts = combiner.suggest_parts(a, b, closed=count == 2)
    except combiner.CombineError as exc:
        raise HTTPException(422, str(exc))
    out = []
    for c in connections:
        pa, pb = combiner.point_at(a, c.a_at), combiner.point_at(b, c.b_at)
        out.append(
            {
                "a": _latlon(combiner._latlon_of(pa)),
                "b": _latlon(combiner._latlon_of(pb)),
                "distance_m": round(float(((pa[0] - pb[0]) ** 2 + (pa[1] - pb[1]) ** 2) ** 0.5)),
            }
        )
    route_ids = [a_id, b_id]
    return {"connections": out, "parts": [_part_out(p, route_ids[i]) for i, p in enumerate(parts)]}


def _part_out(p: combiner.Part, route_id: int) -> dict:
    return {
        "route_id": route_id,
        "start": _latlon(combiner._latlon_of(combiner.point_at(p.track, p.start_at))),
        "end": _latlon(combiner._latlon_of(combiner.point_at(p.track, p.end_at))),
        "start_km": round(p.start_at / 1000, 2),
        "end_km": round(p.end_at / 1000, 2),
        "other_way": p.other_way,
    }


class ConnectionIn(BaseModel):
    a: tuple[float, float]  # [lat, lon] near route A
    b: tuple[float, float]  # [lat, lon] near route B


class PartIn(BaseModel):
    route_id: int
    start: tuple[float, float]  # [lat, lon] near the route: where to join it
    end: tuple[float, float]  # [lat, lon] near the route: where to leave it
    other_way: bool = False  # loop routes: the other way round, through the route's start/end


MAX_PARTS = 6


class CombineRequest(BaseModel):
    # Parts: each route ridden from its start to its end point (A1 -> A2 -> B1 -> B2 ...).
    parts: list[PartIn] | None = Field(None, min_length=2, max_length=MAX_PARTS)
    closed: bool = True  # parts: add a connector from the last part back to the first
    # Connections (the older form): routes A and B with one or two connection pairs.
    a_id: int | None = None
    b_id: int | None = None
    connections: list[ConnectionIn] | None = Field(None, min_length=1, max_length=2)
    reverse_a: bool = False
    reverse_b: bool = False
    reverse: bool = False
    profile: str | None = None
    prefer_unpaved: bool = False
    straight: bool = False  # join with straight lines instead of routing


class SaveCombinedRequest(CombineRequest):
    name: str = Field(min_length=1, max_length=300)
    notes: str | None = None


def _names(routes: list[Route]) -> str:
    names = [f"'{r.name}'" for r in routes]
    return names[0] if len(names) == 1 else ", ".join(names[:-1]) + f" and {names[-1]}"


def _run_combine(session: Session, req: CombineRequest):
    """(routes used, result, description) for either request form."""
    if req.parts:
        ids = [p.route_id for p in req.parts]
        if len(set(ids)) < 2:
            raise HTTPException(422, "Choose at least two different routes")
    elif req.a_id is None or req.b_id is None or not req.connections:
        raise HTTPException(422, "Give either parts, or a_id, b_id and connections")
    elif req.a_id == req.b_id:
        raise HTTPException(422, "Choose two different routes")
    else:
        ids = [req.a_id, req.b_id]
    routes = {i: _get_route(session, i) for i in ids}
    tracks = {i: load_track(r) for i, r in routes.items()}
    activities = {r.activity for r in routes.values()}
    default = config.ACTIVITY_PROFILES.get(activities.pop()) if len(activities) == 1 else None
    profile = req.profile or default or config.BROUTER_PROFILES[0]
    if profile not in config.BROUTER_PROFILES:
        raise HTTPException(422, f"Unknown profile '{profile}'")
    params = {"prefer_unpaved_paths": "1"} if req.prefer_unpaved and profile == "gravel" else None

    def router(p, q):
        return brouter.route(p, q, profile, params)

    use_router = combiner.straight_router if req.straight else router
    try:
        if req.parts:
            parts = [
                combiner.Part(
                    tracks[p.route_id],
                    combiner.locate(tracks[p.route_id], *p.start),
                    combiner.locate(tracks[p.route_id], *p.end),
                    p.other_way,
                )
                for p in req.parts
            ]
            result = combiner.combine_parts(
                parts, use_router, closed=req.closed, reverse=req.reverse, direct_join_m=config.DIRECT_JOIN_M
            )
        else:
            a, b = tracks[req.a_id], tracks[req.b_id]
            connections = [
                combiner.Connection(combiner.locate(a, *c.a), combiner.locate(b, *c.b)) for c in req.connections
            ]
            result = combiner.combine(
                a, b, connections,
                router=use_router,
                reverse_a=req.reverse_a,
                reverse_b=req.reverse_b,
                reverse=req.reverse,
                direct_join_m=config.DIRECT_JOIN_M,
            )
    except combiner.CombineError as exc:
        raise HTTPException(422, str(exc))
    except brouter.BRouterUnavailable as exc:
        raise HTTPException(503, str(exc))
    except brouter.BRouterError as exc:
        raise HTTPException(502, str(exc))
    how = "straight lines" if req.straight else f"BRouter ({profile}{', prefer unpaved' if params else ''})"
    used = list({i: routes[i] for i in ids}.values())  # in order, without repeats
    description = f"Combined from {_names(used)} via {how}."
    return used, result, description


@app.post("/api/combine/preview")
def combine_preview(req: CombineRequest, session: SessionDep):
    _, result, description = _run_combine(session, req)
    stats = compute_stats(result.points)
    return {
        "description": description,
        "crossing": bool(result.parts) and combiner.connectors_cross(result.parts, req.closed),
        "parts": [
            {
                "route_id": p.route_id,
                "start": _latlon(start),
                "end": _latlon(end),
                "start_km": round(part.start_at / 1000, 2),
                "end_km": round(part.end_at / 1000, 2),
                "distance_km": round(combiner._leg_length(leg.xyz) / 1000, 2),
            }
            for p, part, (start, end), leg in zip(
                req.parts or [], result.parts, result.part_points, [l for l in result.legs if l.kind != "connector"]
            )
        ],
        "distance_km": stats.distance_km,
        "elevation_gain_m": stats.elevation_gain_m,
        "elevation_loss_m": stats.elevation_loss_m,
        "is_loop": stats.is_loop,
        "start": [stats.start_lat, stats.start_lon],
        "end": [stats.end_lat, stats.end_lon],
        "connectors": [
            {"distance_km": round(combiner._leg_length(leg.xyz) / 1000, 2), "routed": leg.routed}
            for leg in result.connectors
        ],
        "connections": [
            {
                "a": _latlon(pa),
                "b": _latlon(pb),
                "a_at_km": round(c.a_at / 1000, 2),
                "b_at_km": round(c.b_at / 1000, 2),
            }
            for c, (pa, pb) in zip(result.connections, result.connection_points)
        ],
        "legs": [
            {
                "kind": leg.kind,
                "routed": leg.routed,
                "geometry": simplify_latlon([_latlon(p) for p in combiner.to_latlon(leg.xyz)], 5),
            }
            for leg in result.legs
            if len(leg.xyz) >= 2
        ],
    }


@app.post("/api/combine/gpx")
def combine_gpx(req: SaveCombinedRequest, session: SessionDep):
    """The combined route as a GPX download, without saving it."""
    _, result, description = _run_combine(session, req)
    data = write_gpx(req.name, result.points, description)
    filename = f"{req.name}.gpx".replace('"', "")
    return Response(
        data,
        media_type="application/gpx+xml",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.post("/api/combine/save")
def combine_save(req: SaveCombinedRequest, session: SessionDep):
    """Save the combination as a new route (new GPX file under gpx/derived/)."""
    routes, result, description = _run_combine(session, req)
    name = req.name.strip()
    data = write_gpx(name, result.points, description)
    existing = session.scalars(select(Route).where(Route.file_hash == file_hash(data))).first()
    if existing:
        raise HTTPException(409, f"This combination is already saved as '{existing.name}'")
    path = store_derived(data, name)
    notes = description + (f"\n\n{req.notes.strip()}" if req.notes and req.notes.strip() else "")
    tags = normalise_tags([t for r in routes for t in (r.tags or [])])
    res = import_gpx(
        session, data, Path(path).name,
        source_name="combined",
        library_path=path,
        derived_from=[r.id for r in routes],
        tags=tags,
        notes=notes,
        activity=routes[0].activity,
    )
    if res.status != "imported":
        raise HTTPException(500, f"Could not save the combined route: {res.message}")
    if config.SURFACE_AUTO_ESTIMATE:
        surface.worker.enqueue([res.routes[0]["id"]])
    return {"id": res.routes[0]["id"], "name": res.routes[0]["name"], "gpx_path": path, "similar": res.similar}


# ---------------------------------------------------------------- new start point (utility)


class RestartRequest(BaseModel):
    route_id: int
    start: tuple[float, float]  # [lat, lon] near the route: the new start point
    reverse: bool = False  # ride the loop the other way round


class SaveRestartRequest(RestartRequest):
    name: str = Field(min_length=1, max_length=300)


def _run_restart(session: Session, req: RestartRequest):
    """(route, new points, position of the new start in metres, description)."""
    route = _get_route(session, req.route_id)
    if not route.is_loop:
        raise HTTPException(422, f"'{route.name}' is not a loop: only a loop can start somewhere else")
    track = load_track(route)
    at = combiner.locate(track, *req.start)
    try:
        xyz = combiner.restart_loop(track, at, reverse=req.reverse)
    except combiner.CombineError as exc:
        raise HTTPException(422, str(exc))
    description = (
        f"'{route.name}' starting {at / 1000:.1f} km along the original"
        + (", ridden the other way round." if req.reverse else ".")
    )
    return route, combiner.to_latlon(xyz), at, description


def _start_place(geometry: list[list[float]]) -> str | None:
    """Name of the town where a loop starts, if place data is available."""
    try:
        return places.generate_name(geometry, True)["start"]
    except Exception:  # no place data: the name is only a suggestion
        return None


@app.post("/api/restart/preview")
def restart_preview(req: RestartRequest, session: SessionDep):
    route, points, at, description = _run_restart(session, req)
    stats = compute_stats(points)
    return {
        "description": description,
        "start": _latlon(points[0]),
        "start_km": round(at / 1000, 2),
        "start_place": _start_place(stats.geometry),
        "distance_km": stats.distance_km,
        "elevation_gain_m": stats.elevation_gain_m,
        "elevation_loss_m": stats.elevation_loss_m,
        "geometry": stats.geometry,
    }


def _gpx_response(name: str, data: bytes) -> Response:
    filename = f"{name}.gpx".replace('"', "")
    return Response(
        data,
        media_type="application/gpx+xml",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.post("/api/restart/gpx")
def restart_gpx(req: SaveRestartRequest, session: SessionDep):
    """The loop with its new start point as a GPX download, without saving it."""
    _, points, _, description = _run_restart(session, req)
    return _gpx_response(req.name, write_gpx(req.name, points, description))


@app.post("/api/restart/save")
def restart_save(req: SaveRestartRequest, session: SessionDep):
    """Save the loop with its new start point as a new route (new GPX file under gpx/derived/).
    The original route and its file are left as they are."""
    route, points, _, description = _run_restart(session, req)
    name = req.name.strip()
    data = write_gpx(name, points, description)
    path = store_derived(data, name)
    notes = description + (f"\n\n{route.notes.strip()}" if route.notes and route.notes.strip() else "")
    res = import_gpx(
        session, data, Path(path).name,
        source_name=route.source_name,
        source_url=route.source_url,
        library_path=path,
        derived_from=[route.id],
        tags=list(route.tags or []),
        notes=notes,
        activity=route.activity,
    )
    if res.status != "imported":
        (config.GPX_DIR / path).unlink(missing_ok=True)
        if res.status == "duplicate" and res.duplicates:
            raise HTTPException(409, f"This route is already saved as '{res.duplicates[0]['name']}'")
        raise HTTPException(500, f"Could not save the route: {res.message}")
    new = _get_route(session, res.routes[0]["id"])
    # Same roads, so the same personal rating and surface.
    new.quality_rating = route.quality_rating
    new.paved_pct, new.paved_source = route.paved_pct, route.paved_source
    # It lies on the same roads as the original (and as the original's other new starts):
    # a deliberate variant, so keep them out of the duplicates list.
    siblings = [r.id for r in session.scalars(select(Route)).all() if r.derived_from == [route.id] and r.id != new.id]
    for other in [route.id, *siblings]:
        session.add(IgnoredDuplicate(a_id=min(other, new.id), b_id=max(other, new.id)))
    session.commit()
    if config.SURFACE_AUTO_ESTIMATE and route.paved_source != "manual":
        surface.worker.enqueue([new.id])
    return {"id": new.id, "name": new.name, "gpx_path": path}


# ---------------------------------------------------------------- surface (phase 4)


@app.post("/api/routes/{route_id}/surface", response_model=RouteDetail)
def estimate_surface(route_id: int, session: SessionDep, overwrite_manual: bool = False):
    """Estimate the surface of one route now (map matching through BRouter)."""
    route = _get_route(session, route_id)
    try:
        result = surface.estimate(load_track(route))
    except brouter.BRouterUnavailable as exc:
        raise HTTPException(503, str(exc))
    except brouter.BRouterError as exc:
        raise HTTPException(502, str(exc))
    surface.apply_estimate(route, result, overwrite_manual)
    session.commit()
    return route


class SurfaceJob(BaseModel):
    ids: list[int] = Field(min_length=1)
    force: bool = False  # also routes that already have an estimate
    overwrite_manual: bool = False


@app.post("/api/surface/estimate")
def estimate_surface_bulk(job: SurfaceJob):
    """Queue surface estimates for several routes (runs in the background)."""
    added = surface.worker.enqueue(job.ids, force=job.force, overwrite_manual=job.overwrite_manual)
    return {"queued": added, **surface.worker.status()}


@app.get("/api/surface/status")
def surface_status():
    return surface.worker.status()


# ---------------------------------------------------------------- duplicates (phase 4)


def _ignored_pairs(session: Session) -> set[tuple[int, int]]:
    return {(r.a_id, r.b_id) for r in session.scalars(select(IgnoredDuplicate)).all()}


@app.get("/api/duplicates")
def duplicates(session: SessionDep):
    """Groups of near-duplicate routes, and variants (a route lying on another route)."""
    routes = session.scalars(select(Route)).all()
    by_id = {r.id: r for r in routes}
    ignored = _ignored_pairs(session)
    pairs = [
        p for p in duplicate_pairs(routes, config.SIMILAR_TOLERANCE_M, min(config.VARIANT_MIN_OVERLAP, config.SIMILAR_MIN_OVERLAP))
        if (min(p.a_id, p.b_id), max(p.a_id, p.b_id)) not in ignored
    ]
    groups = group_pairs(pairs, config.SIMILAR_MIN_OVERLAP)
    in_group = {rid: i for i, g in enumerate(groups) for rid in g}

    def summary(r: Route) -> dict:
        return {
            "id": r.id, "name": r.name, "source_name": r.source_name, "distance_km": r.distance_km,
            "elevation_gain_m": r.elevation_gain_m, "quality_rating": r.quality_rating, "tags": r.tags,
            "has_notes": bool(r.notes), "imported_at": r.imported_at, "gpx_path": r.gpx_path,
            "is_derived": bool(r.derived_from),
        }

    def keep_score(r: Route):
        # Suggest keeping the route with the most personal metadata, then the oldest import.
        return (-(r.quality_rating is not None) - bool(r.tags) - bool(r.notes) - (r.paved_source == "manual"), r.imported_at, r.id)

    out_groups = []
    for g in groups:
        members = sorted((by_id[i] for i in g), key=keep_score)
        gp = [p for p in pairs if p.a_id in g and p.b_id in g]
        out_groups.append({
            "routes": [summary(r) for r in members],
            "suggested_keep": members[0].id,
            "pairs": [
                {"a": p.a_id, "b": p.b_id, "a_in_b_pct": round(p.a_in_b * 100), "b_in_a_pct": round(p.b_in_a * 100),
                 "reversed": p.reversed, "same_track": by_id[p.a_id].track_hash == by_id[p.b_id].track_hash}
                for p in gp
            ],
        })
    out_groups.sort(key=lambda g: g["routes"][0]["name"].lower())

    variants = []
    for p in pairs:
        if min(p.a_in_b, p.b_in_a) >= config.SIMILAR_MIN_OVERLAP:
            continue  # already in a group
        part, whole = (p.a_id, p.b_id) if p.a_in_b >= p.b_in_a else (p.b_id, p.a_id)
        covered = max(p.a_in_b, p.b_in_a)
        if covered < config.VARIANT_MIN_OVERLAP:
            continue
        variants.append({
            "part": summary(by_id[part]), "whole": summary(by_id[whole]),
            "covered_pct": round(covered * 100), "reversed": p.reversed,
        })
    variants.sort(key=lambda v: (v["whole"]["name"].lower(), v["part"]["name"].lower()))
    return {"groups": out_groups, "variants": variants}


@app.post("/api/duplicates/ignore")
def ignore_duplicates(body: RouteIds, session: SessionDep):
    """Mark routes as "not duplicates" of each other (every pair among the given ids)."""
    ignored = _ignored_pairs(session)
    ids = sorted(set(body.ids))
    added = 0
    for i, a in enumerate(ids):
        for b in ids[i + 1:]:
            if (a, b) not in ignored:
                session.add(IgnoredDuplicate(a_id=a, b_id=b))
                added += 1
    session.commit()
    return {"ignored_pairs": added}


@app.post("/api/duplicates/reset")
def reset_ignored_duplicates(session: SessionDep):
    """Forget all "not duplicates" decisions."""
    n = 0
    for row in session.scalars(select(IgnoredDuplicate)).all():
        session.delete(row)
        n += 1
    session.commit()
    return {"reset": n}


# ---------------------------------------------------------------- route names


@app.get("/api/rename/proposals")
def rename_proposals(session: SessionDep, ids: Annotated[list[int] | None, Query()] = None):
    """Generated names (start town + places visited) for the given routes, or all routes."""
    stmt = select(Route).order_by(func.lower(Route.name))
    if ids:
        stmt = stmt.where(Route.id.in_(ids))
    routes = session.scalars(stmt).all()
    try:
        place_data = places.load()
    except places.PlacesUnavailable as exc:
        raise HTTPException(503, str(exc))
    chosen = set(n.lower() for n in session.scalars(select(Route.name)).all())
    out = []
    for r in routes:
        g = places.generate_name(r.geometry, r.is_loop, place_data)
        proposal = g["name"]
        if proposal and proposal.lower() != r.name.lower():
            proposal = places.disambiguate(proposal, r.distance_km, chosen - {r.name.lower()})
            chosen.add(proposal.lower())
        out.append({
            "id": r.id, "name": r.name, "proposal": proposal, "distance_km": r.distance_km,
            "source_name": r.source_name, "is_derived": bool(r.derived_from),
            "original_name_in_notes": (r.notes or "").startswith(places.ORIGINAL_PREFIX),
        })
    return out


class RenameItem(BaseModel):
    id: int
    name: str = Field(min_length=1, max_length=300)


class RenameRequest(BaseModel):
    items: list[RenameItem] = Field(min_length=1)


@app.post("/api/rename/apply")
def rename_apply(req: RenameRequest, session: SessionDep):
    """Rename routes; the original name is kept at the top of the notes."""
    renamed = 0
    for item in req.items:
        route = session.get(Route, item.id)
        new = item.name.strip()
        if route is None or not new or new == route.name:
            continue
        route.notes = places.notes_with_original(route.notes, route.name)
        route.name = new
        route.slug = unique_slug(session, new)
        renamed += 1
    session.commit()
    return {"renamed": renamed}


# ---------------------------------------------------------------- frontend


@app.get("/", include_in_schema=False)
def index():
    return FileResponse(STATIC_DIR / "index.html")


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
