import { catalogs } from "./generated/catalogs";
import {
  type ModuleStore,
  PlatformError,
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
): ModuleStore<QueryName<O>> {
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
export function createScopedBucket(bucket: R2Bucket, owner: Owner): ScopedBucket {
  const prefix = catalogs[owner]?.r2Prefix;
  return Object.freeze({
    async get(key: string) {
      checkKey(prefix, key);
      const object = await bucket.get(key);
      return object ? object.arrayBuffer() : null;
    },
    async put(key: string, value: ArrayBuffer) {
      checkKey(prefix, key);
      await bucket.put(key, value);
    },
    async delete(key: string) {
      checkKey(prefix, key);
      await bucket.delete(key);
    },
  });
}
