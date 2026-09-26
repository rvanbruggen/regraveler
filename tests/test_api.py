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
    assert "Gravel Route Manager" in client.get("/").text
    assert client.get("/static/app.js").status_code == 200


def test_version_endpoint(client):
    from app import __version__

    assert client.get("/api/version").json() == {"version": __version__}
