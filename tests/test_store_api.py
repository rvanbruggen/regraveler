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
