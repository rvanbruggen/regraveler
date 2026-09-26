"""BRouter client against a tiny local HTTP server that mimics BRouter's responses."""
import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, urlparse

import pytest

from app import brouter

GEOJSON = {
    "type": "FeatureCollection",
    "features": [{
        "type": "Feature",
        "properties": {"creator": "BRouter-1.7.10", "track-length": "5601"},
        "geometry": {"type": "LineString", "coordinates": [[4.3999, 51.199922, 7.0], [4.45015, 51.219974, 5.5]]},
    }],
}


class FakeBRouter(BaseHTTPRequestHandler):
    requests = []

    def do_GET(self):
        url = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(url.query).items()}
        FakeBRouter.requests.append((url.path, q))
        if q.get("profile") == "missing-tile":
            self._send(400, "datafile E5_N50.rd5 not found\n", "text/plain")
        elif q.get("profile") == "unknown":
            self._send(500, "", "text/plain")
        elif q.get("profile") == "garbage":
            self._send(200, "not json", "text/plain")
        else:
            self._send(200, json.dumps(GEOJSON), "application/vnd.geo+json")

    def _send(self, code, body, ctype):
        data = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args):
        pass


@pytest.fixture(scope="module")
def server():
    httpd = HTTPServer(("127.0.0.1", 0), FakeBRouter)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{httpd.server_port}"
    httpd.shutdown()


def test_route_request_and_response(server):
    FakeBRouter.requests.clear()
    pts = brouter.route((51.2, 4.4), (51.22, 4.45), "gravel", {"prefer_unpaved_paths": "1"}, base_url=server)
    assert pts == [(51.199922, 4.3999, 7.0), (51.219974, 4.45015, 5.5)]
    path, q = FakeBRouter.requests[0]
    assert path == "/brouter"
    assert q["lonlats"] == "4.400000,51.200000|4.450000,51.220000"  # lon,lat order
    assert q["profile"] == "gravel"
    assert q["format"] == "geojson"
    assert q["alternativeidx"] == "0"
    assert q["profile:prefer_unpaved_paths"] == "1"


def test_missing_tile_is_explained(server):
    with pytest.raises(brouter.BRouterError, match="missing tile E5_N50.rd5"):
        brouter.route((50.2, 6.6), (50.22, 6.62), "missing-tile", base_url=server)


def test_empty_error_mentions_profile(server):
    with pytest.raises(brouter.BRouterError, match="unknown profile 'unknown'"):
        brouter.route((51.2, 4.4), (51.22, 4.45), "unknown", base_url=server)


def test_unexpected_response(server):
    with pytest.raises(brouter.BRouterError, match="not json"):
        brouter.route((51.2, 4.4), (51.22, 4.45), "garbage", base_url=server)


def test_unreachable_server():
    with pytest.raises(brouter.BRouterUnavailable, match="not reachable"):
        brouter.route((51.2, 4.4), (51.22, 4.45), "gravel", base_url="http://127.0.0.1:9", timeout=2)
