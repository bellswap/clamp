#!/usr/bin/env python3
"""Retrying JSON-RPC proxy between anvil and its fork upstream (stdlib only).

drpc (the only keyless archive RPC for chain 4663 that serves anvil) routes some requests to pruned nodes, which
answer a state read at the pinned fork block with HTTP 400 {"error":{"code":27,"message":"Unknown state. First
available state is 1"}}. anvil 1.7.1 does not retry that and passes it to the client as -32603, or panics when it
happens inside a block's pre-execution system call. This proxy retries such answers (and 429, 5xx, connection
errors) with a capped backoff, so anvil only sees good answers. Each round sends PROXY_HEDGE (default 3) copies of
the request at once and keeps the first good answer, because drpc picks a node per request and a pruned node is the
common case for state reads at an old fork block.

    PROXY_UPSTREAM=<upstream url> upstream-proxy.py <listen port>     e.g. 8672 with https://robinhood.drpc.org
    upstream-proxy.py <listen port> <upstream url>                    (argv fallback, visible in ps)

The upstream may carry an API key in its path or query, so it comes from the environment (not argv, which ps and
docker inspect's Cmd show) and the startup line logs only its scheme and host.
"""
import concurrent.futures, http.server, json, os, socketserver, sys, time, urllib.error, urllib.parse, urllib.request

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8672
UPSTREAM = os.environ.get("PROXY_UPSTREAM") or (sys.argv[2] if len(sys.argv) > 2 else "https://robinhood.drpc.org")
BUDGET_S = 100.0          # total retry time per request; anvil's --timeout is 120 s
UA = "bellswap-demo-fork-proxy/1"
# Listen address: loopback by default; PROXY_HOST=0.0.0.0 inside the docker network (infra/docker-compose.yml).
HOST = os.environ.get("PROXY_HOST", "127.0.0.1")
HEDGE = max(1, int(os.environ.get("PROXY_HEDGE", "3")))
POOL = concurrent.futures.ThreadPoolExecutor(max_workers=64)


def attempt(body):
    try:
        req = urllib.request.Request(UPSTREAM, data=body, headers={"Content-Type": "application/json", "User-Agent": UA})
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()
    except Exception as e:  # connection reset, timeout
        return 599, json.dumps({"error": {"code": -32000, "message": str(e)}}).encode()


def hedged(body):
    """HEDGE parallel attempts; the first non-transient answer wins, else the last answer seen."""
    futs = [POOL.submit(attempt, body) for _ in range(HEDGE)]
    status, out = 599, b""
    for f in concurrent.futures.as_completed(futs):
        status, out = f.result()
        if not transient(status, out):
            return status, out
    return status, out


def transient(status, body):
    if status == 429 or status >= 500:
        return True
    try:
        d = json.loads(body)
    except Exception:
        return status != 200
    items = d if isinstance(d, list) else [d]
    for it in items:
        e = it.get("error") if isinstance(it, dict) else None
        if e and (e.get("code") == 27 or "Unknown state" in str(e.get("message", "")) or e.get("code") == 429):
            return True
    return status == 400


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        pass

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
        t0, delay, tries, status, out = time.time(), 0.25, 0, 502, b'{"jsonrpc":"2.0","id":null,"error":{"code":-32000,"message":"upstream unavailable"}}'
        while True:
            tries += 1
            status, out = hedged(body)
            if not transient(status, out) or time.time() - t0 > BUDGET_S:
                break
            time.sleep(delay)
            delay = min(delay * 2, 3.0)
        if tries > 1:
            sys.stderr.write(f"[proxy {time.strftime('%H:%M:%S')}] {tries} rounds of {HEDGE}, final status {status}\n")
            sys.stderr.flush()
        if status == 599:
            status = 502
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def redact(url):
    """Scheme and host only (no userinfo, port, path or query), so a keyed upstream never reaches the logs."""
    parts = urllib.parse.urlsplit(url)
    return f"{parts.scheme}://{parts.hostname or '?'}"


if __name__ == "__main__":
    sys.stderr.write(f"[proxy] listening on {HOST}:{PORT}, upstream {redact(UPSTREAM)}\n")
    Server((HOST, PORT), Handler).serve_forever()
