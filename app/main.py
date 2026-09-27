"""The rerouter server: serves the page and stores the library.

All route logic (GPX parsing, stats, names, combining, similarity, surface) runs in the page
(web/js). The server keeps what the page computes, keeps the original GPX files in the GPX
folder, and passes BRouter requests on to the BRouter container.
"""
from __future__ import annotations

import logging
import urllib.error
import urllib.request
from contextlib import asynccontextmanager
from typing import Annotated
from urllib.parse import quote

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from sqlalchemy.orm import Session

from . import __version__, config, db, legacy, store

log = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    if db.engine is None:
        db.init_db()
    config.GPX_DIR.mkdir(parents=True, exist_ok=True)
    with db.SessionLocal() as session:
        legacy.migrate_if_needed(session)
    yield


app = FastAPI(title="rerouter", version=__version__, lifespan=lifespan)
# The library and backups are mostly coordinates, which compress very well.
app.add_middleware(GZipMiddleware, minimum_size=2000)
SessionDep = Annotated[Session, Depends(db.get_session)]


@app.exception_handler(store.StoreError)
async def _store_error(_request, exc: store.StoreError):
    return JSONResponse({"detail": str(exc)}, status_code=exc.status)


# ---------------------------------------------------------------- info and library


@app.get("/api/info")
def info():
    """Tells the page it is served by a rerouter server (and not a static host)."""
    return {"app": "rerouter", "version": __version__, "mode": "server", "brouter_proxy": bool(config.BROUTER_URL)}


@app.get("/api/version")
def version():
    return {"version": __version__}


@app.get("/api/library")
def get_library(session: SessionDep):
    """Routes, "not duplicates" pairs and settings: everything the page loads at start-up."""
    return store.library(session)


class RoutesIn(BaseModel):
    routes: list[dict]
    base: dict[str, str | None] = {}


@app.put("/api/routes")
def put_routes(body: RoutesIn, session: SessionDep):
    """Save new and changed routes (a batch). New routes get their id here."""
    return {"routes": store.put_routes(session, body.routes, body.base)}


class IdsIn(BaseModel):
    ids: list[int]


@app.post("/api/routes/delete")
def delete_routes(body: IdsIn, session: SessionDep):
    """Remove routes from the library. Their GPX files stay in the GPX folder."""
    return {"deleted": store.delete_routes(session, body.ids)}


# ---------------------------------------------------------------- files


@app.get("/api/files/{file_hash}")
def get_file(file_hash: str, session: SessionDep):
    f, path = store.get_file(session, file_hash)
    return FileResponse(
        path, media_type="application/gpx+xml",
        headers={"X-File-Name": quote(f.name), "Access-Control-Expose-Headers": "X-File-Name"},
    )


@app.put("/api/files/{file_hash}")
async def put_file(file_hash: str, request: Request, session: SessionDep, name: str = "", folder: str = ""):
    """Store an original GPX file (the body). The bytes must match the hash."""
    data = await request.body()
    return {"hash": file_hash, "path": store.put_file(session, file_hash, data, name, folder)}


@app.get("/api/disk-files")
def disk_files(session: SessionDep):
    """GPX files in the GPX folder that are not in the library yet (to import from the page)."""
    return {"files": store.disk_files(session)}


@app.get("/api/disk-files/content")
def disk_file(path: str):
    full = store.resolve(path)
    if not full.is_file() or full.suffix.lower() != ".gpx":
        raise HTTPException(404, "No such GPX file")
    return FileResponse(full, media_type="application/gpx+xml")


# ---------------------------------------------------------------- pairs and settings


class KeysIn(BaseModel):
    keys: list[str]


@app.put("/api/ignored")
def put_ignored(body: KeysIn, session: SessionDep):
    """Mark pairs of routes ("a_b") as "not duplicates"."""
    return {"added": store.put_ignored(session, body.keys)}


@app.post("/api/ignored/delete")
def delete_ignored(body: KeysIn, session: SessionDep):
    return {"deleted": store.delete_ignored(session, body.keys)}


class SettingsIn(BaseModel):
    settings: dict


@app.put("/api/settings")
def put_settings(body: SettingsIn, session: SessionDep):
    store.put_settings(session, body.settings)
    return {"ok": True}


@app.post("/api/library/clear")
def clear(session: SessionDep):
    """Remove every route from the library (the GPX files stay on disk)."""
    store.clear(session)
    return {"ok": True}


# ---------------------------------------------------------------- backups


@app.get("/api/backup")
def backup(session: SessionDep):
    """The whole library as a backup zip, the same format as the browser version's."""
    day = store.now()[:10]
    return Response(
        store.backup_zip(session), media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="rerouter-backup-{day}.zip"'},
    )


@app.post("/api/restore")
async def restore(request: Request, session: SessionDep):
    """Replace the library with a backup zip (the body)."""
    return store.restore(session, await request.body())


# ---------------------------------------------------------------- BRouter


@app.get("/brouter")
def brouter(request: Request):
    """Pass a BRouter request on to the BRouter container, so the page only talks to us."""
    if not config.BROUTER_URL:
        raise HTTPException(404, "No BRouter configured on this server (BROUTER_URL)")
    url = f"{config.BROUTER_URL}/brouter?{request.url.query}"
    try:
        with urllib.request.urlopen(url, timeout=config.BROUTER_TIMEOUT_S) as resp:
            return Response(resp.read(), status_code=resp.status, media_type=resp.headers.get("Content-Type"))
    except urllib.error.HTTPError as exc:
        return Response(exc.read(), status_code=exc.code, media_type="text/plain")
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        reason = getattr(exc, "reason", exc)
        raise HTTPException(503, f"BRouter is not reachable at {config.BROUTER_URL}: {reason}")


# ---------------------------------------------------------------- the page


@app.get("/", include_in_schema=False)
def index():
    return FileResponse(config.WEB_DIR / "index.html")


# Everything else: the page's files (JS, CSS, place data). Mounted last.
app.mount("/", StaticFiles(directory=config.WEB_DIR), name="web")
