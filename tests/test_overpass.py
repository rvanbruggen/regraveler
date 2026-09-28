"""The server passing places queries on to the Overpass API (api/overpass)."""
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs

import pytest

from app import config, main

ANSWER = {"elements": [{"type": "node", "id": 1, "lat": 51.0, "lon": 4.4, "tags": {"amenity": "drinking_water"}}]}
calls = []


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        body = self.rfile.read(int(self.headers["Content-Length"])).decode()
        calls.append((self.path, self.headers["User-Agent"], parse_qs(body)["data"][0]))
        if self.path == "/busy":
            self.send_response(504)
            self.end_headers()
            self.wfile.write(b"<html>Gateway Timeout</html>")
            return
        data = json.dumps(ANSWER).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args):
        pass


@pytest.fixture
def upstream(monkeypatch):
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{server.server_address[1]}"
    monkeypatch.setattr(config, "OVERPASS_URLS", [f"{base}/busy", f"{base}/ok"])
    main._overpass_cache.clear()
    calls.clear()
    yield base
    server.shutdown()


Q = '[out:json][timeout:25];(nwr["amenity"~"^(drinking_water)$"](50.8,4.6,50.9,4.7););out center tags;'


def test_a_busy_server_is_skipped_and_answers_are_kept(client, upstream):
    res = client.post("/api/overpass", content=f"data={Q}", headers={"Content-Type": "application/x-www-form-urlencoded"})
    assert res.status_code == 200, res.text
    assert res.json() == ANSWER
    assert [c[0] for c in calls] == ["/busy", "/ok"]
    assert all(c[1].startswith("rerouter/") and c[2] == Q for c in calls)
    # The same question again: from the cache.
    assert client.post("/api/overpass", content=f"data={Q}").json() == ANSWER
    assert len(calls) == 2


def test_only_places_queries_and_a_message_when_all_are_busy(client, upstream, monkeypatch):
    assert client.post("/api/overpass", content="data=[out:xml];node(1);out;").status_code == 400
    assert client.post("/api/overpass", content="nothing").status_code == 400
    monkeypatch.setattr(config, "OVERPASS_URLS", [f"{upstream}/busy"])
    res = client.post("/api/overpass", content=f"data={Q}")
    assert res.status_code == 503
    assert "busy" in res.json()["detail"]
