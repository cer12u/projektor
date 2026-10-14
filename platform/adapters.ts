import { catalogs } from "./generated/catalogs";
import {
  type ModuleStore,
  PlatformError,
  type RateLimiter,
  type ScopedBucket,
  type ScopedKV,
  type Value,
} from "./public";

type Owner = Exclude<keyof typeof catalogs, "platform">;
type QueryName<O extends Owner> = keyof (typeof catalogs)[O]["queries"] & string;

/** Composition only. The owner and SQL cannot be supplied by a module caller. */
export function createModuleStore<O extends Owner>(
  db: D1Database,
  owner: O,
): ModuleStore<O, QueryName<O>> {
  const catalog = catalogs[owner];
  if (!Object.hasOwn(catalogs, owner) || owner === ("platform" as string))
    throw new PlatformError("forbidden", "Unknown runtime owner");
  const queries: Readonly<Record<string, string>> = catalog.queries;
  const prepare = (name: string, values: readonly Value[]) => {
    if (!Object.hasOwn(queries, name))
      throw new PlatformError("forbidden", `Unknown query for ${owner}: ${name}`);
    if (values.length > 100) throw new PlatformError("validation", "D1 query exceeds 100 binds");
    return db.prepare(queries[name]).bind(...values);
  };
  return Object.freeze({
    owner,
    async run(name: QueryName<O>, values: readonly Value[]) {
      const result = await prepare(name, values).all();
      return { rows: result.results, changes: result.meta.changes };
    },
    async batch(calls: readonly { name: QueryName<O>; values: readonly Value[] }[]) {
      if (calls.length === 0) return [];
      // Prepare the entire batch before submitting anything. Never chunk an atomic command.
      const results = await db.batch<Record<string, unknown>>(
        calls.map((call) => prepare(call.name, call.values)),
      );
      return results.map((result) => ({ rows: result.results, changes: result.meta.changes }));
    },
  });
}

function checkKey(prefix: string | null, key: string): void {
  if (!prefix || !key.startsWith(prefix) || key.length === prefix.length) {
    throw new PlatformError("forbidden", "Key outside owner prefix");
  }
}

/** Accept complete keys and reject foreign prefixes; never concatenate a caller's owner. */
export function createScopedKV(kv: KVNamespace, owner: Owner): ScopedKV {
  const prefix = catalogs[owner]?.kvPrefix;
  return Object.freeze({
    async get(key: string) {
      checkKey(prefix, key);
      return kv.get(key);
    },
    async put(key: string, value: string) {
      checkKey(prefix, key);
      await kv.put(key, value);
    },
    async delete(key: string) {
      checkKey(prefix, key);
      await kv.delete(key);
    },
  });
}
export function createScopedBucket(
  bucket: R2Bucket,
  owner: Owner,
  workspaceId?: string,
): ScopedBucket {
  if (workspaceId !== undefined && !/^[A-Za-z0-9_-]{1,128}$/.test(workspaceId))
    throw new PlatformError("validation", "Invalid bucket workspace");
  const ownerPrefix = catalogs[owner]?.r2Prefix;
  const prefix = workspaceId === undefined ? ownerPrefix : `${ownerPrefix}${workspaceId}/`;
  const check = (key: string) => {
    checkKey(prefix, key);
    if (workspaceId !== undefined && !/^[A-Za-z0-9_-]{1,128}$/.test(key.slice(prefix?.length ?? 0)))
      throw new PlatformError("forbidden", "Invalid workspace object key");
  };
  return Object.freeze({
    async get(key: string) {
      check(key);
      const object = await bucket.get(key);
      return object ? object.arrayBuffer() : null;
    },
    async open(key: string) {
      check(key);
      const object = await bucket.get(key);
      if (!object) return null;
      const reader = object.body.getReader();
      return Object.freeze({
        async read() {
          const next = await reader.read();
          return next.done
            ? null
            : next.value.buffer.slice(
                next.value.byteOffset,
                next.value.byteOffset + next.value.byteLength,
              );
        },
        async cancel() {
          await reader.cancel();
        },
      });
    },
    async put(key: string, value: ArrayBuffer) {
      check(key);
      await bucket.put(key, value);
    },
    async delete(key: string) {
      check(key);
      await bucket.delete(key);
    },
  });
}

/** Composition only: portable rate admission; binding configuration fixes the quota. */
export function createRateLimiter(binding: RateLimit): RateLimiter {
  return Object.freeze({
    async allow(key: string): Promise<boolean> {
      if (!key || key.length > 128) throw new PlatformError("validation", "Invalid limiter key");
      return (await binding.limit({ key })).success;
    },
  });
}

/** Worker-only adapter for Integrations secrets. The key is never exposed by this port. */
export function createSecretVault(key: string): import("./public").SecretVault {
  if (!/^[0-9a-f]{64}$/.test(key)) throw new PlatformError("validation", "Invalid integration key");
  const bytes = Uint8Array.from(key.match(/../g) ?? [], (x) => Number.parseInt(x, 16));
  const encoder = new TextEncoder();
  const b64 = (v: Uint8Array) => btoa(String.fromCharCode(...v));
  const un64 = (v: string) => Uint8Array.from(atob(v), (x) => x.charCodeAt(0));
  const hmac = crypto.subtle.importKey("raw", bytes, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const aes = crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
  return Object.freeze({
    async inboundSecret(label: string): Promise<string> {
      const signature = await crypto.subtle.sign(
        "HMAC",
        await hmac,
        encoder.encode(`inbound:${label}`),
      );
      return Array.from(new Uint8Array(signature), (b) => b.toString(16).padStart(2, "0")).join("");
    },
    async seal(value: string): Promise<string> {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const cipher = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        await aes,
        encoder.encode(value),
      );
      return `${b64(iv)}.${b64(new Uint8Array(cipher))}`;
    },
    async open(ciphertext: string): Promise<string> {
      const [iv, value] = ciphertext.split(".");
      if (!iv || !value) throw new PlatformError("unknown", "Invalid encrypted secret");
      return new TextDecoder().decode(
        await crypto.subtle.decrypt({ name: "AES-GCM", iv: un64(iv) }, await aes, un64(value)),
      );
    },
  });
}
