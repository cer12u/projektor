import {
  type AuthenticatedPrincipal,
  OAuthInsufficientScope,
  type RequestScope,
} from "../modules/access/public";
import { PlatformError } from "../platform/public";
import { catalog, inputFor, restOnly, type Services } from "./catalog";
import { openApi, tools } from "./wire";

export { createOAuthHttp } from "./oauth";

class AuthenticationError extends Error {}

const MAX_BODY = 64 * 1024;
const status: Record<string, number> = {
  validation: 400,
  not_found: 404,
  forbidden: 403,
  conflict: 409,
  unknown: 500,
};
const json = (value: unknown, code = 200, headers?: HeadersInit) =>
  new Response(JSON.stringify(value), {
    status: code,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
const failure = (error: unknown) =>
  error instanceof PlatformError ? error : new PlatformError("unknown", "Internal error");
const id = () => crypto.randomUUID();
function ownOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin)
    throw new PlatformError("forbidden", "Origin denied");
}
async function body(request: Request): Promise<unknown> {
  if (
    request.headers.get("content-type")?.toLowerCase().split(";")[0].trim() !== "application/json"
  )
    throw new PlatformError("validation", "Expected application/json");
  const length = Number(request.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_BODY)
    throw new PlatformError("validation", "Body too large");
  const stream = request.body?.getReader();
  if (!stream) throw new PlatformError("validation", "Expected body");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const part = await stream.read();
    if (part.done) break;
    size += part.value.byteLength;
    if (size > MAX_BODY) {
      await stream.cancel();
      throw new PlatformError("validation", "Body too large");
    }
    chunks.push(part.value);
  }
  const joined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(joined));
  } catch {
    throw new PlatformError("validation", "Invalid JSON");
  }
}
function workspace(request: Request, fromPath: string): string {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(fromPath))
    throw new PlatformError("validation", "Invalid workspace");
  const fromHeader = request.headers.get("x-workspace-id");
  if (fromHeader && fromHeader !== fromPath)
    throw new PlatformError("forbidden", "Workspace mismatch");
  return fromPath;
}
async function principal(
  request: Request,
  services: Services,
  endpoint: "rest" | "mcp",
): Promise<AuthenticatedPrincipal> {
  const assertion = request.headers.get("cf-access-jwt-assertion");
  const authorization = request.headers.get("authorization");
  if (assertion && authorization) throw new PlatformError("validation", "Ambiguous credentials");
  if (assertion) return services.access.authenticate({ kind: "human", assertion });
  if (!authorization?.startsWith("Bearer ") || authorization.length < 8)
    throw new PlatformError("forbidden", "Authentication required");
  const bearer = authorization.slice(7);
  if (bearer.startsWith("pt1.")) return services.access.authenticate({ kind: "machine", bearer });
  if (endpoint === "mcp") {
    if (!services.oauthOrigin) throw new PlatformError("forbidden", "OAuth unavailable");
    return services.access.authenticate({
      kind: "oauth",
      bearer,
      resource: `${services.oauthOrigin}/mcp`,
    });
  }
  throw new PlatformError("forbidden", "OAuth requires MCP");
}
async function admit(
  request: Request,
  services: Services,
  w: string,
  mode: "read" | "write",
  requestId: string,
  endpoint: "rest" | "mcp",
): Promise<RequestScope> {
  let actor: AuthenticatedPrincipal;
  try {
    actor = await principal(request, services, endpoint);
  } catch (error) {
    if (endpoint === "mcp" && error instanceof PlatformError && error.code === "forbidden")
      throw new AuthenticationError();
    throw error;
  }
  return services.access.requireMembership(actor, workspace(request, w), requestId, mode);
}
const rpc = (idValue: unknown, result: unknown) => ({ jsonrpc: "2.0", id: idValue, result });
const rpcError = (idValue: unknown, code: number, message: string) => ({
  jsonrpc: "2.0",
  id: idValue ?? null,
  error: { code, message },
});

export async function handleHttp(request: Request, services: Services): Promise<Response> {
  const requestId = id();
  try {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/oauth/") || url.pathname.startsWith("/.well-known/")) {
      if (services.oauthHttp) return services.oauthHttp(request);
      return json({ error: "temporarily_unavailable" }, 503, {
        "cache-control": "no-store",
        pragma: "no-cache",
        "retry-after": "5",
      });
    }
    if (url.pathname === "/api/openapi.json" && request.method === "GET")
      return json(openApi(), 200, { "x-request-id": requestId });
    if (url.pathname === "/health" && request.method === "GET")
      return json({ phase: "gateway", deployable: false }, 200, { "x-request-id": requestId });
    if (url.pathname.startsWith("/mcp/")) return handleMcp(request, services, requestId);
    const match = url.pathname.match(/^\/api\/w\/([^/]+)\/([^/]+)\/([^/]+)$/);
    if (!match) throw new PlatformError("not_found", "Unknown route");
    ownOrigin(request);
    const [, w, owner, action] = match;
    const name = `${owner}.${action}`;
    if (name === "access.create") {
      if (request.method !== "POST") throw new PlatformError("not_found", "Unknown route");
      const a = await body(request);
      if (!a || typeof a !== "object" || Array.isArray(a))
        throw new PlatformError("validation", "Expected object");
      const x = a as Record<string, unknown>;
      if (
        typeof x.operationId !== "string" ||
        typeof x.name !== "string" ||
        x.workspaceId !== undefined
      )
        throw new PlatformError("validation", "Invalid workspace input");
      const actor = await principal(request, services, "rest");
      return json(
        await services.access.createWorkspace(actor, {
          workspaceId: workspace(request, w),
          operationId: x.operationId,
          name: x.name,
        }),
        200,
        { "x-request-id": requestId },
      );
    }
    if (name === "access.workspaces") {
      if (request.method !== "GET") throw new PlatformError("not_found", "Unknown route");
      const actor = await principal(request, services, "rest");
      workspace(request, w);
      await services.access.requireMembership(actor, w, requestId);
      return json(await services.access.listWorkspaces(actor), 200, { "x-request-id": requestId });
    }
    if (restOnly.includes(name)) {
      if (request.method !== "POST") throw new PlatformError("not_found", "Unknown route");
      const a = await body(request);
      if (!a || typeof a !== "object" || Array.isArray(a))
        throw new PlatformError("validation", "Expected object");
      const x = a as Record<string, unknown>;
      const accepted =
        name === "access.credential.issue"
          ? ["operationId", "credentialId", "principalId", "secret", "scope", "expiresAt"]
          : ["operationId", "credentialId", "expectedVersion"];
      if (Object.keys(x).some((key) => !accepted.includes(key)))
        throw new PlatformError("validation", "Unknown credential field");
      if (typeof x.operationId !== "string" || typeof x.credentialId !== "string")
        throw new PlatformError("validation", "Invalid credential input");
      const scope = await admit(request, services, w, "write", requestId, "rest");
      if (name === "access.credential.revoke") {
        if (typeof x.expectedVersion !== "number")
          throw new PlatformError("validation", "Invalid version");
        return json(
          await services.access.revokeCredential(scope, {
            operationId: x.operationId,
            credentialId: x.credentialId,
            expectedVersion: x.expectedVersion,
          }),
          200,
          { "x-request-id": requestId },
        );
      }
      if (
        typeof x.principalId !== "string" ||
        typeof x.secret !== "string" ||
        !/^[0-9a-f]{64}$/.test(x.secret) ||
        (x.scope !== "read" && x.scope !== "write") ||
        typeof x.expiresAt !== "number"
      )
        throw new PlatformError("validation", "Invalid credential input");
      const secret = x.secret;
      const result = await services.access.issueCredential(scope, {
        operationId: x.operationId,
        credentialId: x.credentialId,
        principalId: x.principalId,
        scope: x.scope,
        expiresAt: x.expiresAt,
        secret,
      });
      return json({ ...result, token: `pt1.${w}.${x.credentialId}.${secret}` }, 200, {
        "x-request-id": requestId,
        "cache-control": "no-store",
      });
    }
    const entry = catalog[name];
    if (!entry || name === "access.workspaces")
      throw new PlatformError("not_found", "Unknown operation");
    if (request.method !== (entry.write ? "POST" : "GET"))
      throw new PlatformError("not_found", "Unknown route");
    let input: unknown;
    if (entry.write) input = await body(request);
    else
      input = Object.fromEntries(
        [...url.searchParams].map(([key, value]) => [
          key,
          entry.fields[key]?.includes("Number") || entry.fields[key] === "number"
            ? Number(value)
            : value,
        ]),
      );
    const args = inputFor(name, input);
    const scope = await admit(
      request,
      services,
      w,
      entry.write ? "write" : "read",
      requestId,
      "rest",
    );
    return json(await entry.call(services, scope, args), 200, { "x-request-id": requestId });
  } catch (cause) {
    const error = failure(cause);
    return json({ code: error.code, message: error.message, requestId }, status[error.code], {
      "x-request-id": requestId,
    });
  }
}

export async function handleMcp(
  request: Request,
  services: Services,
  requestId = id(),
): Promise<Response> {
  let rpcId: unknown = null;
  try {
    ownOrigin(request);
    if (services.oauthOrigin && new URL(request.url).origin !== services.oauthOrigin)
      throw new PlatformError("forbidden", "Origin denied");
    if (["access_token", "token"].some((k) => new URL(request.url).searchParams.has(k)))
      throw new PlatformError("validation", "Query credentials denied");
    const match = new URL(request.url).pathname.match(/^\/mcp\/([^/]+)$/);
    if (!match) throw new PlatformError("not_found", "Unknown MCP endpoint");
    await admit(request, services, match[1], "read", requestId, "mcp");
    if (request.method === "GET" || request.method === "DELETE")
      return new Response(null, {
        status: 405,
        headers: { allow: "POST", "x-request-id": requestId },
      });
    if (request.method !== "POST")
      return new Response(null, {
        status: 405,
        headers: { allow: "POST", "x-request-id": requestId },
      });
    const accept = request.headers.get("accept") ?? "";
    if (!accept.includes("application/json") || !accept.includes("text/event-stream"))
      throw new PlatformError("validation", "MCP Accept must include JSON and event stream");
    const value = await body(request);
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new PlatformError("validation", "Invalid JSON-RPC");
    const message = value as Record<string, unknown>;
    rpcId = message.id;
    if (message.jsonrpc !== "2.0" || typeof message.method !== "string")
      return json(rpcError(rpcId, -32600, "Invalid Request"), 400);
    if (message.method === "initialize") {
      await admit(request, services, match[1], "read", requestId, "mcp");
      return json(
        rpc(rpcId, {
          protocolVersion: "2025-11-25",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "projektor", version: "0.1.0" },
        }),
        200,
        { "x-request-id": requestId },
      );
    }
    const version = request.headers.get("mcp-protocol-version");
    if (version && !["2025-03-26", "2025-06-18", "2025-11-25"].includes(version))
      throw new PlatformError("validation", "Unsupported MCP protocol version");
    if (message.method === "notifications/initialized") {
      await admit(request, services, match[1], "read", requestId, "mcp");
      return new Response(null, { status: 202, headers: { "x-request-id": requestId } });
    }
    if (message.method === "tools/list") {
      await admit(request, services, match[1], "read", requestId, "mcp");
      return json(rpc(rpcId, { tools: tools() }), 200, { "x-request-id": requestId });
    }
    if (message.method === "tools/call") {
      const params = message.params;
      if (!params || typeof params !== "object" || Array.isArray(params))
        return json(rpcError(rpcId, -32602, "Invalid params"), 200);
      const p = params as Record<string, unknown>;
      if (
        typeof p.name !== "string" ||
        !catalog[p.name] ||
        restOnly.includes(p.name) ||
        p.name === "access.workspaces"
      )
        return json(rpcError(rpcId, -32601, "Unknown tool"), 200);
      const entry = catalog[p.name];
      try {
        const args = inputFor(p.name, p.arguments ?? {});
        const scope = await admit(
          request,
          services,
          match[1],
          entry.write ? "write" : "read",
          requestId,
          "mcp",
        );
        return json(
          rpc(rpcId, {
            content: [
              { type: "text", text: JSON.stringify(await entry.call(services, scope, args)) },
            ],
            isError: false,
          }),
          200,
          { "x-request-id": requestId },
        );
      } catch (cause) {
        if (cause instanceof AuthenticationError || cause instanceof OAuthInsufficientScope)
          throw cause;
        const error = failure(cause);
        return json(
          rpc(rpcId, {
            content: [
              { type: "text", text: JSON.stringify({ code: error.code, message: error.message }) },
            ],
            isError: true,
          }),
          200,
          { "x-request-id": requestId },
        );
      }
    }
    return json(rpcError(rpcId, -32601, "Method not found"), 200, { "x-request-id": requestId });
  } catch (cause) {
    if (cause instanceof AuthenticationError || cause instanceof OAuthInsufficientScope) {
      const insufficient = cause instanceof OAuthInsufficientScope;
      const origin = services.oauthOrigin;
      const challenge = `Bearer ${insufficient ? 'error="insufficient_scope", ' : request.headers.has("authorization") ? 'error="invalid_token", ' : ""}scope="${insufficient ? "read write" : "read"}"${origin ? `, resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"` : ""}`;
      return json(
        rpcError(
          rpcId,
          -32000,
          insufficient ? "Insufficient OAuth scope" : "Authentication required",
        ),
        insufficient ? 403 : 401,
        { "www-authenticate": challenge, "x-request-id": requestId },
      );
    }
    const error = failure(cause);
    return json(
      rpcError(rpcId, error.code === "validation" ? -32600 : -32000, error.message),
      status[error.code],
      { "x-request-id": requestId },
    );
  }
}
