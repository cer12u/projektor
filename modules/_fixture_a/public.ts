/** Test-only storage owner. No product API. */
export interface FixtureSnapshot {
  readonly workspaceId: string;
  readonly id: string;
  readonly version: number;
}
