#!/usr/bin/env python3
"""FlyWire Digital Twin — static HTTP server for the Drosophila brain frontend.

Serves:
  /            -> frontend/index.html and the frontend/ subtree
  /models/*    -> the models/ subtree (fly_brain.obj)

* Correct MIME types (application/javascript for .js, model/obj for .obj).
* Permissive CORS headers (Access-Control-Allow-Origin: *) on every response.
* Threaded, resets cache-control for dev iteration.
"""

import argparse
import http.server
import os
import posixpath
import sys
import urllib.parse
from functools import partial
from http.server import ThreadingHTTPServer

ROOT_DIR = os.path.dirname(os.path.abspath(__file__))
FRONTEND_DIR = os.path.normpath(os.path.join(ROOT_DIR, "..", "frontend"))
MODELS_DIR = os.path.normpath(os.path.join(ROOT_DIR, "..", "models"))

MIME_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".htm": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".mjs": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".obj": "model/obj; charset=utf-8",
    ".mtl": "text/plain; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".wasm": "application/wasm",
    ".txt": "text/plain; charset=utf-8",
    ".map": "application/json; charset=utf-8",
}


class FlyWireHandler(http.server.SimpleHTTPRequestHandler):
    """Request handler with CORS headers, MIME corrections and safe routing."""

    protocol_version = "HTTP/1.1"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=FRONTEND_DIR, **kwargs)

    # --- CORS -------------------------------------------------------------
    def _send_cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Access-Control-Max-Age", "86400")

    def end_headers(self):
        self._send_cors()
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self._send_cors()
        self.end_headers()

    # --- Safe path resolution --------------------------------------------
    def translate_path(self, path):
        """Resolve / and /models/* to the physical filesystem, traversal-safe."""
        parsed = urllib.parse.urlparse(path)
        path = posixpath.normpath(urllib.parse.unquote(parsed.path))

        if path == "/" or path == "":
            return os.path.join(FRONTEND_DIR, "index.html")

        if path.startswith("/models/"):
            base = MODELS_DIR
            rel = path[len("/models/"):]
        else:
            base = FRONTEND_DIR
            rel = path.lstrip("/")

        rel_parts = [p for p in rel.split("/") if p]

        # Reject any path escaping the served roots.
        for part in rel_parts:
            if part in ("..", ".") or "\x00" in part:
                return os.path.join(base, "flywire__denied__404")
        joined = os.path.normpath(os.path.join(base, *rel_parts))
        base_real = os.path.realpath(base)
        joined_real = os.path.realpath(joined)
        if not (joined_real == base_real or joined_real.startswith(base_real + os.sep)):
            return os.path.join(base, "flywire__denied__404")
        return joined

    def guess_type(self, path):
        ext = os.path.splitext(path)[1].lower()
        if ext in MIME_TYPES:
            return MIME_TYPES[ext]
        return "application/octet-stream"


def make_server(host, port):
    return ThreadingHTTPServer((host, port), FlyWireHandler)


def main():
    ap = argparse.ArgumentParser(description="FlyWire Digital Twin server")
    ap.add_argument("--host", default="0.0.0.0", help="bind address")
    ap.add_argument("--port", type=int, default=8000, help="bind port (default 8000)")
    args = ap.parse_args()

    # Fail fast if the frontend isn't where we expect it.
    for p in (FRONTEND_DIR, MODELS_DIR):
        if not os.path.isdir(p):
            print("error: directory not found: %s" % p, file=sys.stderr)
            sys.exit(1)

    server = make_server(args.host, args.port)
    url = "http://localhost:%d" % args.port
    print("=" * 58)
    print("  FlyWire Digital Twin — Drosophila 2-Photon brain simulator")
    print("  Serving frontend : %s" % FRONTEND_DIR)
    print("  Serving models   : %s" % MODELS_DIR)
    print("  Open             : %s  (Ctrl-C to stop)" % url)
    print("=" * 58)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()