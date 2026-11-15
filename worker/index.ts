/**
 * NetLens Worker entry.
 *
 * MVP: static assets only. The Worker runs first only for /api/* (see wrangler.jsonc)
 * so later phases can add routes here, e.g. /api/session/:id -> Durable Object
 * (shared live sessions over WebSockets).
 */
export interface Env {
  ASSETS: Fetcher;
  // SESSIONS: DurableObjectNamespace; // Phase 4
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/api/health') {
      return Response.json({ ok: true, service: 'netlens' });
    }
    if (url.pathname.startsWith('/api/')) {
      return new Response('Not found', { status: 404 });
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
