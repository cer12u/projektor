/** Portable primitives. No binding or prepared statement escapes the adapters. */
export interface Clock {
  now(): number;
}
export interface IdGenerator {
  next(): string;
}
export type Value = string | number | null | ArrayBuffer;
export type Row = Readonly<Record<string, unknown>>;
export interface QueryResult {
  readonly rows: readonly Row[];
  readonly changes: number;
}
export interface Call<Name extends string> {
  readonly name: Name;
  readonly values: readonly Value[];
}
export interface ModuleStore<Owner extends string, Name extends string> {
  readonly owner: Owner;
  run(name: Name, values: readonly Value[]): Promise<QueryResult>;
  batch(calls: readonly Call<Name>[]): Promise<readonly QueryResult[]>;
}
export interface ScopedKV {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}
export interface ByteReader {
  read(): Promise<ArrayBuffer | null>;
  cancel(): Promise<void>;
}
export interface ScopedBucket {
  list(
    prefix: string,
    cursor?: string,
    limit?: number,
  ): Promise<{ keys: readonly string[]; cursor?: string }>;
  open(key: string): Promise<ByteReader | null>;
  get(key: string): Promise<ArrayBuffer | null>;
  put(key: string, value: ArrayBuffer): Promise<void>;
  delete(key: string): Promise<void>;
}
export type ErrorCode =
  | "validation"
  | "not_found"
  | "forbidden"
  | "conflict"
  | "unavailable"
  | "unknown";
export class PlatformError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PlatformError";
  }
}

export interface RateLimiter {
  allow(key: string): Promise<boolean>;
}

/** Narrow cryptographic port; Worker secret never crosses the adapter. */
export interface SecretVault {
  inboundSecret(label: string): Promise<string>;
  seal(value: string): Promise<string>;
  open(ciphertext: string): Promise<string>;
}
