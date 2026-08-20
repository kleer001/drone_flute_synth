"""The GUI's HTTP transport (SPEC §10.6).

`ThreadingHTTPServer` from the standard library on a daemon thread, serving one
static page and a handful of JSON endpoints. No new dependencies: the page
polls `GET /state` at 4 Hz, which costs nothing over loopback and avoids the
thread-per-tab that an SSE stream would pin under this server.

The server owns nothing. It calls the `Controller` and returns what it says,
so closing the tab, killing the browser, or never opening one at all changes
nothing about the performance or the panic path (§10.11).
"""
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from ..control import ValidationError

STATIC = Path(__file__).parent / "static"
CONTENT_TYPES = {".html": "text/html; charset=utf-8",
                 ".js": "text/javascript; charset=utf-8",
                 ".css": "text/css; charset=utf-8"}
MAX_BODY = 64 * 1024


class _Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "belvedere-drone"

    # -- plumbing ----------------------------------------------------------

    def log_message(self, fmt, *args):
        """Silence the default stderr access log; the performance owns stdout."""

    def _send(self, code, body, content_type="application/json"):
        payload = body if isinstance(body, bytes) else body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(payload)

    def _json(self, code, obj):
        self._send(code, json.dumps(obj))

    def _authorised(self, query):
        token = self.server.token
        if token is None:
            return True
        offered = self.headers.get("X-Token") or (query.get("token") or [None])[0]
        return offered == token

    def _body(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_BODY:
            raise ValueError("request body too large")
        if not length:
            return {}
        return json.loads(self.rfile.read(length).decode("utf-8"))

    # -- routes ------------------------------------------------------------

    def do_GET(self):
        url = urlparse(self.path)
        query = parse_qs(url.query)
        if not self._authorised(query):
            return self._json(403, {"error": "bad or missing token"})
        if url.path in ("/", "/index.html"):
            return self._file("index.html")
        if url.path in ("/app.js", "/style.css"):
            return self._file(url.path.lstrip("/"))
        if url.path == "/state":
            return self._json(200, self.server.controller.snapshot())
        self._json(404, {"error": "not found"})

    def do_POST(self):
        url = urlparse(self.path)
        if not self._authorised(parse_qs(url.query)):
            return self._json(403, {"error": "bad or missing token"})
        control = self.server.controller
        try:
            body = self._body()
        except ValueError as exc:
            return self._json(400, {"error": str(exc)})

        try:
            if url.path == "/submit":
                if body:
                    control.stage(body)
                return self._json(200, {"submission_id": control.submit()})
            if url.path == "/level":
                control.set_level(body["value"])
                return self._json(200, {"ok": True})
            if url.path == "/start":
                control.set_running(True)
                return self._json(200, {"ok": True})
            if url.path == "/stop":
                control.set_running(False)
                return self._json(200, {"ok": True})
            if url.path == "/panic":
                control.panic()
                return self._json(200, {"ok": True})
            if url.path == "/regenerate":
                return self._json(200, {"odf_path": control.regenerate(),
                                        "reload_required": True})
        except ValidationError as exc:
            return self._json(422, {"errors": exc.errors})
        except (KeyError, TypeError, ValueError) as exc:
            return self._json(400, {"error": str(exc)})
        self._json(404, {"error": "not found"})

    def _file(self, name):
        path = STATIC / name
        if not path.is_file():
            return self._json(404, {"error": "not found"})
        self._send(200, path.read_bytes(),
                   CONTENT_TYPES.get(path.suffix, "application/octet-stream"))


def serve(controller, host="127.0.0.1", port=8737, token=None):
    """Start the server on a daemon thread and return it.

    A non-loopback host **requires** a token (§10.10): the threat is modest but
    an open port here lets a stranger start an endless drone on someone's
    speakers.
    """
    if host not in ("127.0.0.1", "localhost", "::1") and not token:
        raise ValueError(
            f"binding {host} requires --token; loopback is the only address "
            f"served without one")
    httpd = ThreadingHTTPServer((host, port), _Handler)
    httpd.daemon_threads = True
    httpd.controller = controller
    httpd.token = token
    threading.Thread(target=httpd.serve_forever, daemon=True,
                     name="belvedere-web").start()
    return httpd
