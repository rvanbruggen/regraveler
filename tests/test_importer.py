import pytest
from sqlalchemy import select

from app import config
from app.importer import import_folder, import_gpx, route_name, slugify
from app.models import Route
from tests.helpers import gpx_xml, line_points, loop_points, offset


def loop_gpx(name="Loop", center=(51.0, 4.4), shift_m=0.0, radius_m=2000.0):
    pts = loop_points(center=center, radius_m=radius_m, ele=lambda i: 10 + (i % 50) / 5)
    pts = [(*offset(la, lo, shift_m, 0), e) for la, lo, e in pts]
    return gpx_xml([(name, pts)])


def test_import_creates_route_and_stores_upload(session, library):
    res = import_gpx(session, loop_gpx(), "My Loop.gpx", source_name="Test Source", source_url="https://x.test/1")
    assert res.status == "imported"
    route = session.get(Route, res.routes[0]["id"])
    assert route.name == "My Loop"
    assert route.slug == "my-loop"
    assert route.is_loop
    assert route.source_name == "Test Source"
    assert route.gpx_path == "uploads/test-source/My Loop.gpx"
    assert (library / route.gpx_path).read_bytes() == loop_gpx()


def test_duplicate_file_is_skipped(session, library):
    import_gpx(session, loop_gpx(), "a.gpx")
    res = import_gpx(session, loop_gpx(), "copy of a.gpx")
    assert res.status == "duplicate"
    assert res.routes == []
    assert len(session.scalars(select(Route)).all()) == 1
    assert not (library / "uploads/unsorted/copy of a.gpx").exists()


def test_invalid_file_reports_error(session, library):
    res = import_gpx(session, b"<nope/>", "bad.gpx")
    assert res.status == "error"
    assert session.scalars(select(Route)).all() == []


def test_multi_track_file_gives_one_route_per_track(session, library):
    data = gpx_xml([("Short loop", line_points(length_m=1000)),
                    ("Long loop", line_points(start=(51.2, 4.4), length_m=3000))])
    res = import_gpx(session, data, "Start Somewhere.gpx")
    assert [r["name"] for r in res.routes] == ["Short loop", "Long loop"]
    routes = session.scalars(select(Route).order_by(Route.track_index)).all()
    assert [r.track_index for r in routes] == [0, 1]
    assert routes[0].gpx_path == routes[1].gpx_path
    assert routes[1].distance_km == pytest.approx(3.0, rel=0.01)
    # Importing the same file again is a duplicate for both tracks.
    assert import_gpx(session, data, "Start Somewhere.gpx").status == "duplicate"


def test_near_duplicate_geometry_is_flagged(session, library):
    first = import_gpx(session, loop_gpx("A"), "a.gpx")
    # Same loop shifted 15 m: different file, near-identical route.
    res = import_gpx(session, loop_gpx("B", shift_m=15), "b.gpx")
    assert res.status == "imported"
    assert len(res.similar) == 1
    assert res.similar[0]["other_id"] == first.routes[0]["id"]
    assert res.similar[0]["overlap"] > 0.95


def test_distant_or_partial_routes_are_not_flagged(session, library):
    import_gpx(session, loop_gpx("A"), "a.gpx")
    far = import_gpx(session, loop_gpx("Far", center=(50.5, 5.0)), "far.gpx")
    shifted = import_gpx(session, loop_gpx("Shifted", shift_m=500), "shifted.gpx")
    assert far.similar == []
    assert shifted.similar == []


def test_same_name_gets_unique_slug(session, library):
    import_gpx(session, loop_gpx(), "Route X.gpx")
    res = import_gpx(session, loop_gpx(center=(50.5, 5.0)), "Route X.gpx")
    assert session.get(Route, res.routes[0]["id"]).slug == "route-x-2"
    # A different file with the same name is stored next to the first one.
    assert session.get(Route, res.routes[0]["id"]).gpx_path == "uploads/unsorted/Route X (2).gpx"


def test_source_url_defaults_to_link_in_file(session, library):
    data = gpx_xml([("T", line_points(length_m=500))], link="https://routes.test/abc")
    res = import_gpx(session, data, "t.gpx")
    assert session.get(Route, res.routes[0]["id"]).source_url == "https://routes.test/abc"


@pytest.mark.parametrize(
    "filename,track,count,index,expected",
    [
        ("Gravelroute Haspengouw.gpx", "Haspengouw-77km-430hm", 1, 0, "Gravelroute Haspengouw"),
        ("Start.gpx", "Gravelroute BK Grobbendonk", 1, 0, "Gravelroute BK Grobbendonk"),
        ("Start (48).gpx", "ek-gravel-houffalize", 1, 0, "ek-gravel-houffalize"),
        ("Start Aarschot.gpx", "Gravelroute Noord-Hageland", 1, 0, "Gravelroute Noord-Hageland"),
        ("Start.gpx", None, 1, 0, "Start"),
        ("sportvlaanderen-gravelroute-mol.gpx", "Gravelroute Mol", 1, 0, "Gravelroute Mol"),
        ("Two.gpx", "Track B", 2, 1, "Track B"),
        ("Two.gpx", None, 2, 1, "Two #2"),
    ],
)
def test_route_name(filename, track, count, index, expected):
    assert route_name(filename, track, count, index) == expected


def test_slugify():
    assert slugify("Gravelroute Meerdaalwoud - Zoniënwoud") == "gravelroute-meerdaalwoud-zonienwoud"
    assert slugify("!!!") == "route"


def test_import_folder_references_library_files_in_place(session, library):
    src = library / "gravelroutedatabase.be"
    src.mkdir()
    (src / "Loop A.gpx").write_bytes(loop_gpx("A"))
    (src / "Loop A (1).gpx").write_bytes(loop_gpx("A"))  # browser copy, identical
    (src / "notes.txt").write_text("ignore me")
    results = import_folder(session, library)
    assert [(r.filename, r.status) for r in results] == [("Loop A.gpx", "imported"), ("Loop A (1).gpx", "duplicate")]
    route = session.scalars(select(Route)).one()
    assert route.gpx_path == "gravelroutedatabase.be/Loop A.gpx"
    assert route.source_name == "gravelroutedatabase.be"
    assert not (library / "uploads").exists()


def test_import_folder_outside_library_copies_files(session, library, tmp_path):
    outside = tmp_path / "elsewhere"
    outside.mkdir()
    (outside / "x.gpx").write_bytes(loop_gpx())
    import_folder(session, outside, source_name="Manual")
    route = session.scalars(select(Route)).one()
    assert route.gpx_path == "uploads/manual/x.gpx"
    assert (config.GPX_DIR / route.gpx_path).exists()


def test_import_folder_with_tags(session, library):
    src = library / "batch"
    src.mkdir()
    (src / "a.gpx").write_bytes(loop_gpx())
    import_folder(session, library, tags=["Hageland", " favourite "])
    assert session.scalars(select(Route)).one().tags == ["hageland", "favourite"]
