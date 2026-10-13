import { type Clock, PlatformError, type ScopedKV } from "../../../platform/public";
import { deny, textValue, valid } from "./rules";
export interface AccessConfig {
  readonly teamDomain: string;
  readonly audience: string;
}
export interface HumanIdentity {
  readonly issuer: string;
  readonly subject: string;
  readonly expiresAt: number;
}
export type JwksFetcher = (url: string) => Promise<unknown>;
function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) deny();
  return value as Record<string, unknown>;
}
function decode(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) deny();
  return Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
}
function json(value: string): Record<string, unknown> {
  return object(
    JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(decode(value))),
  );
}
async function fetchKeys(url: string): Promise<unknown> {
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(5000) });
  if (!response.ok) deny();
  const body = await response.text();
  if (body.length > 65536) deny();
  return JSON.parse(body);
}
function keys(value: unknown): readonly Record<string, unknown>[] {
  const list = object(value).keys;
  if (!Array.isArray(list) || list.length === 0 || list.length > 20) deny();
  return list.map(object);
}
export function createAssertionVerifier(
  config: AccessConfig,
  kv: ScopedKV,
  clock: Clock,
  load: JwksFetcher = fetchKeys,
) {
  valid(/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(config.teamDomain));
  textValue(config.audience);
  const issuer = config.teamDomain;
  const audience = config.audience;
  // Only keys fetched from the configured HTTPS origin are trusted. KV contents
  // are mutable operational hints, never signing-key provenance.
  let trusted: { expiresAt: number; list: readonly Record<string, unknown>[] } | undefined;
  function cached(): readonly Record<string, unknown>[] | null {
    return trusted && trusted.expiresAt > clock.now() ? trusted.list : null;
  }
  const throttleKey = `access:jwks-refresh:${issuer}`;
  let forcedAfter = 0;
  let inFlight: Promise<readonly Record<string, unknown>[]> | undefined;
  async function refresh(): Promise<readonly Record<string, unknown>[]> {
    // KV is eventually consistent: this is an amplification bound, not a global lock.
    const now = clock.now();
    if (forcedAfter > now) deny();
    forcedAfter = now + 30;
    try {
      const saved = Number(await kv.get(throttleKey));
      if (trusted && Number.isFinite(saved) && saved > now && saved <= now + 30) deny();
      await kv.put(throttleKey, String(forcedAfter));
    } catch (error) {
      // A stored cooldown must still deny; KV outages leave the local bound intact.
      if (error instanceof PlatformError && error.code === "forbidden") throw error;
    }
    const jwks = await load(`${issuer}/cdn-cgi/access/certs`);
    const list = keys(jwks);
    trusted = { expiresAt: clock.now() + 300, list };
    return list;
  }
  function fresh(): Promise<readonly Record<string, unknown>[]> {
    if (!inFlight)
      inFlight = refresh().finally(() => {
        inFlight = undefined;
      });
    return inFlight;
  }
  return async (assertion: string): Promise<HumanIdentity> => {
    try {
      if (typeof assertion !== "string" || assertion.length > 16384) deny();
      const parts = assertion.split(".");
      if (parts.length !== 3) deny();
      const header = json(parts[0]);
      const claims = json(parts[1]);
      if (
        header.alg !== "RS256" ||
        typeof header.kid !== "string" ||
        header.crit !== undefined ||
        header.b64 !== undefined
      )
        deny();
      const aud = claims.aud;
      const now = clock.now();
      if (
        claims.iss !== issuer ||
        !(
          aud === audience ||
          (Array.isArray(aud) && aud.every((x) => typeof x === "string") && aud.includes(audience))
        ) ||
        typeof claims.exp !== "number" ||
        !Number.isSafeInteger(claims.exp) ||
        claims.exp <= now ||
        typeof claims.iat !== "number" ||
        !Number.isSafeInteger(claims.iat) ||
        claims.iat > now ||
        claims.iat >= claims.exp ||
        (claims.nbf !== undefined &&
          (typeof claims.nbf !== "number" ||
            !Number.isSafeInteger(claims.nbf) ||
            claims.nbf > now)) ||
        typeof claims.sub !== "string" ||
        !claims.sub ||
        claims.sub.length > 512 ||
        typeof claims.email !== "string" ||
        !claims.email ||
        claims.type !== "app" ||
        claims.common_name !== undefined ||
        claims.service_token_id !== undefined
      )
        deny();
      let list = cached();
      if (!list) list = await fresh();
      else if (!list.some((k) => k.kid === header.kid)) list = await fresh();
      const matching = list.filter(
        (k) => k.kid === header.kid && k.kty === "RSA" && k.alg === "RS256" && k.use === "sig",
      );
      if (matching.length !== 1) deny();
      const jwk = matching[0];
      if (typeof jwk.n !== "string" || typeof jwk.e !== "string" || decode(jwk.n).length < 256)
        deny();
      const publicKey = await crypto.subtle.importKey(
        "jwk",
        { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["verify"],
      );
      if (
        !(await crypto.subtle.verify(
          "RSASSA-PKCS1-v1_5",
          publicKey,
          decode(parts[2]),
          new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
        ))
      )
        deny();
      return { issuer, subject: claims.sub, expiresAt: claims.exp };
    } catch {
      return deny();
    }
  };
}
