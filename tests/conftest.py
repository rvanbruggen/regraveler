import pytest
from fastapi.testclient import TestClient

from app import config, db, store


@pytest.fixture
def library(tmp_path, monkeypatch):
    """Fresh database and GPX folder per test."""
    gpx_dir = tmp_path / "gpx"
    gpx_dir.mkdir()
    monkeypatch.setattr(config, "GPX_DIR", gpx_dir.resolve())
    monkeypatch.setattr(config, "DATA_DIR", (tmp_path / "data").resolve())
    store._disk_cache.clear()
    db.init_db(f"sqlite:///{tmp_path / 'test.db'}")
    yield gpx_dir
    db.engine.dispose()
    db.engine = None


@pytest.fixture
def session(library):
    with db.SessionLocal() as s:
        yield s


@pytest.fixture
def client(library):
    from app.main import app

    with TestClient(app) as c:
        yield c
