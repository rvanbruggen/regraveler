import pytest

from app import config, db


@pytest.fixture
def library(tmp_path, monkeypatch):
    """Fresh database and GPX library folder per test."""
    gpx_dir = tmp_path / "gpx"
    gpx_dir.mkdir()
    monkeypatch.setattr(config, "GPX_DIR", gpx_dir.resolve())
    monkeypatch.setattr(config, "DATA_DIR", (tmp_path / "data").resolve())
    # No background surface estimates (they would call a real BRouter).
    monkeypatch.setattr(config, "SURFACE_AUTO_ESTIMATE", False)
    db.init_db(f"sqlite:///{tmp_path / 'test.db'}")
    yield gpx_dir
    db.engine.dispose()
    db.engine = None


@pytest.fixture
def session(library):
    with db.SessionLocal() as s:
        yield s
