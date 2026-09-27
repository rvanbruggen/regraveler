"""The browser version and the server read each other's backups (runs the page's code in Node)."""
import hashlib
import json
import shutil
import subprocess
from pathlib import Path

import pytest

from app import store
from tests.helpers import gpx_xml, line_points

CLI = Path(__file__).resolve().parent.parent / "web" / "tests" / "tools" / "backup_cli.mjs"
pytestmark = pytest.mark.skipif(shutil.which("node") is None, reason="needs Node.js")


def node(*args):
    out = subprocess.run(["node", str(CLI), *map(str, args)], capture_output=True, text=True, check=True)
    return out.stdout


def test_browser_backup_restores_on_the_server(tmp_path, client, library):
    files = []
    for i in range(3):
        f = tmp_path / f"Route {i}.gpx"
        f.write_bytes(gpx_xml([(f"t{i}", line_points(start=(51.0 + i * 0.05, 4.4), length_m=2000))]))
        files.append(f)
    zip_path = tmp_path / "from-browser.zip"
    node("make", zip_path, *files)
    res = client.post("/api/restore", content=zip_path.read_bytes())
    assert res.status_code == 200, res.text
    lib = client.get("/api/library").json()
    assert [r["name"] for r in lib["routes"]] == ["Route 0", "Route 1", "Route 2"]
    assert all(r["tags"] == ["test"] for r in lib["routes"])
    assert lib["ignored"] == ["1_2"]
    for f, r in zip(files, lib["routes"]):
        assert client.get(f"/api/files/{r['file_hash']}").content == f.read_bytes()


def test_server_backup_reads_in_the_browser(tmp_path, client, session):
    data = gpx_xml([("t", line_points(length_m=1000))])
    h = hashlib.sha256(data).hexdigest()
    store.put_file(session, h, data, "Mijn route.gpx", "uploads/x")
    store.put_routes(session, [{"name": "Mijn route", "file_hash": h, "tags": ["a"]}])
    store.put_ignored(session, ["1_5"])
    zip_path = tmp_path / "from-server.zip"
    zip_path.write_bytes(client.get("/api/backup").content)
    summary = json.loads(node("read", zip_path))
    assert summary["routes"] == [{"id": 1, "name": "Mijn route", "file_hash": h, "tags": ["a"]}]
    assert summary["ignored"] == ["1_5"]
    assert summary["files"] == [{"hash": h, "name": "Mijn route.gpx", "size": len(data)}]
