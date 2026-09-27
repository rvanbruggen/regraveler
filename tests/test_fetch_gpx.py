"""The server fetching GPX files for "Import from a link" (api/fetch-gpx)."""
import ipaddress
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from app import main
from tests.helpers import gpx_xml, line_points

GPX = gpx_xml([("track", line_points(start=(51.0, 4.4), length_m=1000))])
if isinstance(GPX, str):
    GPX = GPX.encode()

PAGES = {
    "/route.gpx": (200, "application/gpx+xml", GPX),
    "/page.html": (200, "text/html", b"<!DOCTYPE html><html><body>Download GPX</body></html>"),
    "/private.gpx": (403, "text/html", b"sign in"),
    "/big.gpx": (200, "application/gpx+xml", GPX + b" " * 2000),
}


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/redirect":
            self.send_response(302)
            self.send_header("Location", "/route.gpx")
            self.end_headers()
            return
        if self.path == "/redirect-file":
            self.send_response(302)
            self.send_header("Location", "file:///etc/passwd")
            self.end_headers()
            return
        status, ctype, body = PAGES.get(self.path, (404, "text/plain", b"no"))
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


@pytest.fixture
def site():
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{server.server_address[1]}"
    server.shutdown()


@pytest.fixture
def local_allowed(monkeypatch):
    """Treat 127.0.0.1 as public, to test the fetching itself against the local test site."""
    monkeypatch.setattr(main, "is_public", lambda ip: True)


def fetch(client, url):
    return client.get("/api/fetch-gpx", params={"url": url})


def test_public_address_check():
    assert main.is_public(ipaddress.ip_address("8.8.8.8"))
    assert main.is_public(ipaddress.ip_address("2a00:1450:4001::1"))
    for ip in ["127.0.0.1", "10.0.0.5", "192.168.1.10", "172.16.0.1", "169.254.169.254", "100.64.0.1",
               "0.0.0.0", "::1", "fe80::1", "fd00::1", "::ffff:192.168.1.10", "224.0.0.1"]:
        assert not main.is_public(ipaddress.ip_address(ip)), ip


def test_never_fetches_from_this_machine_or_network(client, site):
    res = fetch(client, f"{site}/route.gpx")
    assert res.status_code == 403
    assert "public internet" in res.json()["detail"]
    # Also not when a name resolves to this machine.
    res = fetch(client, site.replace("127.0.0.1", "localhost") + "/route.gpx")
    assert res.status_code == 403
    # Refused before connecting (no waiting for an address that doesn't answer).
    assert fetch(client, "http://192.168.1.1/x.gpx").status_code == 403


def test_checks_the_address_connected_to(client, site, monkeypatch):
    """A name that looked public when checked, but leads to this machine when connecting."""
    real = main.is_public
    checks = []

    def public_first_time(ip):
        checks.append(ip)
        return len(checks) == 1 or real(ip)

    monkeypatch.setattr(main, "is_public", public_first_time)
    res = fetch(client, f"{site}/route.gpx")
    assert res.status_code == 403
    assert len(checks) == 2


def test_only_web_links(client):
    for url in ["file:///etc/passwd", "ftp://example.com/a.gpx", "data:,x", "not a link", "http://"]:
        assert fetch(client, url).status_code == 400, url


def test_fetches_a_gpx_file(client, site, local_allowed):
    res = fetch(client, f"{site}/route.gpx")
    assert res.status_code == 200
    assert res.content == GPX
    assert res.headers["content-type"].startswith("application/gpx+xml")
    # Redirects are followed (and every hop is checked the same way).
    assert fetch(client, f"{site}/redirect").content == GPX


def test_refuses_what_is_not_a_gpx_file(client, site, local_allowed):
    res = fetch(client, f"{site}/page.html")
    assert res.status_code == 422
    assert "doesn't lead to a GPX file" in res.json()["detail"]


def test_explains_errors_of_the_other_site(client, site, local_allowed):
    assert "sign in" in fetch(client, f"{site}/private.gpx").json()["detail"]
    assert "(404)" in fetch(client, f"{site}/missing.gpx").json()["detail"]
    assert fetch(client, f"{site}/redirect-file").status_code == 502


def test_size_limit(client, site, local_allowed, monkeypatch):
    monkeypatch.setattr(main.config, "LINK_FETCH_MAX_BYTES", len(GPX) + 100)
    assert fetch(client, f"{site}/route.gpx").status_code == 200
    assert fetch(client, f"{site}/big.gpx").status_code == 413
