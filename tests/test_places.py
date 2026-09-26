import pytest

from app import config, places
from tests.helpers import gpx_xml, line_points, offset
from tests.test_api import client, upload  # noqa: F401  (fixture)

START = (51.0, 4.4)


def row(gid, name, lat, lon, fclass, fcode, population=0, alternates=""):
    # GeoNames dump columns: id, name, ascii, alternates, lat, lon, class, code, cc, cc2,
    # admin1-4, population, elevation, dem, timezone, modified
    return "\t".join([str(gid), name, name, alternates, f"{lat:.5f}", f"{lon:.5f}", fclass, fcode,
                      "BE", "", "", "", "", "", str(population), "", "0", "Europe/Brussels", "2026-01-01"])


def at(north_m, east_m):
    return offset(*START, north_m, east_m)


@pytest.fixture
def geonames(tmp_path, monkeypatch):
    """A tiny GeoNames 'country' along a 10 km route heading east from START."""
    monkeypatch.setattr(config, "DATA_DIR", tmp_path)
    monkeypatch.setattr(config, "GEONAMES_COUNTRIES", ["BE"])
    monkeypatch.setattr(config, "PLACE_NAME_LANGUAGE", "nl")
    monkeypatch.setattr(places, "_cache", None)
    folder = tmp_path / "geonames"
    folder.mkdir()
    rows = [
        row(1, "Startdorp", *at(300, 0), "P", "PPL", 5000),
        row(2, "Gehucht", *at(100, 100), "P", "PPL", 0),                 # nameless hamlet near the start
        row(3, "Middendorp", *at(200, 3000), "P", "PPL", 2000),
        row(4, "Groot Dorp", *at(-300, 5500), "P", "PPL", 20000),
        row(5, "Forêt de Test", *at(900, 7500), "V", "FRST", 0, "Testwoud,Foret de Test"),
        row(6, "Rond Punt", *at(0, 8500), "P", "PPL", 0, "Rond-Punt"),    # odd point: skipped
        row(7, "Verweg", *at(5000, 5000), "P", "PPL", 9000),              # not on the route
        row(8, "Einddorp", *at(200, 10_000), "P", "PPL", 3000),
    ]
    (folder / "BE.txt").write_text("\n".join(rows) + "\n", encoding="utf-8")
    alt = [
        "\t".join(["100", "5", "", "Testwoud", "", "", "", "", "", ""]),     # untagged Dutch name
        "\t".join(["101", "4", "nl", "Grootdorp", "1", "", "", "", "", ""]),  # preferred Dutch name
    ]
    (folder / "BE.alt.txt").write_text("\n".join(alt) + "\n", encoding="utf-8")
    yield folder
    places._cache = None


def route_geometry(length_m=10_000):
    return [[la, lo] for la, lo, _ in line_points(start=START, length_m=length_m, step_m=100, heading_deg=90)]


def test_point_to_point_name(geonames):
    g = places.generate_name(route_geometry(), is_loop=False)
    # Start town (with a population, not the hamlet), places in riding order, end town last;
    # Dutch names where GeoNames has them; the far-away town and the odd point are left out.
    assert g["name"] == "Startdorp – Middendorp – Grootdorp – Einddorp"


def test_landmarks_and_loops(geonames):
    geom = route_geometry(9000)
    back = [[la + 0.00001, lo] for la, lo in reversed(geom)]  # ride back along the same line
    g = places.generate_name(geom + back, is_loop=True)
    assert g["start"] == "Startdorp"
    assert "Testwoud" in g["places"]  # French main name, untagged Dutch alternate
    assert "Einddorp" not in g["name"]  # 1 km past the turn-around: not visited
    assert len(g["places"]) <= 3


def test_no_places_nearby(geonames):
    far = [[la + 2, lo] for la, lo in route_geometry()]
    assert places.generate_name(far, is_loop=False)["name"] is None


def test_missing_data_is_reported(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "DATA_DIR", tmp_path)
    monkeypatch.setattr(places, "_cache", None)

    def no_network(*a, **kw):
        raise OSError("no network")

    monkeypatch.setattr(places, "download", no_network)
    with pytest.raises(places.PlacesUnavailable):
        places.load(["BE"])


def test_notes_with_original():
    assert places.notes_with_original(None, "Gravelroute X") == "Original name: Gravelroute X"
    assert places.notes_with_original("nice", "Gravelroute X") == "Original name: Gravelroute X\n\nnice"
    # Renaming again keeps the very first name.
    once = places.notes_with_original("nice", "Gravelroute X")
    assert places.notes_with_original(once, "Startdorp – Y") == once


def test_disambiguate():
    taken = {"a – b"}
    assert places.disambiguate("A – C", 50, taken) == "A – C"
    assert places.disambiguate("A – B", 66.4, taken) == "A – B (66 km)"
    assert places.disambiguate("A – B", 66.4, taken | {"a – b (66 km)"}) == "A – B (66 km, 2)"


# ---------------------------------------------------------------- API and import


def test_rename_proposals_and_apply(client, geonames):
    data = gpx_xml([("t", line_points(start=START, length_m=10_000, step_m=100, heading_deg=90, ele=lambda d: 10.0))])
    upload(client, [("Gravelroute Test.gpx", data)])
    rid = client.get("/api/routes").json()[0]["id"]
    client.patch(f"/api/routes/{rid}", json={"notes": "ride in spring"})

    [p] = client.get("/api/rename/proposals").json()
    assert p["name"] == "Gravelroute Test"
    assert p["proposal"] == "Startdorp – Middendorp – Grootdorp – Einddorp"

    res = client.post("/api/rename/apply", json={"items": [{"id": rid, "name": "Startdorp – Grootdorp"}]}).json()
    assert res == {"renamed": 1}
    r = client.get(f"/api/routes/{rid}").json()
    assert r["name"] == "Startdorp – Grootdorp"
    assert r["slug"] == "startdorp-grootdorp"
    assert r["notes"] == "Original name: Gravelroute Test\n\nride in spring"


def test_import_names_new_routes(client, geonames, monkeypatch):
    monkeypatch.setattr(config, "AUTO_RENAME_ON_IMPORT", True)
    pts = line_points(start=START, length_m=10_000, step_m=100, heading_deg=90, ele=lambda d: 10.0)
    upload(client, [("Gravelroute One.gpx", gpx_xml([("t", pts)])),
                    ("Gravelroute Two.gpx", gpx_xml([("t", [(la + 0.0002, lo, e) for la, lo, e in pts])]))])
    routes = {r["name"]: r for r in client.get("/api/routes").json()}
    assert set(routes) == {"Startdorp – Middendorp – Grootdorp – Einddorp",
                           "Startdorp – Middendorp – Grootdorp – Einddorp (10 km)"}
    assert {r["notes"] for r in routes.values()} == {"Original name: Gravelroute One", "Original name: Gravelroute Two"}
