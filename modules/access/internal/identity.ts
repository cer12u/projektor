import type { Row } from "../../../platform/public";
import type { Permission, PrincipalSummary } from "../public";
export interface Identity extends PrincipalSummary {
  readonly email?: string;
  readonly displayName?: string;
  readonly expiresAt: number;
  readonly workspaceId?: string;
  readonly credentialId?: string;
  readonly tokenHash?: string;
  readonly clientId?: string;
  readonly oauthScope?: Permission;
}
export function str(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new Error("Invalid Access row");
  return value;
}
export function num(row: Row, key: string): number {
  const value = row[key];
  if (typeof value !== "number") throw new Error("Invalid Access row");
  return value;
}
