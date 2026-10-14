import {
  type AccessApi,
  type OAuthAuthorizationRequest,
  OAuthError,
} from "../modules/access/public";
import { type Clock, PlatformError, type RateLimiter } from "../platform/public";
import { consentPage } from "./consent";

export interface OAuthTransport {
  readonly issuer: string;
  readonly resource: string;
  readonly formSecret: string;
  readonly clock: Clock;
  readonly registerLimit: RateLimiter;
  readonly tokenLimit: RateLimiter;
}
const authFields = [
  "client_id",
  "redirect_uri",
  "response_type",
  "code_challenge",
  "code_challenge_method",
  "resource",
  "scope",
  "state",
];
const cookieName = "__Host-projektor-consent";
const enc = new TextEncoder();
const hex = (bytes: ArrayBuffer) =>
  [...new Uint8Array(bytes)].map((x) => x.toString(16).padStart(2, "0")).join("");
const random = () => hex(crypto.getRandomValues(new Uint8Array(32)).buffer);
const digest = async (s: string) => hex(await crypto.subtle.digest("SHA-256", enc.encode(s)));
function check(ok: unknown): asserts ok {
  if (!ok) throw new OAuthError("invalid_request");
}
function object(value: unknown): Record<string, unknown> {
  check(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}
function fields(params: URLSearchParams, allowed: readonly string[]): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [key, value] of params) {
    check(allowed.includes(key) && !Object.hasOwn(output, key));
    output[key] = value;
  }
  return output;
}
function authorization(value: unknown): OAuthAuthorizationRequest {
  const x = object(value);
  check(Object.keys(x).every((k) => authFields.includes(k)));
  for (const key of authFields.slice(0, 6)) check(typeof x[key] === "string");
  for (const key of ["scope", "state"]) check(x[key] === undefined || typeof x[key] === "string");
  return {
    client_id: x.client_id as string,
    redirect_uri: x.redirect_uri as string,
    response_type: x.response_type as string,
    code_challenge: x.code_challenge as string,
    code_challenge_method: x.code_challenge_method as string,
    resource: x.resource as string,
    scope: x.scope as string | undefined,
    state: x.state as string | undefined,
  };
}
async function read(request: Request, type: string): Promise<string> {
  check(request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() === type);
  check(Number(request.headers.get("content-length") ?? 0) <= 32768);
  const reader = request.body?.getReader();
  check(reader);
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  let text = "",
    size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 32768) {
        await reader.cancel();
        throw new OAuthError("invalid_request");
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } catch {
    throw new OAuthError("invalid_request");
  }
}
function response(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(value === undefined ? null : JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      pragma: "no-cache",
      "referrer-policy": "no-referrer",
      ...headers,
    },
  });
}
function redirect(
  target: { redirect_uri: string; state?: string; iss: string },
  result: { code?: string; error?: string },
): Response {
  const url = new URL(target.redirect_uri);
  for (const key of ["code", "error", "state", "iss"]) url.searchParams.delete(key);
  for (const [key, value] of Object.entries({ ...result, state: target.state, iss: target.iss }))
    if (value !== undefined) url.searchParams.set(key, value);
  return response(undefined, 303, {
    location: url.href,
    "set-cookie": `${cookieName}=; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`,
  });
}

/** OAuth HTTP only; Access owns durable state and Platform owns rate admission. */
export function createOAuthHttp(
  config: OAuthTransport,
  access: AccessApi,
): (request: Request) => Promise<Response> {
  const issuer = new URL(config.issuer);
  if (
    issuer.protocol !== "https:" ||
    issuer.origin !== config.issuer ||
    config.resource !== `${config.issuer}/mcp` ||
    config.formSecret.length < 32
  )
    throw new Error("Invalid OAuth transport configuration");
  const key = crypto.subtle.importKey(
    "raw",
    enc.encode(config.formSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
  async function seal(value: unknown): Promise<string> {
    const payload = btoa(
      Array.from(enc.encode(JSON.stringify(value)), (x) => String.fromCharCode(x)).join(""),
    );
    const signature = hex(await crypto.subtle.sign("HMAC", await key, enc.encode(payload)));
    return `${payload}.${signature}`;
  }
  async function unseal(token: string): Promise<Record<string, unknown>> {
    const [payload, signature, extra] = token.split(".");
    check(!extra && /^[0-9a-f]{64}$/.test(signature ?? ""));
    const bytes = Uint8Array.from(signature.match(/../g) ?? [], (x) => Number.parseInt(x, 16));
    check(await crypto.subtle.verify("HMAC", await key, bytes, enc.encode(payload)));
    try {
      return object(
        JSON.parse(
          new TextDecoder().decode(Uint8Array.from(atob(payload), (x) => x.charCodeAt(0))),
        ),
      );
    } catch {
      throw new OAuthError("invalid_request");
    }
  }
  return async (request) => {
    const url = new URL(request.url);
    const interactive = url.pathname === "/oauth/authorize";
    const cors: Record<string, string> = interactive ? {} : { "access-control-allow-origin": "*" };
    try {
      check(url.origin === config.issuer);
      if (!interactive && request.method === "OPTIONS")
        return response(undefined, 204, {
          ...cors,
          "access-control-allow-methods": "GET, POST, OPTIONS",
          "access-control-allow-headers": "content-type",
          "access-control-max-age": "600",
        });
      if (url.pathname.startsWith("/.well-known/")) {
        check(request.method === "GET" && !url.search);
        if (url.pathname === "/.well-known/oauth-authorization-server")
          return response(access.getAuthorizationServerMetadata(), 200, cors);
        check(
          /^\/\.well-known\/oauth-protected-resource(?:\/mcp(?:\/[^/]+)?)?$/.test(url.pathname),
        );
        return response(access.getProtectedResourceMetadata(), 200, cors);
      }
      if (interactive) {
        check(request.method === "GET" || request.method === "POST");
        if (request.method === "POST")
          check(request.headers.get("origin") === config.issuer && !url.search);
        check(!request.headers.has("authorization"));
        const assertion = request.headers.get("cf-access-jwt-assertion");
        check(assertion);
        const principal = await access.authenticate({ kind: "human", assertion });
        if (request.method === "GET") {
          check(url.search.length <= 32768);
          const { workspace, ...input } = fields(url.searchParams, [...authFields, "workspace"]);
          const original = authorization(input);
          const workspaces = await access.listWorkspaces(principal);
          check(workspaces.length);
          const selected = workspace ?? workspaces[0].id;
          const scope = await access.requireMembership(principal, selected, crypto.randomUUID());
          const consent = await access.getOAuthConsent(principal, original, scope);
          const csrf = random();
          const token = await seal({
            request: original,
            grantedScope: consent.scope,
            workspace: selected,
            principal: scope.principalId,
            csrf: await digest(csrf),
            expires: config.clock.now() + 600,
            operationId: crypto.randomUUID(),
            codeSecret: random(),
          });
          await access.issueOAuthForm(scope, await digest(token));
          const html = consentPage(consent, workspaces, selected, input, token);
          return new Response(html, {
            headers: {
              "content-type": "text/html; charset=utf-8",
              "cache-control": "no-store",
              pragma: "no-cache",
              "referrer-policy": "origin",
              "x-frame-options": "DENY",
              "content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${new URL(consent.redirectUri).origin}; frame-ancestors 'none'; base-uri 'none'`,
              "set-cookie": `${cookieName}=${csrf}; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=600`,
            },
          });
        }
        const form = fields(
          new URLSearchParams(await read(request, "application/x-www-form-urlencoded")),
          ["form_token", "decision"],
        );
        check(form.form_token && ["approve", "deny"].includes(form.decision));
        const state = await unseal(form.form_token);
        const cookies = (request.headers.get("cookie") ?? "")
          .split(";")
          .map((x) => x.trim())
          .filter((x) => x.startsWith(`${cookieName}=`));
        check(
          cookies.length === 1 &&
            state.csrf === (await digest(cookies[0].slice(cookieName.length + 1))),
        );
        check(typeof state.expires === "number" && state.expires > config.clock.now());
        check(
          typeof state.workspace === "string" &&
            typeof state.operationId === "string" &&
            typeof state.codeSecret === "string",
        );
        const scope = await access.requireMembership(
          principal,
          state.workspace,
          crypto.randomUUID(),
        );
        check(scope.principalId === state.principal);
        const original = authorization(state.request);
        await access.consumeOAuthForm(scope, await digest(form.form_token));
        // Handles never cross HTTP requests: validation and approval share this request.
        const consent = await access.getOAuthConsent(principal, original, scope);
        const target = {
          redirect_uri: consent.redirectUri,
          state: original.state,
          iss: config.issuer,
        };
        if (form.decision === "deny" || consent.scope !== state.grantedScope)
          return redirect(target, { error: "access_denied" });
        try {
          const result = await access.approveOAuthConsent(scope, consent, {
            operationId: state.operationId,
            codeSecret: state.codeSecret,
          });
          return redirect(result, { code: result.code });
        } catch (error) {
          return redirect(target, {
            error:
              error instanceof OAuthError
                ? error.code
                : error instanceof PlatformError && ["forbidden", "conflict"].includes(error.code)
                  ? "access_denied"
                  : "temporarily_unavailable",
          });
        }
      }
      check(request.method === "POST" && !url.search && !request.headers.has("authorization"));
      const limiter =
        url.pathname === "/oauth/register"
          ? config.registerLimit
          : url.pathname === "/oauth/token"
            ? config.tokenLimit
            : undefined;
      if (limiter) {
        const source = request.headers.get("cf-connecting-ip") ?? "unknown";
        check(source.length <= 128 && source.length > 0);
        if (!(await limiter.allow(source)))
          return response({ error: "temporarily_unavailable" }, 429, {
            ...cors,
            "retry-after": "60",
          });
      }
      if (url.pathname === "/oauth/register") {
        let input: unknown;
        try {
          input = JSON.parse(await read(request, "application/json"));
        } catch {
          throw new OAuthError("invalid_request");
        }
        const x = object(input);
        // Access owns client metadata validation; transport limits decoding and size.
        for (const k of ["client_name", "token_endpoint_auth_method", "scope"])
          check(x[k] === undefined || typeof x[k] === "string");
        for (const k of ["redirect_uris", "grant_types", "response_types"])
          check(
            (k !== "redirect_uris" && x[k] === undefined) ||
              (Array.isArray(x[k]) && x[k].every((v) => typeof v === "string")),
          );
        return response(
          await access.registerOAuthClient({
            client_name: x.client_name as string | undefined,
            token_endpoint_auth_method: x.token_endpoint_auth_method as string | undefined,
            scope: x.scope as string | undefined,
            redirect_uris: x.redirect_uris as string[],
            grant_types: x.grant_types as string[] | undefined,
            response_types: x.response_types as string[] | undefined,
          }),
          201,
          cors,
        );
      }
      const x = fields(
        new URLSearchParams(await read(request, "application/x-www-form-urlencoded")),
        url.pathname === "/oauth/revoke"
          ? ["client_id", "token", "token_type_hint"]
          : [
              "grant_type",
              "client_id",
              "resource",
              "code",
              "redirect_uri",
              "code_verifier",
              "refresh_token",
              "scope",
            ],
      );
      if (url.pathname === "/oauth/revoke") {
        await access.revokeOAuthToken({
          client_id: x.client_id,
          token: x.token,
          token_type_hint: x.token_type_hint,
        });
        return response(undefined, 200, cors);
      }
      check(url.pathname === "/oauth/token");
      if (x.grant_type === "authorization_code") {
        check(x.refresh_token === undefined && x.scope === undefined);
        return response(
          await access.exchangeOAuthToken({
            grant_type: "authorization_code",
            client_id: x.client_id,
            resource: x.resource,
            code: x.code,
            redirect_uri: x.redirect_uri,
            code_verifier: x.code_verifier,
          }),
          200,
          cors,
        );
      }
      if (x.grant_type === "refresh_token") {
        check(
          x.code === undefined && x.redirect_uri === undefined && x.code_verifier === undefined,
        );
        return response(
          await access.exchangeOAuthToken({
            grant_type: "refresh_token",
            client_id: x.client_id,
            resource: x.resource,
            refresh_token: x.refresh_token,
            scope: x.scope,
          }),
          200,
          cors,
        );
      }
      throw new OAuthError("unsupported_grant_type");
    } catch (error) {
      if (interactive && error instanceof OAuthError && error.authorizationRedirect)
        return redirect(error.authorizationRedirect, { error: error.code });
      const code =
        error instanceof OAuthError
          ? error.code
          : error instanceof PlatformError && error.code === "forbidden"
            ? "access_denied"
            : "temporarily_unavailable";
      return response({ error: code }, code === "temporarily_unavailable" ? 503 : 400, {
        ...cors,
        ...(code === "temporarily_unavailable" ? { "retry-after": "5" } : {}),
        ...(interactive ? { "referrer-policy": "no-referrer", "x-frame-options": "DENY" } : {}),
      });
    }
  };
}
