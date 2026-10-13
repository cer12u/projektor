import type { OAuthClientInput, OAuthErrorCode } from "../public";
import { OAuthError } from "../public";

export function oauthCheck(
  condition: boolean,
  code: OAuthErrorCode = "invalid_request",
): asserts condition {
  if (!condition) throw new OAuthError(code);
}
export function oauthObject(value: unknown): void {
  oauthCheck(typeof value === "object" && value !== null && !Array.isArray(value));
}
export function bounded(value: unknown, max = 2048): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}
export function redirectUri(value: string): URL {
  oauthCheck(bounded(value) && !/[\s\\*#]/.test(value), "invalid_redirect_uri");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new OAuthError("invalid_redirect_uri");
  }
  oauthCheck(
    !url.username &&
      !url.password &&
      (url.protocol === "https:" ||
        (url.protocol === "http:" &&
          (url.hostname === "127.0.0.1" || url.hostname === "[::1]") &&
          /^http:\/\/(?:127\.0\.0\.1|\[::1\])(?::[0-9]+)?(?:[/?]|$)/.test(value))),
    "invalid_redirect_uri",
  );
  return url;
}
export function redirectMatches(registered: string, requested: string): boolean {
  const a = redirectUri(registered);
  redirectUri(requested);
  if (a.protocol !== "http:") return registered === requested;
  // RFC 8252: only the port may vary for IP-literal loopback callbacks.
  // Compare the original strings after removing only an explicit loopback port.
  const withoutPort = (uri: string) =>
    uri.replace(/^(http:\/\/(?:127\.0\.0\.1|\[::1\])):\d+(?=[/?]|$)/, "$1");
  return withoutPort(registered) === withoutPort(requested);
}
export function scopes(value: unknown = "read"): string {
  oauthCheck(bounded(value, 64), "invalid_scope");
  const parts = value.split(" ");
  oauthCheck(
    parts.every((s) => s === "read" || s === "write"),
    "invalid_scope",
  );
  return parts.includes("write") ? "read write" : "read";
}
export function registration(input: OAuthClientInput) {
  oauthObject(input);
  oauthCheck(
    Array.isArray(input.redirect_uris) &&
      input.redirect_uris.length > 0 &&
      input.redirect_uris.length <= 10,
    "invalid_client_metadata",
  );
  const redirects = [...new Set(input.redirect_uris)];
  for (const uri of redirects) redirectUri(uri);
  oauthCheck(
    input.client_name === undefined || bounded(input.client_name, 128),
    "invalid_client_metadata",
  );
  oauthCheck(
    input.token_endpoint_auth_method === undefined || input.token_endpoint_auth_method === "none",
    "invalid_client_metadata",
  );
  const grants = input.grant_types ?? ["authorization_code"];
  oauthCheck(
    Array.isArray(grants) &&
      grants.length > 0 &&
      grants.length <= 2 &&
      grants.includes("authorization_code") &&
      grants.every((g) => g === "authorization_code" || g === "refresh_token"),
    "invalid_client_metadata",
  );
  oauthCheck(
    input.response_types === undefined ||
      (Array.isArray(input.response_types) &&
        input.response_types.length === 1 &&
        input.response_types[0] === "code"),
    "invalid_client_metadata",
  );
  return {
    redirect_uris: redirects,
    client_name: input.client_name ?? "MCP client",
    grant_types: [...new Set(grants)],
    scope: scopes(input.scope ?? "read write"),
  };
}
export function randomSecret(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (n) =>
    n.toString(16).padStart(2, "0"),
  ).join("");
}
export function secret(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}
export function parseToken(
  value: unknown,
  prefix: string,
): { workspace: string; raw: string } | null {
  if (!bounded(value, 300)) return null;
  const parts = value.split(".");
  return parts.length === 3 &&
    parts[0] === prefix &&
    /^[a-zA-Z0-9_-]{1,128}$/.test(parts[1]) &&
    secret(parts[2])
    ? { workspace: parts[1], raw: value }
    : null;
}
export async function challenge(verifier: string): Promise<string> {
  oauthCheck(
    typeof verifier === "string" && /^[A-Za-z0-9._~-]{43,128}$/.test(verifier),
    "invalid_grant",
  );
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
  );
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
