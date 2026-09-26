import json

import pytest
from fastapi.testclient import TestClient

from app.main import app
from tests.helpers import gpx_xml, line_points, loop_points


@pytest.fixture
def client(library):
    with TestClient(app) as c:
        yield c


def upload(client, files, **form):
    return client.post(
        "/api/import",
        files=[("files", (name, data, "application/gpx+xml")) for name, data in files],
        data=form,
    )


def climb_gpx(length_m, gain_m, start=(51.0, 4.4)):
    return gpx_xml([("t", line_points(start=start, length_m=length_m, ele=lambda d: d * gain_m / length_m))])


def test_upload_list_edit_download_delete(client):
    short = climb_gpx(10_000, 50)
    long = climb_gpx(60_000, 400, start=(50.8, 4.6))
    res = upload(client, [("Short.gpx", short), ("Long.gpx", long)],
                 source_name="Batch", source_url="https://batch.test",
                 overrides=json.dumps([{}, {"source_name": "Other"}]))
    assert res.status_code == 200
    results = res.json()["results"]
    assert [r["status"] for r in results] == ["imported", "imported"]

    routes = client.get("/api/routes").json()
    assert [r["name"] for r in routes] == ["Long", "Short"]
    assert {r["name"]: r["source_name"] for r in routes} == {"Short": "Batch", "Long": "Other"}
    assert all(r["source_url"] == "https://batch.test" for r in routes)
    assert "geometry" not in routes[0]

    short_id = next(r["id"] for r in routes if r["name"] == "Short")
    detail = client.get(f"/api/routes/{short_id}").json()
    assert detail["distance_km"] == pytest.approx(10, rel=0.01)
    assert detail["elevation_gain_m"] == pytest.approx(50, abs=2)
    assert len(detail["geometry"]) >= 2

    res = client.patch(f"/api/routes/{short_id}", json={
        "quality_rating": 4, "paved_pct": 30, "tags": [" Forest", "forest", "Sandy  Paths", ""], "notes": "nice",
    })
    assert res.status_code == 200
    assert res.json()["tags"] == ["forest", "sandy paths"]
    assert res.json()["name"] == "Short"  # untouched fields stay

    assert client.patch(f"/api/routes/{short_id}", json={"quality_rating": 6}).status_code == 422

    gpx = client.get(f"/api/routes/{short_id}/gpx")
    assert gpx.status_code == 200
    assert gpx.content == short
    assert 'filename="Short.gpx"' in gpx.headers["content-disposition"]

    assert client.delete(f"/api/routes/{short_id}").status_code == 204
    assert client.get(f"/api/routes/{short_id}").status_code == 404
    assert [r["name"] for r in client.get("/api/routes").json()] == ["Long"]


def test_filters_and_sorting(client):
    upload(client, [
        ("Flat 20.gpx", climb_gpx(20_000, 20)),
        ("Hilly 50.gpx", climb_gpx(50_000, 600, start=(50.5, 5.5))),
        ("Mid 40.gpx", climb_gpx(40_000, 200, start=(50.9, 3.9))),
    ], source_name="S1")
    ids = {r["name"]: r["id"] for r in client.get("/api/routes").json()}
    client.patch(f"/api/routes/{ids['Hilly 50']}", json={"tags": ["hills", "forest"], "quality_rating": 5, "paved_pct": 20})
    client.patch(f"/api/routes/{ids['Mid 40']}", json={"tags": ["forest"], "quality_rating": 3, "paved_pct": 60, "source_name": "S2"})

    def names(**params):
        return [r["name"] for r in client.get("/api/routes", params=params).json()]

    assert names(min_distance=30) == ["Hilly 50", "Mid 40"]
    assert names(max_distance=45, min_distance=25) == ["Mid 40"]
    assert names(min_gain=100, max_gain=300) == ["Mid 40"]
    assert names(min_quality=4) == ["Hilly 50"]
    assert names(max_paved=50) == ["Hilly 50"]
    assert names(tags="forest") == ["Hilly 50", "Mid 40"]
    assert names(tags=["forest", "hills"]) == ["Hilly 50"]
    assert names(source="S2") == ["Mid 40"]
    assert names(q="flat") == ["Flat 20"]
    assert names(loop="false") == ["Flat 20", "Hilly 50", "Mid 40"]
    assert names(sort="distance_km", order="desc") == ["Hilly 50", "Mid 40", "Flat 20"]
    # Routes without a rating sort last in both directions.
    assert names(sort="quality_rating", order="asc") == ["Mid 40", "Hilly 50", "Flat 20"]
    assert names(sort="bogus") == ["Flat 20", "Hilly 50", "Mid 40"]

    facets = client.get("/api/facets").json()
    assert facets["sources"] == ["S1", "S2"]
    assert facets["tags"] == [["forest", 2], ["hills", 1]]


def test_duplicate_and_similar_reported_on_upload(client):
    loop = gpx_xml([("L", loop_points())])
    loop2 = gpx_xml([("L2", loop_points(n=300))])  # same circle, different points
    assert upload(client, [("a.gpx", loop)]).json()["results"][0]["status"] == "imported"
    results = upload(client, [("a-again.gpx", loop), ("b.gpx", loop2)]).json()["results"]
    assert results[0]["status"] == "duplicate"
    assert results[1]["status"] == "imported"
    assert results[1]["similar"][0]["other_name"] == "a"

    b_id = results[1]["routes"][0]["id"]
    sims = client.get(f"/api/routes/{b_id}/similar").json()
    assert sims[0]["name"] == "a" and sims[0]["very_similar"]


def test_bad_upload_is_reported_per_file(client):
    results = upload(client, [("bad.gpx", b"garbage"), ("ok.gpx", climb_gpx(1000, 5))]).json()["results"]
    assert [r["status"] for r in results] == ["error", "imported"]


def test_frontend_is_served(client):
    page = client.get("/").text
    assert "<title>rerouter" in page
    assert 'href="/static/favicon.svg"' in page
    for asset in ("app.js", "logo.svg", "favicon.svg"):
        assert client.get(f"/static/{asset}").status_code == 200


def test_version_endpoint(client):
    from app import __version__

    assert client.get("/api/version").json() == {"version": __version__}


def test_map_and_proximity_use_the_shared_filters(client):
    from tests.helpers import offset

    def east(north_m, length_m):
        start = offset(51.0, 4.4, north_m, 0)
        return gpx_xml([("t", line_points(start=start, length_m=length_m, step_m=50, heading_deg=90,
                                          ele=lambda d: 10.0))])

    upload(client, [("A.gpx", east(0, 10_000)), ("B.gpx", east(60, 10_000)), ("Short.gpx", east(120, 3_000))])

    routes = client.get("/api/map").json()
    assert {r["name"] for r in routes} == {"A", "B", "Short"}
    assert all(len(r["geometry"]) >= 2 for r in routes)
    assert [r["name"] for r in client.get("/api/map", params={"min_distance": 5}).json()] == ["A", "B"]

    res = client.get("/api/proximity", params={"distance_m": 100}).json()
    assert res["distance_m"] == 100
    names = {r["id"]: r["name"] for r in routes}
    assert sorted(tuple(sorted((names[p["a_id"]], names[p["b_id"]]))) for p in res["pairs"]) == [
        ("A", "B"), ("B", "Short"),  # Short is 120 m from A: outside 100 m
    ]
    # Filtered: Short is excluded, so only A-B remains.
    res = client.get("/api/proximity", params={"distance_m": 100, "min_distance": 5}).json()
    assert len(res["pairs"]) == 1
    # Default distance comes from the configuration.
    assert client.get("/api/proximity").json()["distance_m"] == 100
    assert client.get("/api/proximity", params={"distance_m": 999_999}).status_code == 422
    assert client.get("/api/proximity", params={"distance_m": -1}).status_code == 422


def test_large_responses_are_gzipped(client):
    upload(client, [(f"L{i}.gpx", gpx_xml([("L", loop_points(center=(51.0 + i / 10, 4.4), radius_m=8000, n=800))]))
                    for i in range(3)])
    res = client.get("/api/map", params={"tolerance_m": 0}, headers={"Accept-Encoding": "gzip"})
    assert res.headers.get("content-encoding") == "gzip"


# ---------------------------------------------------------------- combiner

def _two_parallel_routes(client):
    from tests.helpers import offset

    def east(north_m, name):
        start = offset(51.0, 4.4, north_m, 0)
        return (f"{name}.gpx", gpx_xml([(name, line_points(start=start, length_m=6000, step_m=50, heading_deg=90,
                                                           ele=lambda d: 10 + d / 600))]))

    upload(client, [east(0, "Route A"), east(800, "Route B")])
    ids = {r["name"]: r["id"] for r in client.get("/api/routes").json()}
    client.patch(f"/api/routes/{ids['Route A']}", json={"tags": ["forest"]})
    client.patch(f"/api/routes/{ids['Route B']}", json={"tags": ["sand"]})
    return ids["Route A"], ids["Route B"]


def test_combine_suggest_preview_save(client, library, monkeypatch):
    from app import brouter

    a, b = _two_parallel_routes(client)
    calls = []

    def fake_route(p, q, profile, params=None, **kw):
        calls.append((profile, params))
        return [(p[0], p[1], 10.0), (q[0], q[1], 12.0)]

    monkeypatch.setattr(brouter, "route", fake_route)

    sug = client.get("/api/combine/suggest", params={"a_id": a, "b_id": b, "count": 2}).json()["connections"]
    assert len(sug) == 2
    assert all(c["distance_m"] == pytest.approx(800, abs=15) for c in sug)

    req = {"a_id": a, "b_id": b, "connections": sug, "prefer_unpaved": True}
    prev = client.post("/api/combine/preview", json=req).json()
    assert prev["is_loop"]
    assert len(prev["connectors"]) == 2 and all(c["routed"] for c in prev["connectors"])
    assert calls == [("gravel", {"prefer_unpaved_paths": "1"})] * 2
    assert [leg["kind"] for leg in prev["legs"]] == ["a", "connector", "b", "connector"]
    assert prev["distance_km"] > 1.6  # at least the two connectors

    gpx = client.post("/api/combine/gpx", json={**req, "name": "A plus B"})
    assert gpx.status_code == 200
    assert b"<trkpt" in gpx.content and 'filename="A plus B.gpx"' in gpx.headers["content-disposition"]

    saved = client.post("/api/combine/save", json={**req, "name": "A plus B", "notes": "try in spring"})
    assert saved.status_code == 200, saved.text
    new = client.get(f"/api/routes/{saved.json()['id']}").json()
    assert new["name"] == "A plus B"
    assert new["derived_from"] == [a, b]
    assert new["source_name"] == "combined"
    assert new["tags"] == ["forest", "sand"]
    assert "Combined from 'Route A' and 'Route B'" in new["notes"] and "try in spring" in new["notes"]
    assert new["gpx_path"] == "derived/a-plus-b.gpx"
    assert (library / new["gpx_path"]).is_file()
    assert new["distance_km"] == pytest.approx(prev["distance_km"], rel=0.01)

    # Saving the identical combination again is refused.
    again = client.post("/api/combine/save", json={**req, "name": "A plus B"})
    assert again.status_code == 409


def test_combine_errors(client, monkeypatch):
    from app import brouter

    a, b = _two_parallel_routes(client)
    one = [{"a": [51.0, 4.43], "b": [51.0072, 4.43]}]

    assert client.get("/api/combine/suggest", params={"a_id": a, "b_id": a}).status_code == 422
    assert client.post("/api/combine/preview", json={"a_id": a, "b_id": b, "connections": []}).status_code == 422
    assert client.post("/api/combine/preview", json={"a_id": a, "b_id": b, "connections": one, "profile": "car"}).status_code == 422
    assert client.post("/api/combine/preview", json={"a_id": a, "b_id": 999, "connections": one}).status_code == 404

    def unavailable(*args, **kw):
        raise brouter.BRouterUnavailable("BRouter is not reachable at http://brouter:17777")

    monkeypatch.setattr(brouter, "route", unavailable)
    res = client.post("/api/combine/preview", json={"a_id": a, "b_id": b, "connections": one})
    assert res.status_code == 503 and "not reachable" in res.json()["detail"]

    # Straight lines work without BRouter.
    res = client.post("/api/combine/preview", json={"a_id": a, "b_id": b, "connections": one, "straight": True})
    assert res.status_code == 200
    assert res.json()["connectors"][0]["distance_km"] == pytest.approx(0.8, abs=0.02)

    def failing(*args, **kw):
        raise brouter.BRouterError("BRouter has no routing data for this area (missing tile E5_N50.rd5).")

    monkeypatch.setattr(brouter, "route", failing)
    res = client.post("/api/combine/preview", json={"a_id": a, "b_id": b, "connections": one})
    assert res.status_code == 502 and "E5_N50" in res.json()["detail"]


def test_combine_parts(client, library, monkeypatch):
    from app import brouter

    a, b = _two_parallel_routes(client)
    monkeypatch.setattr(brouter, "route", lambda p, q, *args, **kw: [(p[0], p[1], 10.0), (q[0], q[1], 12.0)])

    sug = client.get("/api/combine/suggest", params={"a_id": a, "b_id": b, "count": 2}).json()["parts"]
    assert [p["route_id"] for p in sug] == [a, b]

    parts = [{"route_id": p["route_id"], "start": p["start"], "end": p["end"]} for p in sug]
    prev = client.post("/api/combine/preview", json={"parts": parts}).json()
    assert prev["is_loop"] and not prev["crossing"]
    assert [leg["kind"] for leg in prev["legs"]] == ["a", "connector", "b", "connector"]
    assert prev["start"] == pytest.approx(sug[0]["start"], abs=1e-4)  # starts at A1
    assert [p["route_id"] for p in prev["parts"]] == [a, b]
    assert prev["parts"][0]["distance_km"] == pytest.approx(abs(sug[0]["end_km"] - sug[0]["start_km"]), abs=0.01)

    # B the same way as A: the connectors cross.
    same_way = [parts[0], {**parts[1], "start": parts[1]["end"], "end": parts[1]["start"]}]
    assert client.post("/api/combine/preview", json={"parts": same_way}).json()["crossing"]

    # Point to point.
    prev = client.post("/api/combine/preview", json={"parts": parts, "closed": False}).json()
    assert not prev["is_loop"] and len(prev["connectors"]) == 1

    saved = client.post("/api/combine/save", json={"parts": parts, "name": "A loop B"})
    assert saved.status_code == 200, saved.text
    new = client.get(f"/api/routes/{saved.json()['id']}").json()
    assert new["derived_from"] == [a, b]
    assert new["tags"] == ["forest", "sand"]

    # Errors: one route only, same points, too few parts.
    assert client.post("/api/combine/preview", json={"parts": [parts[0], {**parts[0]}]}).status_code == 422
    same = [parts[0], {**parts[1], "end": parts[1]["start"]}]
    res = client.post("/api/combine/preview", json={"parts": same})
    assert res.status_code == 422 and "route B" in res.json()["detail"]
    assert client.post("/api/combine/preview", json={"parts": parts[:1]}).status_code == 422
    assert client.post("/api/combine/preview", json={}).status_code == 422


def test_client_config(client):
    cfg = client.get("/api/config").json()
    assert cfg["brouter_profiles"][0] == "gravel"


# ---------------------------------------------------------------- multi-select

def test_ids_filter_zip_export_and_bulk_delete(client, library):
    import io
    import zipfile

    multi = gpx_xml([("Track one", line_points(length_m=1000)),
                     ("Track two", line_points(start=(51.3, 4.4), length_m=2000))])
    upload(client, [
        ("One.gpx", climb_gpx(5000, 20)),
        ("Two.gpx", climb_gpx(8000, 40, start=(50.7, 4.9))),
        ("Start Multi.gpx", multi),
    ])
    ids = {r["name"]: r["id"] for r in client.get("/api/routes").json()}
    assert set(ids) == {"One", "Two", "Track one", "Track two"}

    # Shared "only these routes" filter, on the list and the map.
    sel = [ids["One"], ids["Track one"]]
    assert sorted(r["name"] for r in client.get("/api/routes", params={"ids": sel}).json()) == ["One", "Track one"]
    assert sorted(r["name"] for r in client.get("/api/map", params={"ids": sel}).json()) == ["One", "Track one"]

    # Zip of the original files; both tracks of the multi-track file share one entry.
    res = client.get("/api/export/gpx.zip", params={"ids": [ids["One"], ids["Track one"], ids["Track two"]]})
    assert res.status_code == 200
    assert res.headers["content-type"] == "application/zip"
    zf = zipfile.ZipFile(io.BytesIO(res.content))
    assert sorted(zf.namelist()) == ["One.gpx", "Start Multi.gpx"]
    assert zf.read("Start Multi.gpx") == multi
    assert client.get("/api/export/gpx.zip", params={"ids": [9999]}).status_code == 404
    assert client.get("/api/export/gpx.zip").status_code == 422

    # Bulk remove: routes go, files stay.
    res = client.post("/api/routes/delete", json={"ids": [ids["One"], ids["Two"], 9999]})
    assert res.json() == {"deleted": 2}
    assert sorted(r["name"] for r in client.get("/api/routes").json()) == ["Track one", "Track two"]
    assert (library / "uploads/unsorted/One.gpx").is_file()
    assert client.post("/api/routes/delete", json={"ids": []}).status_code == 422
    # The single-route endpoints still work next to /api/routes/delete.
    assert client.get(f"/api/routes/{ids['Track one']}").status_code == 200


def test_zip_export_deduplicates_file_names(client):
    import io
    import zipfile

    upload(client, [("Same.gpx", climb_gpx(3000, 10))], source_name="S1")
    upload(client, [("Same.gpx", climb_gpx(4000, 10, start=(50.6, 5.0)))], source_name="S2")
    ids = [r["id"] for r in client.get("/api/routes").json()]
    zf = zipfile.ZipFile(io.BytesIO(client.get("/api/export/gpx.zip", params={"ids": ids}).content))
    assert sorted(zf.namelist()) == ["Same (2).gpx", "Same.gpx"]


# ---------------------------------------------------------------- phase 4: surface

def fake_way_tags(waypoints, profile, params=None, **kw):
    assert profile == "shortest" and params == {"processUnusedTags": "1"}
    n = len(waypoints) - 1
    rows = [(n * 600.0, {"highway": "residential", "surface": "asphalt"}),
            (n * 400.0, {"highway": "track", "surface": "gravel"})]
    return n * 1000.0, rows, list(waypoints)


def test_surface_estimate_and_manual_override(client, monkeypatch):
    from app import brouter

    monkeypatch.setattr(brouter, "way_tags", fake_way_tags)
    upload(client, [("R.gpx", climb_gpx(5000, 10))])
    rid = client.get("/api/routes").json()[0]["id"]

    r = client.post(f"/api/routes/{rid}/surface").json()
    assert r["paved_pct"] == 60 and r["paved_source"] == "estimated"
    assert r["surface"]["unpaved_km"] > 0 and r["surface"]["segments"]

    # A value typed by the user wins, and survives a new estimate...
    r = client.patch(f"/api/routes/{rid}", json={"paved_pct": 25}).json()
    assert (r["paved_pct"], r["paved_source"]) == (25, "manual")
    r = client.post(f"/api/routes/{rid}/surface").json()
    assert (r["paved_pct"], r["paved_source"]) == (25, "manual")
    # ...unless explicitly overwritten.
    r = client.post(f"/api/routes/{rid}/surface", params={"overwrite_manual": True}).json()
    assert (r["paved_pct"], r["paved_source"]) == (60, "estimated")
    # Clearing the field falls back to the estimate.
    client.patch(f"/api/routes/{rid}", json={"paved_pct": 25})
    r = client.patch(f"/api/routes/{rid}", json={"paved_pct": None}).json()
    assert (r["paved_pct"], r["paved_source"]) == (60, "estimated")
    # The list shows where the value comes from; the (large) estimate stays in the detail.
    listed = client.get("/api/routes").json()[0]
    assert listed["paved_source"] == "estimated" and "surface" not in listed


def test_surface_estimate_errors(client, monkeypatch):
    from app import brouter

    upload(client, [("R.gpx", climb_gpx(5000, 10))])
    rid = client.get("/api/routes").json()[0]["id"]

    def down(*a, **kw):
        raise brouter.BRouterUnavailable("BRouter is not reachable at http://brouter:17777")

    monkeypatch.setattr(brouter, "way_tags", down)
    assert client.post(f"/api/routes/{rid}/surface").status_code == 503


def test_surface_bulk_estimate_in_background(client, monkeypatch):
    from app import brouter, surface

    monkeypatch.setattr(brouter, "way_tags", fake_way_tags)
    upload(client, [("A.gpx", climb_gpx(3000, 5)), ("B.gpx", climb_gpx(4000, 5, start=(50.5, 5.0)))])
    ids = [r["id"] for r in client.get("/api/routes").json()]
    client.patch(f"/api/routes/{ids[0]}", json={"paved_pct": 10})

    res = client.post("/api/surface/estimate", json={"ids": ids}).json()
    assert res["queued"] == 2
    assert surface.worker.wait(10)
    status = client.get("/api/surface/status").json()
    assert status["running"] is False and status["done"] == 2 and status["failed"] == 0
    routes = {r["id"]: r for r in client.get("/api/routes").json()}
    assert routes[ids[0]]["paved_pct"] == 10  # manual value kept
    assert routes[ids[1]]["paved_pct"] == 60


def test_auto_estimate_after_upload(client, monkeypatch):
    from app import brouter, config, surface

    monkeypatch.setattr(brouter, "way_tags", fake_way_tags)
    monkeypatch.setattr(config, "SURFACE_AUTO_ESTIMATE", True)
    upload(client, [("A.gpx", climb_gpx(3000, 5))])
    assert surface.worker.wait(10)
    assert client.get("/api/routes").json()[0]["paved_pct"] == 60


# ---------------------------------------------------------------- phase 4: duplicates

def test_same_track_in_a_different_file_is_a_duplicate(client):
    original = climb_gpx(5000, 20)
    # Same points, but a BOM, Windows line endings and another creator: different bytes.
    variant = b"\xef\xbb\xbf" + original.replace(b'creator="tests"', b'creator="other"').replace(b"\n", b"\r\n")
    assert upload(client, [("a.gpx", original)]).json()["results"][0]["status"] == "imported"
    res = upload(client, [("b.gpx", variant)]).json()["results"][0]
    assert res["status"] == "duplicate"
    assert "Same track" in res["message"]
    assert res["duplicates"][0]["name"] == "a"


def test_track_hash_backfill(client, library):
    from app import db
    from app.main import backfill_track_hashes
    from app.models import Route

    upload(client, [("a.gpx", climb_gpx(5000, 20))])
    with db.SessionLocal() as s:
        route = s.query(Route).one()
        expected = route.track_hash
        route.track_hash = None
        s.commit()
    backfill_track_hashes()
    with db.SessionLocal() as s:
        assert s.query(Route).one().track_hash == expected


def test_duplicates_groups_variants_and_ignore(client):
    from tests.helpers import offset

    def east(north_m, east_m, length_m, name, reverse=False):
        pts = line_points(start=offset(51.0, 4.4, north_m, east_m), length_m=length_m, step_m=50, heading_deg=90,
                          ele=lambda d: 10.0)
        return (f"{name}.gpx", gpx_xml([(name, pts[::-1] if reverse else pts)]))

    upload(client, [
        east(0, 0, 8000, "Original"),
        east(15, 0, 8000, "Copy from other site"),   # 15 m off: near-duplicate
        east(0, 2000, 3000, "Short part", reverse=True),  # lies on Original, other direction
        east(5000, 0, 8000, "Elsewhere"),
    ])
    ids = {r["name"]: r["id"] for r in client.get("/api/routes").json()}
    client.patch(f"/api/routes/{ids['Copy from other site']}", json={"quality_rating": 4})

    dup = client.get("/api/duplicates").json()
    assert len(dup["groups"]) == 1
    group = dup["groups"][0]
    assert {r["name"] for r in group["routes"]} == {"Original", "Copy from other site"}
    assert group["suggested_keep"] == ids["Copy from other site"]  # it has a rating
    assert group["pairs"][0]["reversed"] is False

    parts = {(v["part"]["name"], v["whole"]["name"]): v for v in dup["variants"]}
    assert ("Short part", "Original") in parts
    assert parts[("Short part", "Original")]["reversed"] is True
    assert parts[("Short part", "Original")]["covered_pct"] >= 95

    # "Not duplicates" hides the group; reset brings it back.
    client.post("/api/duplicates/ignore", json={"ids": [r["id"] for r in group["routes"]]})
    assert client.get("/api/duplicates").json()["groups"] == []
    assert client.post("/api/duplicates/reset").json()["reset"] == 1
    assert len(client.get("/api/duplicates").json()["groups"]) == 1



def test_bulk_tags(client):
    upload(client, [("A.gpx", climb_gpx(3000, 5)), ("B.gpx", climb_gpx(4000, 5, start=(50.5, 5.0))),
                    ("C.gpx", climb_gpx(5000, 5, start=(50.7, 4.6)))])
    ids = {r["name"]: r["id"] for r in client.get("/api/routes").json()}
    client.patch(f"/api/routes/{ids['A']}", json={"tags": ["forest", "mud"]})

    res = client.post("/api/routes/tags", json={"ids": [ids["A"], ids["B"]], "add": [" Spring  Ride", "forest"]})
    assert res.json() == {"updated": 2}
    tags = {r["name"]: r["tags"] for r in client.get("/api/routes").json()}
    assert tags == {"A": ["forest", "mud", "spring ride"], "B": ["spring ride", "forest"], "C": []}

    res = client.post("/api/routes/tags", json={"ids": list(ids.values()), "remove": ["Forest"]})
    assert res.json() == {"updated": 2}  # C had nothing to remove
    tags = {r["name"]: r["tags"] for r in client.get("/api/routes").json()}
    assert tags == {"A": ["mud", "spring ride"], "B": ["spring ride"], "C": []}

    assert client.post("/api/routes/tags", json={"ids": [ids["A"]]}).status_code == 422
    assert client.post("/api/routes/tags", json={"ids": [], "add": ["x"]}).status_code == 422


# ---------------------------------------------------------------- activity

def test_activity_on_import_filter_edit_and_bulk(client):
    import json as _json

    res = client.post(
        "/api/import",
        files=[("files", (n, d, "application/gpx+xml")) for n, d in [
            ("A.gpx", climb_gpx(3000, 5)), ("B.gpx", climb_gpx(4000, 5, start=(50.5, 5.0))),
            ("C.gpx", climb_gpx(5000, 5, start=(50.7, 4.6)))]],
        data={"activity": "road", "overrides": _json.dumps([{}, {"activity": "hiking"}, {}])},
    )
    assert res.status_code == 200
    acts = {r["name"]: r["activity"] for r in client.get("/api/routes").json()}
    assert acts == {"A": "road", "B": "hiking", "C": "road"}

    assert [r["name"] for r in client.get("/api/routes", params={"activity": "hiking"}).json()] == ["B"]
    assert [r["name"] for r in client.get("/api/map", params={"activity": "road"}).json()] == ["A", "C"]

    ids = {r["name"]: r["id"] for r in client.get("/api/routes").json()}
    assert client.patch(f"/api/routes/{ids['A']}", json={"activity": "Gravel"}).json()["activity"] == "gravel"
    assert client.patch(f"/api/routes/{ids['A']}", json={"activity": "swimming"}).status_code == 422

    res = client.post("/api/routes/activity", json={"ids": [ids["A"], ids["B"]], "activity": "hiking"})
    assert res.json() == {"updated": 1}  # B already was a hike
    assert client.post("/api/routes/activity", json={"ids": [ids["A"]], "activity": "x"}).status_code == 422
    names = [r["name"] for r in client.get("/api/routes", params={"sort": "activity"}).json()]
    assert names == ["A", "B", "C"]  # hiking, hiking, road

    bad = client.post("/api/import", files=[("files", ("D.gpx", climb_gpx(1000, 1), "application/gpx+xml"))],
                      data={"activity": "sailing"})
    assert bad.status_code == 422


def test_default_activity_and_backfill(client):
    from app import db
    from app.main import backfill_activity
    from app.models import Route

    upload(client, [("A.gpx", climb_gpx(3000, 5))])
    assert client.get("/api/routes").json()[0]["activity"] == "gravel"
    with db.SessionLocal() as s:
        s.query(Route).one().activity = None
        s.commit()
    backfill_activity()
    assert client.get("/api/routes").json()[0]["activity"] == "gravel"


def test_combine_profile_follows_activity(client, monkeypatch):
    from app import brouter

    a, b = _two_parallel_routes(client)
    used = []
    monkeypatch.setattr(brouter, "route", lambda p, q, profile, params=None, **kw: used.append(profile) or
                        [(p[0], p[1], None), (q[0], q[1], None)])
    one = [{"a": [51.0, 4.43], "b": [51.0072, 4.43]}]
    req = {"a_id": a, "b_id": b, "connections": one}

    client.post("/api/combine/preview", json=req)
    client.post("/api/routes/activity", json={"ids": [a, b], "activity": "hiking"})
    client.post("/api/combine/preview", json=req)
    client.post("/api/routes/activity", json={"ids": [a], "activity": "road"})
    client.post("/api/combine/preview", json=req)  # mixed: first profile in the list
    client.post("/api/combine/preview", json={**req, "profile": "fastbike"})  # explicit choice wins
    assert used == ["gravel", "hiking-mountain", "gravel", "fastbike"]

    saved = client.post("/api/combine/save", json={**req, "name": "Mixed"}).json()
    assert client.get(f"/api/routes/{saved['id']}").json()["activity"] == "road"  # from route A


# ---------------------------------------------------------------- new start point


def test_restart_preview_download_save(client, library):
    from tests.helpers import offset

    upload(client, [("Loop.gpx", gpx_xml([("Loop", loop_points(radius_m=2000, ele=lambda i: 10 + (i % 100) / 10))])),
                    ("Line.gpx", climb_gpx(5000, 20, start=(50.5, 4.0)))])
    ids = {r["name"]: r["id"] for r in client.get("/api/routes").json()}
    loop_id = ids["Loop"]
    client.patch(f"/api/routes/{loop_id}", json={"tags": ["forest"], "quality_rating": 4, "paved_pct": 30})
    original = client.get(f"/api/routes/{loop_id}").json()

    # Due east of the centre: a quarter of the way round (the loop starts due north, clockwise).
    east_point = list(offset(51.0, 4.4, 0, 2000))
    req = {"route_id": loop_id, "start": east_point}
    prev = client.post("/api/restart/preview", json=req)
    assert prev.status_code == 200, prev.text
    prev = prev.json()
    assert prev["start"] == pytest.approx(east_point, abs=1e-4)
    assert prev["start_km"] == pytest.approx(original["distance_km"] / 4, rel=0.02)
    assert prev["distance_km"] == pytest.approx(original["distance_km"], rel=0.01)
    assert prev["geometry"][0] == pytest.approx(prev["geometry"][-1], abs=1e-5)

    gpx = client.post("/api/restart/gpx", json={**req, "name": "Loop east"})
    assert gpx.status_code == 200
    assert b"<trkpt" in gpx.content and 'filename="Loop east.gpx"' in gpx.headers["content-disposition"]

    saved = client.post("/api/restart/save", json={**req, "name": "Loop east"})
    assert saved.status_code == 200, saved.text
    new = client.get(f"/api/routes/{saved.json()['id']}").json()
    assert new["name"] == "Loop east"
    assert new["is_loop"]
    assert new["derived_from"] == [loop_id]
    assert new["tags"] == ["forest"] and new["quality_rating"] == 4
    assert new["paved_pct"] == 30 and new["paved_source"] == "manual"
    assert new["start_lat"] == pytest.approx(east_point[0], abs=1e-4)
    assert new["gpx_path"] == "derived/loop-east.gpx"
    assert (library / new["gpx_path"]).is_file()
    # The original route and its file are unchanged.
    assert client.get(f"/api/routes/{loop_id}").json()["start_lat"] == original["start_lat"]

    # The same start again is the same track: refused, and no stray file is left behind.
    again = client.post("/api/restart/save", json={**req, "name": "Loop east again"})
    assert again.status_code == 409
    assert not (library / "derived/loop-east-again.gpx").exists()

    # Reversed is a different route.
    rev = client.post("/api/restart/save", json={**req, "reverse": True, "name": "Loop east reversed"})
    assert rev.status_code == 200, rev.text

    # The new starts are deliberate variants, not duplicates of the original or each other.
    assert client.get("/api/duplicates").json()["groups"] == []
    client.post("/api/duplicates/reset")
    [group] = client.get("/api/duplicates").json()["groups"]
    assert {r["id"] for r in group["routes"]} == {loop_id, new["id"], rev.json()["id"]}


def test_restart_errors(client):
    upload(client, [("Line.gpx", climb_gpx(5000, 20))])
    line_id = client.get("/api/routes").json()[0]["id"]
    res = client.post("/api/restart/preview", json={"route_id": line_id, "start": [51.0, 4.42]})
    assert res.status_code == 422 and "not a loop" in res.json()["detail"]
    assert client.post("/api/restart/preview", json={"route_id": 999, "start": [51.0, 4.42]}).status_code == 404
