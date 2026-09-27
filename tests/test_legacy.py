import hashlib
import json

from sqlalchemy import text

from app import db, legacy, store
from tests.helpers import gpx_xml, line_points

OLD_SCHEMA = """
CREATE TABLE routes (
  id INTEGER PRIMARY KEY, name VARCHAR(300) NOT NULL, slug VARCHAR(300) NOT NULL,
  gpx_path VARCHAR(1000) NOT NULL, original_filename VARCHAR(500) NOT NULL, track_index INTEGER NOT NULL,
  track_name VARCHAR(300), file_hash VARCHAR(64) NOT NULL, distance_km FLOAT NOT NULL,
  elevation_gain_m FLOAT, elevation_loss_m FLOAT, min_elevation_m FLOAT, max_elevation_m FLOAT,
  start_lat FLOAT NOT NULL, start_lon FLOAT NOT NULL, end_lat FLOAT NOT NULL, end_lon FLOAT NOT NULL,
  min_lat FLOAT NOT NULL, min_lon FLOAT NOT NULL, max_lat FLOAT NOT NULL, max_lon FLOAT NOT NULL,
  is_loop BOOLEAN NOT NULL, geometry JSON NOT NULL, quality_rating INTEGER, paved_pct FLOAT,
  tags JSON NOT NULL, notes TEXT, source_name VARCHAR(300), source_url VARCHAR(1000),
  imported_at DATETIME NOT NULL, derived_from JSON NOT NULL, track_hash VARCHAR(64),
  paved_source VARCHAR(20), surface JSON, activity VARCHAR(20))
"""


def old_row(id, path, data, **kw):
    row = dict(
        id=id, name=f"Route {id}", slug=f"route-{id}", gpx_path=path, original_filename=path.split("/")[-1],
        track_index=0, track_name="t", file_hash=hashlib.sha256(data).hexdigest(), distance_km=1.0,
        elevation_gain_m=10.0, elevation_loss_m=9.0, min_elevation_m=1.0, max_elevation_m=11.0,
        start_lat=51.0, start_lon=4.4, end_lat=51.0, end_lon=4.41, min_lat=51.0, min_lon=4.4,
        max_lat=51.0, max_lon=4.41, is_loop=0, geometry=json.dumps([[51.0, 4.4], [51.0, 4.41]]),
        quality_rating=4, paved_pct=40.0, tags=json.dumps(["forest"]), notes="nice",
        source_name="db", source_url=None, imported_at="2026-09-26 10:46:00.123456",
        derived_from=json.dumps([]), track_hash="abc", paved_source="manual",
        surface=json.dumps({"paved_pct": 35}), activity=None,
    )
    row.update(kw)
    return row


def test_old_library_moves_to_the_new_store(session, library, client):
    a = gpx_xml([("a", line_points(length_m=1000))])
    b = gpx_xml([("b", line_points(start=(51.1, 4.4), length_m=1000))])
    (library / "db").mkdir()
    (library / "db" / "A.gpx").write_bytes(a)
    (library / "derived").mkdir()
    (library / "derived" / "b.gpx").write_bytes(b)
    session.execute(text(OLD_SCHEMA))
    session.execute(text("CREATE TABLE ignored_duplicates (id INTEGER PRIMARY KEY, a_id INTEGER, b_id INTEGER)"))
    cols = old_row(1, "x", b"").keys()
    insert = text(f"INSERT INTO routes ({', '.join(cols)}) VALUES ({', '.join(':' + c for c in cols)})")
    session.execute(insert, old_row(3, "db/A.gpx", a))
    session.execute(insert, old_row(7, "derived/b.gpx", b, derived_from=json.dumps([3]), activity="road", notes=None))
    session.execute(insert, old_row(9, "gone/C.gpx", b"missing", track_index=0, name="Lost"))
    session.execute(text("INSERT INTO ignored_duplicates (a_id, b_id) VALUES (3, 7)"))
    session.commit()

    assert legacy.needed(session)
    res = legacy.migrate(session)
    assert res["routes"] == 3 and res["missing_files"] == ["gone/C.gpx"] and res["ignored_pairs"] == 1
    assert not legacy.needed(session)  # only once

    lib = client.get("/api/library").json()
    by_id = {r["id"]: r for r in lib["routes"]}
    assert sorted(by_id) == [3, 7, 9]
    r = by_id[3]
    assert r["name"] == "Route 3" and r["tags"] == ["forest"] and r["is_loop"] is False
    assert r["activity"] == "gravel"  # empty in the old table: gravel, as the old version did
    assert r["surface"] == {"paved_pct": 35} and r["paved_source"] == "manual"
    assert r["imported_at"] == "2026-09-26T10:46:00Z"
    assert by_id[7]["derived_from"] == [3] and by_id[7]["activity"] == "road"
    assert lib["ignored"] == ["3_7"]
    # The files are referenced where they are.
    assert client.get(f"/api/files/{r['file_hash']}").content == a
    assert client.get(f"/api/files/{by_id[7]['file_hash']}").content == b
    # The old tables are untouched.
    assert session.execute(text("SELECT COUNT(*) FROM routes")).scalar() == 3


def test_nothing_to_move_without_old_tables(session):
    assert not legacy.needed(session)
    assert legacy.migrate_if_needed(session) is None
