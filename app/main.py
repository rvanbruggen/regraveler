"""FastAPI application: JSON API + static single-page frontend."""
from __future__ import annotations

import json
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path
from typing import Annotated

from fastapi import Depends, FastAPI, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from . import config, db
from .importer import import_gpx
from .models import Route
from .similarity import find_similar

STATIC_DIR = Path(__file__).parent / "static"


@asynccontextmanager
async def lifespan(_app: FastAPI):
    if db.engine is None:
        db.init_db()
    config.GPX_DIR.mkdir(parents=True, exist_ok=True)
    yield


app = FastAPI(title="Gravel Route Manager", lifespan=lifespan)
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
) -> list[Route]:
    """Shared filter logic (library table now, map view in phase 2)."""
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


@app.get("/api/routes", response_model=list[RouteSummary])
def list_routes(
    session: SessionDep,
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
):
    return filter_routes(
        session, q, min_distance, max_distance, min_gain, max_gain, min_paved,
        max_paved, min_quality, tags, source, loop, sort, order,
    )


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


@app.get("/api/facets")
def facets(session: SessionDep):
    """Values for the filter controls."""
    routes = session.scalars(select(Route)).all()
    tag_counts: dict[str, int] = {}
    for r in routes:
        for t in r.tags or []:
            tag_counts[t] = tag_counts.get(t, 0) + 1
    return {
        "count": len(routes),
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


# ---------------------------------------------------------------- frontend


@app.get("/", include_in_schema=False)
def index():
    return FileResponse(STATIC_DIR / "index.html")


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
