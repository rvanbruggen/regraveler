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

from . import __version__, brouter, combiner, config, db
from .gpxstats import compute_stats, parse_gpx, write_gpx
from .importer import file_hash, import_gpx, store_derived
from .models import Route
from .similarity import find_similar, proximity_pairs, simplify_latlon

STATIC_DIR = Path(__file__).parent / "static"


@asynccontextmanager
async def lifespan(_app: FastAPI):
    if db.engine is None:
        db.init_db()
    config.GPX_DIR.mkdir(parents=True, exist_ok=True)
    yield


app = FastAPI(title="Gravel Route Manager", version=__version__, lifespan=lifespan)
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
    paved_pct: float | None
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


class RouteUpdate(BaseModel):
    """Editable metadata. Only fields that are sent are changed."""

    name: str | None = Field(default=None, min_length=1, max_length=300)
    quality_rating: int | None = Field(default=None, ge=1, le=5)
    paved_pct: float | None = Field(default=None, ge=0, le=100)
    tags: list[str] | None = None
    notes: str | None = None
    source_name: str | None = None
    source_url: str | None = None

    @field_validator("tags")
    @classmethod
    def _normalise_tags(cls, v):
        return normalise_tags(v) if v is not None else v


def normalise_tags(tags: list[str]) -> list[str]:
    out: list[str] = []
    for t in tags:
        t = " ".join(t.strip().lower().split())
        if t and t not in out:
            out.append(t)
    return out


# ---------------------------------------------------------------- routes

SORTABLE = {
    "name", "distance_km", "elevation_gain_m", "paved_pct", "quality_rating",
    "source_name", "imported_at", "is_loop",
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
) -> dict:
    """Query parameters shared by every endpoint that works on a filtered set of routes."""
    return dict(
        q=q, min_distance=min_distance, max_distance=max_distance, min_gain=min_gain,
        max_gain=max_gain, min_paved=min_paved, max_paved=max_paved, min_quality=min_quality,
        tags=tags, source=source, loop=loop, sort=sort, order=order, ids=ids,
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
    for key, value in update.model_dump(exclude_unset=True).items():
        if key == "name" and not value:
            continue
        if isinstance(value, str):
            value = value.strip() or None
        setattr(route, key, value)
    session.commit()
    return route


class RouteIds(BaseModel):
    ids: list[int] = Field(min_length=1)


@app.post("/api/routes/delete")
def delete_routes(body: RouteIds, session: SessionDep):
    """Remove several routes from the library. GPX files on disk are left untouched."""
    routes = session.scalars(select(Route).where(Route.id.in_(body.ids))).all()
    for route in routes:
        session.delete(route)
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


@app.post("/api/import")
async def import_files(
    session: SessionDep,
    files: Annotated[list[UploadFile], File()],
    source_name: Annotated[str | None, Form()] = None,
    source_url: Annotated[str | None, Form()] = None,
    # JSON list aligned with `files`: [{"source_name": ..., "source_url": ...}, ...]
    overrides: Annotated[str | None, Form()] = None,
):
    try:
        per_file = json.loads(overrides) if overrides else []
    except json.JSONDecodeError:
        raise HTTPException(400, "overrides must be a JSON list")
    results = []
    for i, upload in enumerate(files):
        ov = per_file[i] if i < len(per_file) and isinstance(per_file[i], dict) else {}
        data = await upload.read()
        res = import_gpx(
            session,
            data,
            upload.filename or f"upload-{i + 1}.gpx",
            source_name=(ov.get("source_name") or source_name or "").strip() or None,
            source_url=(ov.get("source_url") or source_url or "").strip() or None,
        )
        results.append(res.__dict__)
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
    out = []
    for c in combiner.suggest_connections(a, b, count):
        pa, pb = combiner.point_at(a, c.a_at), combiner.point_at(b, c.b_at)
        out.append(
            {
                "a": _latlon(combiner._latlon_of(pa)),
                "b": _latlon(combiner._latlon_of(pb)),
                "distance_m": round(float(((pa[0] - pb[0]) ** 2 + (pa[1] - pb[1]) ** 2) ** 0.5)),
            }
        )
    return {"connections": out}


class ConnectionIn(BaseModel):
    a: tuple[float, float]  # [lat, lon] near route A
    b: tuple[float, float]  # [lat, lon] near route B


class CombineRequest(BaseModel):
    a_id: int
    b_id: int
    connections: list[ConnectionIn] = Field(min_length=1, max_length=2)
    reverse_a: bool = False
    reverse_b: bool = False
    reverse: bool = False
    profile: str | None = None
    prefer_unpaved: bool = False
    straight: bool = False  # join with straight lines instead of routing


class SaveCombinedRequest(CombineRequest):
    name: str = Field(min_length=1, max_length=300)
    notes: str | None = None


def _run_combine(session: Session, req: CombineRequest):
    if req.a_id == req.b_id:
        raise HTTPException(422, "Choose two different routes")
    route_a, route_b = _get_route(session, req.a_id), _get_route(session, req.b_id)
    a, b = load_track(route_a), load_track(route_b)
    profile = req.profile or config.BROUTER_PROFILES[0]
    if profile not in config.BROUTER_PROFILES:
        raise HTTPException(422, f"Unknown profile '{profile}'")
    params = {"prefer_unpaved_paths": "1"} if req.prefer_unpaved and profile == "gravel" else None

    def router(p, q):
        return brouter.route(p, q, profile, params)

    connections = [
        combiner.Connection(combiner.locate(a, *c.a), combiner.locate(b, *c.b)) for c in req.connections
    ]
    try:
        result = combiner.combine(
            a, b, connections,
            router=combiner.straight_router if req.straight else router,
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
    description = f"Combined from '{route_a.name}' and '{route_b.name}' via {how}."
    return route_a, route_b, result, description


@app.post("/api/combine/preview")
def combine_preview(req: CombineRequest, session: SessionDep):
    route_a, route_b, result, description = _run_combine(session, req)
    stats = compute_stats(result.points)
    return {
        "description": description,
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
    _, _, result, description = _run_combine(session, req)
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
    route_a, route_b, result, description = _run_combine(session, req)
    name = req.name.strip()
    data = write_gpx(name, result.points, description)
    existing = session.scalars(select(Route).where(Route.file_hash == file_hash(data))).first()
    if existing:
        raise HTTPException(409, f"This combination is already saved as '{existing.name}'")
    path = store_derived(data, name)
    notes = description + (f"\n\n{req.notes.strip()}" if req.notes and req.notes.strip() else "")
    tags = normalise_tags((route_a.tags or []) + (route_b.tags or []))
    res = import_gpx(
        session, data, Path(path).name,
        source_name="combined",
        library_path=path,
        derived_from=[route_a.id, route_b.id],
        tags=tags,
        notes=notes,
    )
    if res.status != "imported":
        raise HTTPException(500, f"Could not save the combined route: {res.message}")
    return {"id": res.routes[0]["id"], "name": res.routes[0]["name"], "gpx_path": path, "similar": res.similar}


# ---------------------------------------------------------------- frontend


@app.get("/", include_in_schema=False)
def index():
    return FileResponse(STATIC_DIR / "index.html")


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
