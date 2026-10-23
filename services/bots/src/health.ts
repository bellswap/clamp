// GET /health on BOTS_HEALTH_PORT (8790): 200 while the open loop ticked within max(2 min, 10 intervals) (or before
// it started), else 503. No other routes.
export function serveHealth(port: number, info: () => Record<string, unknown> & { ok: boolean }) {
  return Bun.serve({
    port,
    hostname: '0.0.0.0',
    fetch(req) {
      const u = new URL(req.url);
      if (u.pathname !== '/health') return new Response('not found', { status: 404 });
      const i = info();
      return Response.json(i, { status: i.ok ? 200 : 503 });
    },
  });
}
