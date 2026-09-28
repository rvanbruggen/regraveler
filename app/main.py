"""The rerouter server: serves the page and stores the library.

All route logic (GPX parsing, stats, names, combining, similarity, surface) runs in the page
(web/js). The server keeps what the page computes, keeps the original GPX files in the GPX
folder, and passes BRouter requests on to the BRouter container.
"""
from __future__ import annotations

import http.client
import ipaddress
import json
import logging
import re
import socket
import time
import urllib.error
import urllib.request
from collections import OrderedDict
from contextlib import asynccontextmanager
from typing import Annotated
from urllib.parse import parse_qs, quote, urlencode, urlsplit

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from starlette.concurrency import run_in_threadpool
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
        path, media_type=store.media_type(f.name),
        headers={"X-File-Name": quote(f.name), "Access-Control-Expose-Headers": "X-File-Name"},
    )


@app.put("/api/files/{file_hash}")
async def put_file(file_hash: str, request: Request, session: SessionDep, name: str = "", folder: str = ""):
    """Store an original route file (GPX, TCX or FIT; the body). The bytes must match the hash."""
    data = await request.body()
    return {"hash": file_hash, "path": store.put_file(session, file_hash, data, name, folder)}


@app.get("/api/disk-files")
def disk_files(session: SessionDep):
    """GPX files in the GPX folder that are not in the library yet (to import from the page),
    and how many are ignored."""
    return store.disk_files(session)


class IgnoreFilesIn(BaseModel):
    files: list[dict]  # [{path, reason}]


@app.post("/api/disk-files/ignore")
def ignore_disk_files(body: IgnoreFilesIn, session: SessionDep):
    """Stop offering these files (every copy of them) for import."""
    return {"ignored": store.ignore_disk_files(session, body.files)}


@app.post("/api/disk-files/unignore")
def unignore_disk_files(session: SessionDep):
    """Offer the ignored files again."""
    return {"unignored": store.unignore_disk_files(session)}


@app.get("/api/disk-files/content")
def disk_file(path: str):
    full = store.resolve(path)
    if not full.is_file() or full.suffix.lower() not in store.TRACK_SUFFIXES:
        raise HTTPException(404, "No such route file")
    return FileResponse(full, media_type=store.media_type(full.name))


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


class DocsIn(BaseModel):
    docs: list[dict]


@app.put("/api/docs")
def put_docs(body: DocsIn, session: SessionDep):
    """Save documents (places, place lists, …): {kind, id, ...} each."""
    return {"saved": store.put_docs(session, body.docs)}


@app.post("/api/docs/delete")
def delete_docs(body: KeysIn, session: SessionDep):
    return {"deleted": store.delete_docs(session, body.keys)}


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


# ---------------------------------------------------------------- import from a link


class BlockedAddress(OSError):
    """The link leads to an address on this machine or network, which is never fetched."""


def is_public(ip: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    if ip.version == 6 and ip.ipv4_mapped:
        ip = ip.ipv4_mapped
    return ip.is_global and not ip.is_multicast


class _PublicOnly:
    """Checks the address actually connected to (after DNS), so a name can't lead inside."""

    def connect(self):
        super().connect()
        ip = ipaddress.ip_address(self.sock.getpeername()[0].split("%")[0])
        if not is_public(ip):
            self.sock.close()
            raise BlockedAddress(f"{self.host} is not on the public internet")


class _HTTPConnection(_PublicOnly, http.client.HTTPConnection):
    pass


class _HTTPSConnection(_PublicOnly, http.client.HTTPSConnection):
    pass


class _HTTPHandler(urllib.request.HTTPHandler):
    def http_open(self, req):
        return self.do_open(_HTTPConnection, req)


class _HTTPSHandler(urllib.request.HTTPSHandler):
    def https_open(self, req):
        return self.do_open(_HTTPSConnection, req, context=self._context)


class _Redirects(urllib.request.HTTPRedirectHandler):
    max_redirections = 5

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if urlsplit(newurl).scheme not in ("http", "https"):
            raise urllib.error.HTTPError(newurl, 400, "Redirect to a non-web address", headers, fp)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def _link_opener() -> urllib.request.OpenerDirector:
    """http(s) only (no file:, ftp:, data:), no proxies from the environment, public addresses only."""
    opener = urllib.request.OpenerDirector()
    for handler in (_HTTPHandler(), _HTTPSHandler(), _Redirects(),
                    urllib.request.HTTPDefaultErrorHandler(), urllib.request.HTTPErrorProcessor()):
        opener.add_handler(handler)
    return opener


_GPX_START = re.compile(rb"<(\w+:)?gpx[\s>]", re.IGNORECASE)


@app.get("/api/fetch-gpx")
def fetch_gpx(url: str):
    """Fetch a GPX file for the page (Import from a link), for sites that don't let the page
    read their files itself. Only GPX files, only from public internet addresses."""
    if urlsplit(url).scheme not in ("http", "https") or not urlsplit(url).hostname:
        raise HTTPException(400, "Only web links (http:// or https://) can be fetched")
    host = urlsplit(url).hostname
    # Refuse addresses inside this network straight away. (The connection itself is checked too,
    # for redirects and for names that resolve differently the second time.)
    try:
        addresses = {info[4][0].split("%")[0] for info in socket.getaddrinfo(host, None)}
    except (socket.gaierror, UnicodeError) as exc:
        raise HTTPException(502, f"{host} could not be found: {exc}")
    if not all(is_public(ipaddress.ip_address(a)) for a in addresses):
        raise HTTPException(403, f"rerouter only fetches files from the public internet ({host} is not on it)")
    limit = config.LINK_FETCH_MAX_BYTES
    req = urllib.request.Request(url, headers={"User-Agent": f"rerouter/{__version__}", "Accept": "application/gpx+xml, application/xml, */*"})
    try:
        with _link_opener().open(req, timeout=config.LINK_FETCH_TIMEOUT_S) as resp:
            data = resp.read(limit + 1)
    except BlockedAddress as exc:
        raise HTTPException(403, f"rerouter only fetches files from the public internet ({exc})")
    except urllib.error.HTTPError as exc:
        if exc.code in (401, 403):
            raise HTTPException(502, f"{host} wants you to sign in for this file. Download it yourself and add it on the Import screen.")
        if exc.code == 404:
            raise HTTPException(502, f"There is nothing at that link on {host} (404).")
        raise HTTPException(502, f"{host} answered {exc.code} {exc.reason}")
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        reason = getattr(exc, "reason", exc)
        if isinstance(reason, BlockedAddress):
            raise HTTPException(403, f"rerouter only fetches files from the public internet ({reason})")
        raise HTTPException(502, f"{host} could not be reached: {reason}")
    if len(data) > limit:
        raise HTTPException(413, f"That file is too large (over {limit // 1_000_000} MB)")
    if not _GPX_START.search(data[:4096]):
        raise HTTPException(422, "That link doesn't lead to a GPX file. Use the link of the file itself, e.g. the site's \"Download GPX\" link.")
    return Response(data, media_type="application/gpx+xml")


# ---------------------------------------------------------------- places from OpenStreetMap

_overpass_cache: "OrderedDict[str, tuple[float, bytes]]" = OrderedDict()
_OVERPASS_CACHE_MAX = 300


def _ask_overpass(query: str) -> bytes:
    problems = []
    body = urlencode({"data": query}).encode()
    for url in config.OVERPASS_URLS:
        req = urllib.request.Request(url, data=body, headers={
            "User-Agent": f"rerouter/{__version__} (+https://github.com/rvanbruggen/rerouter)",
            "Content-Type": "application/x-www-form-urlencoded",
        })
        try:
            with urllib.request.urlopen(req, timeout=config.OVERPASS_TIMEOUT_S) as resp:
                data = resp.read()
            json.loads(data)  # an error page is no answer
            return data
        except (urllib.error.URLError, TimeoutError, OSError, ValueError) as exc:
            problems.append(f"{urlsplit(url).hostname}: {getattr(exc, 'reason', exc)}")
    raise HTTPException(503, "OpenStreetMap's place servers are busy right now; try again in a while (" + "; ".join(problems) + ")")


@app.post("/api/overpass")
async def overpass(request: Request):
    """Pass a places query (Overpass QL, JSON output) on to the Overpass servers, in turn, with
    rerouter's name, and keep the answers for a day. Only the configured servers are asked."""
    query = parse_qs((await request.body()).decode("utf-8", "replace")).get("data", [""])[0]
    if not query.startswith("[out:json]") or len(query) > 200_000:
        raise HTTPException(400, "Not a places query")
    hit = _overpass_cache.get(query)
    if hit and time.time() - hit[0] < config.OVERPASS_CACHE_S:
        _overpass_cache.move_to_end(query)
        return Response(hit[1], media_type="application/json")
    data = await run_in_threadpool(_ask_overpass, query)
    _overpass_cache[query] = (time.time(), data)
    while len(_overpass_cache) > _OVERPASS_CACHE_MAX:
        _overpass_cache.popitem(last=False)
    return Response(data, media_type="application/json")


# ---------------------------------------------------------------- the page


# Browsers check the page's files with the server every time (a cheap "not modified" when
# nothing changed), so after an upgrade they never run an old page against a new server.
NO_CACHE = {"Cache-Control": "no-cache"}


class WebFiles(StaticFiles):
    def file_response(self, *args, **kwargs):
        response = super().file_response(*args, **kwargs)
        response.headers.update(NO_CACHE)
        return response


@app.get("/", include_in_schema=False)
def index():
    return FileResponse(config.WEB_DIR / "index.html", headers=NO_CACHE)


# Everything else: the page's files (JS, CSS, place data). Mounted last.
app.mount("/", WebFiles(directory=config.WEB_DIR), name="web")
