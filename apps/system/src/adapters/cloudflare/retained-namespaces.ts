// @module platform.runtime
// @role retained-namespaces
import { DurableObject } from 'cloudflare:workers';

// Keep the provisioned class identities without running the retired implementation
// or touching its stored data. The new application uses its D1 DB binding.
class RetainedNamespace extends DurableObject {
  fetch(): Response {
    return Response.json({ error: 'retired_namespace' }, {
      status: 410,
      headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
    });
  }

  alarm(): void {
    // Finish any previously scheduled alarm without rescheduling or changing data.
  }

  webSocketMessage(ws: WebSocket): void {
    ws.close(1001, 'Retired namespace');
  }

  webSocketError(ws: WebSocket): void {
    ws.close(1001, 'Retired namespace');
  }

  webSocketClose(): void {
    // The configured compatibility date enables the runtime close handshake.
  }
}

export class RateLimiter extends RetainedNamespace {}
export class WorkspaceHub extends RetainedNamespace {}
