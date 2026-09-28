import hashlib
import io
import zipfile

import pytest

from app import config, store
from tests.helpers import gpx_xml, line_points


def gpx(n=0):
    return gpx_xml([(f"track {n}", line_points(start=(51.0 + n * 0.01, 4.4), length_m=1000))])


def h(data):
    return hashlib.sha256(data).hexdigest()


def put_file(client, data, name="Route.gpx", folder="uploads/gravel-db"):
    res = client.put(f"/api/files/{h(data)}", params={"name": name, "folder": folder}, content=data)
    assert res.status_code == 200, res.text
    return res.json()["path"]


def route(data, name="Route", **extra):
    return {"name": name, "file_hash": h(data), "track_hash": "t" + h(data)[:10], "track_index": 0,
            "distance_km": 1.0, "geometry": [[51.0, 4.4], [51.0, 4.41]], "tags": [], **extra}


def test_info_tells_the_page_it_is_on_a_server(client):
    info = client.get("/api/info").json()
    assert info["app"] == "rerouter" and info["mode"] == "server"
    assert client.get("/api/library").json() == {"routes": [], "ignored": [], "settings": {}}


def test_the_page_is_served(client):
    assert "rerouter" in client.get("/").text
    assert client.get("/js/service.js").status_code == 200
    assert client.get("/data/places/index.json").status_code == 200
    # Always checked with the server, so an upgrade never runs an old page.
    assert client.get("/js/app.js").headers["cache-control"] == "no-cache"
    assert client.get("/").headers["cache-control"] == "no-cache"


def test_files_are_stored_by_hash_in_their_folder(client, library):
    data = gpx(1)
    path = put_file(client, data, "Mijn Route.gpx", "uploads/Gravel DB")
    assert path == "uploads/gravel-db/Mijn Route.gpx"
    assert (library / path).read_bytes() == data
    res = client.get(f"/api/files/{h(data)}")
    assert res.content == data
    assert res.headers["X-File-Name"] == "Mijn%20Route.gpx"
    # Same file again: nothing new on disk. Another file with the same name: " (2)".
    assert put_file(client, data) == path
    assert put_file(client, gpx(2), "Mijn Route.gpx", "uploads/Gravel DB") == "uploads/gravel-db/Mijn Route (2).gpx"
    assert put_file(client, gpx(3), "combined.gpx", "derived") == "derived/combined.gpx"


def test_file_must_match_its_hash(client):
    data = gpx(1)
    res = client.put(f"/api/files/{h(b'other')}", params={"name": "x.gpx"}, content=data)
    assert res.status_code == 400
    assert client.put("/api/files/not-a-hash", content=data).status_code == 400
    assert client.get(f"/api/files/{h(data)}").status_code == 404


def test_files_already_in_the_gpx_folder_are_referenced_in_place(client, library):
    data = gpx(1)
    (library / "gravelroutedatabase.be").mkdir()
    (library / "gravelroutedatabase.be" / "Bosland.gpx").write_bytes(data)
    listed = client.get("/api/disk-files").json()["files"]
    assert listed == [{"path": "gravelroutedatabase.be/Bosland.gpx", "size": len(data)}]
    assert client.get("/api/disk-files/content", params={"path": listed[0]["path"]}).content == data
    assert client.get("/api/disk-files/content", params={"path": "../../etc/passwd"}).status_code in (400, 404)
    assert put_file(client, data, "Bosland.gpx") == "gravelroutedatabase.be/Bosland.gpx"
    assert not (library / "uploads").exists()
    client.put("/api/routes", json={"routes": [route(data)]})
    assert client.get("/api/disk-files").json()["files"] == []  # now in the library


def test_routes_need_their_file_and_get_ids(client):
    data = gpx(1)
    res = client.put("/api/routes", json={"routes": [route(data)]})
    assert res.status_code == 422
    put_file(client, data)
    out = client.put("/api/routes", json={"routes": [route(data, "A"), route(data, "B", track_index=1)]}).json()["routes"]
    assert [r["id"] for r in out] == [1, 2]
    lib = client.get("/api/library").json()
    assert [(r["id"], r["name"]) for r in lib["routes"]] == [(1, "A"), (2, "B")]
    assert lib["routes"][0]["updated_at"] == out[0]["updated_at"]


def test_a_route_changed_elsewhere_is_not_overwritten(client):
    data = gpx(1)
    put_file(client, data)
    [r] = client.put("/api/routes", json={"routes": [route(data, "A")]}).json()["routes"]
    loaded = r["updated_at"]
    # Page 1 saves (based on what it loaded): fine.
    first = client.put("/api/routes", json={"routes": [route(data, "A1", id=1)], "base": {"1": loaded}})
    assert first.status_code == 200
    # Page 2 still has the old version: refused.
    second = client.put("/api/routes", json={"routes": [route(data, "A2", id=1)], "base": {"1": loaded}})
    assert second.status_code == 409
    assert "Reload" in second.json()["detail"]
    assert client.get("/api/library").json()["routes"][0]["name"] == "A1"


def test_delete_routes_keeps_files_and_drops_their_pairs(client, library):
    data = gpx(1)
    path = put_file(client, data)
    client.put("/api/routes", json={"routes": [route(data, "A"), route(data, "B"), route(data, "C")]})
    client.put("/api/ignored", json={"keys": ["2_1", "2_3"]})
    assert client.get("/api/library").json()["ignored"] == ["1_2", "2_3"]
    assert client.post("/api/routes/delete", json={"ids": [1]}).json() == {"deleted": 1}
    lib = client.get("/api/library").json()
    assert [r["id"] for r in lib["routes"]] == [2, 3]
    assert lib["ignored"] == ["2_3"]
    assert (library / path).exists()
    client.post("/api/ignored/delete", json={"keys": ["2_3"]})
    assert client.get("/api/library").json()["ignored"] == []
    assert client.put("/api/ignored", json={"keys": ["x"]}).status_code == 422


def test_settings_and_clear(client, library):
    data = gpx(1)
    path = put_file(client, data)
    client.put("/api/routes", json={"routes": [route(data)]})
    client.put("/api/settings", json={"settings": {"BROUTER_URL": "http://x", "AUTO_RENAME_ON_IMPORT": False}})
    client.put("/api/settings", json={"settings": {"BROUTER_URL": "http://y"}})
    assert client.get("/api/library").json()["settings"] == {"BROUTER_URL": "http://y", "AUTO_RENAME_ON_IMPORT": False}
    client.post("/api/library/clear")
    assert client.get("/api/library").json() == {"routes": [], "ignored": [], "settings": {}}
    assert (library / path).exists()


def test_backup_and_restore(client, library):
    a, b = gpx(1), gpx(2)
    put_file(client, a, "A.gpx")
    put_file(client, b, "B.gpx")
    client.put("/api/routes", json={"routes": [route(a, "A", tags=["forest"]), route(b, "B")]})
    client.post("/api/routes/delete", json={"ids": [1]})
    client.put("/api/ignored", json={"keys": ["2_7"]})
    client.put("/api/settings", json={"settings": {"k": 1}})
    res = client.get("/api/backup")
    assert res.headers["content-type"] == "application/zip"
    zf = zipfile.ZipFile(io.BytesIO(res.content))
    assert sorted(zf.namelist()) == ["gpx/" + h(b) + ".gpx", "library.json"]  # only files in use

    client.post("/api/library/clear")
    (library / "uploads/gravel-db/B.gpx").unlink()  # gone from disk: restored to restored/
    out = client.post("/api/restore", content=res.content).json()
    assert out == {"routes": 1, "files": 1}
    lib = client.get("/api/library").json()
    assert [(r["id"], r["name"]) for r in lib["routes"]] == [(2, "B")]
    assert lib["ignored"] == ["2_7"] and lib["settings"] == {"k": 1}
    assert client.get(f"/api/files/{h(b)}").content == b
    assert (library / "restored/B.gpx").exists()
    assert client.post("/api/restore", content=b"not a zip").status_code == 400


def test_file_moved_inside_the_gpx_folder_is_found_again(client, library):
    data = gpx(1)
    path = put_file(client, data)
    (library / "elsewhere").mkdir()
    (library / path).rename(library / "elsewhere" / "moved.gpx")
    assert client.get(f"/api/files/{h(data)}").content == data


def test_brouter_requests_are_passed_on(client, monkeypatch):
    seen = {}

    class Resp:
        status = 200
        headers = {"Content-Type": "application/vnd.geo+json"}

        def read(self):
            return b'{"type": "FeatureCollection"}'

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    def fake_urlopen(url, timeout):
        seen["url"] = url
        return Resp()

    monkeypatch.setattr(config, "BROUTER_URL", "http://brouter:17777")
    monkeypatch.setattr("urllib.request.urlopen", fake_urlopen)
    res = client.get("/brouter?lonlats=4.4,51.2|4.5,51.3&profile=gravel&format=geojson")
    assert res.status_code == 200
    assert res.json() == {"type": "FeatureCollection"}
    assert seen["url"].startswith("http://brouter:17777/brouter?lonlats=4.4,51.2")


def test_brouter_unreachable(client, monkeypatch):
    monkeypatch.setattr(config, "BROUTER_URL", "http://127.0.0.1:9")
    assert client.get("/brouter?lonlats=4.4,51.2|4.5,51.3&profile=gravel").status_code == 503


def test_store_rejects_paths_outside_the_gpx_folder(library):
    with pytest.raises(store.StoreError):
        store.resolve("../outside.gpx")


def test_ignored_files_are_not_offered_again(client, library):
    dup, bad, other = gpx(1), b"<gpx>not really</gpx>", gpx(2)
    for folder in ("sportvlaanderen", "uploads/sport-vlaanderen"):
        (library / folder).mkdir(parents=True)
        (library / folder / "verbinding.gpx").write_bytes(dup)  # the same file twice
    (library / "uploads/sport-vlaanderen/kapot.gpx").write_bytes(bad)
    (library / "keep.gpx").write_bytes(other)
    listed = client.get("/api/disk-files").json()
    assert [f["path"] for f in listed["files"]] == ["keep.gpx", "sportvlaanderen/verbinding.gpx", "uploads/sport-vlaanderen/kapot.gpx"]
    assert listed["ignored"] == 0

    res = client.post("/api/disk-files/ignore", json={"files": [
        {"path": "sportvlaanderen/verbinding.gpx", "reason": "duplicate: Same track already imported"},
        {"path": "uploads/sport-vlaanderen/kapot.gpx", "reason": "error: no track"},
    ]})
    assert res.json() == {"ignored": 2}
    # Every copy is ignored (by content), not only the one that was listed.
    listed = client.get("/api/disk-files").json()
    assert [f["path"] for f in listed["files"]] == ["keep.gpx"]
    assert listed["ignored"] == 2
    # The files stay on disk.
    assert (library / "uploads/sport-vlaanderen/verbinding.gpx").exists()
    assert client.post("/api/disk-files/ignore", json={"files": [{"path": "nope.gpx"}]}).status_code == 404

    assert client.post("/api/disk-files/unignore").json() == {"unignored": 2}
    assert len(client.get("/api/disk-files").json()["files"]) == 3


def test_tcx_and_fit_originals_keep_their_format(client, library):
    fit = b"\x0e\x10\x00\x00\x00\x00\x00\x00.FIT\x00\x00" + bytes(range(40))  # the server never reads it
    tcx = b'<?xml version="1.0"?><TrainingCenterDatabase></TrainingCenterDatabase>'
    assert put_file(client, fit, "Morning ride.fit") == "uploads/gravel-db/Morning ride.fit"
    assert put_file(client, tcx, "Run.tcx") == "uploads/gravel-db/Run.tcx"
    res = client.get(f"/api/files/{h(fit)}")
    assert res.content == fit and res.headers["content-type"] == "application/vnd.ant.fit"
    assert client.get(f"/api/files/{h(tcx)}").headers["content-type"].startswith("application/vnd.garmin.tcx+xml")
    # A file of another type still gets .gpx (never an executable or a page).
    assert put_file(client, gpx(5), "evil.html") == "uploads/gravel-db/evil.html.gpx"

    # Backups keep the extension, and restore reads them back.
    client.put("/api/routes", json={"routes": [route(fit, "Ride", file_format="fit"), route(tcx, "Run", file_format="tcx")]})
    backup = client.get("/api/backup").content
    names = zipfile.ZipFile(io.BytesIO(backup)).namelist()
    assert f"gpx/{h(fit)}.fit" in names and f"gpx/{h(tcx)}.tcx" in names
    res = client.post("/api/restore", content=backup, headers={"Content-Type": "application/zip"})
    assert res.status_code == 200, res.text
    assert client.get(f"/api/files/{h(fit)}").content == fit

    # Files in the GPX folder: FIT and TCX files are offered for import too.
    (library / "rides").mkdir()
    (library / "rides" / "Evening.fit").write_bytes(fit + b"x")
    paths = [f["path"] for f in client.get("/api/disk-files").json()["files"]]
    assert "rides/Evening.fit" in paths
    assert client.get("/api/disk-files/content", params={"path": "rides/Evening.fit"}).content == fit + b"x"
