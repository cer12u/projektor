import { PlatformError } from "../../../platform/public";
import type { Permission, Role } from "../public";
export function deny(): never {
  throw new PlatformError("forbidden", "Access denied");
}
export function valid(condition: boolean): asserts condition {
  if (!condition) throw new PlatformError("validation", "Invalid Access input");
}
export function inputObject(value: unknown): void {
  valid(typeof value === "object" && value !== null && !Array.isArray(value));
}
export function identifier(value: string): string {
  valid(typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value));
  return value;
}
export function textValue(value: string): string {
  valid(typeof value === "string" && value.trim().length > 0 && value.length <= 512);
  return value;
}
export function version(value: number): number {
  valid(Number.isSafeInteger(value) && value >= 0 && value < Number.MAX_SAFE_INTEGER);
  return value;
}
export function role(value: unknown): Role {
  valid(value === "owner" || value === "admin" || value === "member" || value === "viewer");
  return value;
}
export function permission(value: unknown): Permission {
  valid(value === "read" || value === "write");
  return value;
}
export function manage(actor: Role, current: Role | undefined, next: Role | undefined): void {
  if (
    actor !== "owner" &&
    (actor !== "admin" ||
      current === "owner" ||
      current === "admin" ||
      next === "owner" ||
      next === "admin")
  )
    deny();
}
export async function hash(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
export function humanId(issuer: string, subject: string): Promise<string> {
  return hash(JSON.stringify(["human", issuer, subject]));
}
