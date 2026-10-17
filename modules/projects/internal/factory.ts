import {
  type Call,
  type Clock,
  type IdGenerator,
  type ModuleStore,
  PlatformError,
  type Row,
} from "../../../platform/public";
import type { AccessApi, RequestScope } from "../../access/public";
import type {
  Project,
  ProjectEvent,
  ProjectEventReader,
  ProjectEventType,
  ProjectPermission,
  ProjectResult,
  ProjectRole,
  ProjectsApi,
  ProjectsMaintenance,
} from "../public";
import type { queries } from "../storage/queries";
import { createMaintenance } from "./maintenance";

type Name = keyof typeof queries;
type Statement = Call<Name>;
interface Dependencies {
  readonly store: ModuleStore<"projects", Name>;
  readonly access: Pick<AccessApi, "authorize" | "getPrincipalSummary" | "getMembership">;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly eventConsumer?: string;
}
function invalid(): never {
  throw new PlatformError("validation", "Invalid Projects input");
}
function missing(): never {
  throw new PlatformError("not_found", "Project not found");
}
function forbidden(): never {
  throw new PlatformError("forbidden", "Project access denied");
}
function inputObject(value: unknown): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid();
}
function id(value: unknown): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) invalid();
  return value;
}
function key(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z][A-Za-z0-9]{1,15}$/.test(value)) invalid();
  return value.toUpperCase();
}
function name(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 512) invalid();
  return value.trim();
}
function description(value: unknown): string {
  if (typeof value !== "string" || value.length > 10000) invalid();
  return value;
}
function slug(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9-]{0,127}$/.test(value)) invalid();
  return value;
}
function version(value: unknown): number {
  if (
    !Number.isSafeInteger(value) ||
    typeof value !== "number" ||
    value < 1 ||
    value >= Number.MAX_SAFE_INTEGER
  )
    invalid();
  return value;
}
function role(value: unknown): ProjectRole {
  if (value !== "manager" && value !== "editor" && value !== "viewer") invalid();
  return value;
}
function str(row: Row, field: string): string {
  const value = row[field];
  if (typeof value !== "string") throw new PlatformError("unknown", `Invalid ${field}`);
  return value;
}
function num(row: Row, field: string): number {
  const value = row[field];
  if (typeof value !== "number") throw new PlatformError("unknown", `Invalid ${field}`);
  return value;
}
async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
export function createProjects(deps: Dependencies): {
  api: ProjectsApi;
  maintenance: ProjectsMaintenance;
  eventReader?: ProjectEventReader;
} {
  const { store, access, clock, ids } = deps;
  if (store.owner !== "projects") forbidden();
  const eventReader = deps.eventConsumer ? (Object.freeze({}) as ProjectEventReader) : undefined;
  const one = async (query: Name, values: Statement["values"]): Promise<Row | undefined> =>
    (await store.run(query, values)).rows[0];
  const workspace = (scope: RequestScope) => id(scope.workspaceId);
  const actor = (scope: RequestScope) => id(scope.principalId);
  const privileged = (scope: RequestScope) => scope.role === "owner" || scope.role === "admin";
  const projectRole = async (
    scope: RequestScope,
    projectId: string,
    allowArchived = false,
  ): Promise<Project> => {
    const w = workspace(scope);
    const p = await one("project", [w, projectId]);
    if (!p || (!allowArchived && p.archived !== 0)) missing();
    let projectRole: ProjectRole;
    if (privileged(scope)) projectRole = "manager";
    else {
      const grant = await one("grant", [w, projectId, actor(scope)]);
      if (!grant || grant.active !== 1) missing();
      projectRole = role(grant.role);
    }
    return {
      id: str(p, "id"),
      key: str(p, "project_key"),
      name: str(p, "name"),
      description: str(p, "description"),
      slug: str(p, "slug"),
      createdAt: num(p, "created_at"),
      updatedAt: num(p, "updated_at"),
      version: num(p, "version"),
      archived: p.archived === 1,
      role: projectRole,
    };
  };
  async function authorizeProject(
    scope: RequestScope,
    projectId: string,
    permission: ProjectPermission = "read",
    allowArchived = false,
  ): Promise<Project> {
    id(projectId);
    if (permission !== "read" && permission !== "write" && permission !== "manage") invalid();
    const live = await access.authorize(scope, "read");
    const project = await projectRole(live, projectId, allowArchived);
    if (permission !== "read") {
      if (permission === "manage" ? project.role !== "manager" : project.role === "viewer")
        forbidden();
      await access.authorize(scope, "write");
    }
    return project;
  }
  async function replay(
    scope: RequestScope,
    operationId: string,
    fingerprint: string,
  ): Promise<ProjectResult | undefined> {
    const saved = await one("readReceipt", [workspace(scope), actor(scope), operationId]);
    if (!saved) return undefined;
    // A revoked grant may not recover an old result.
    await projectRole(scope, str(saved, "result_id"), true);
    if (saved.fingerprint !== fingerprint)
      throw new PlatformError("conflict", "Operation ID reused with different input");
    return { id: str(saved, "result_id"), version: num(saved, "result_version") };
  }
  async function commit(
    scope: RequestScope,
    operationId: string,
    fingerprint: string,
    output: ProjectResult,
    type: ProjectEventType,
    calls: readonly Statement[],
  ): Promise<ProjectResult> {
    const w = workspace(scope);
    try {
      await store.batch([
        ...calls,
        {
          name: "receipt",
          values: [w, actor(scope), operationId, fingerprint, output.id, output.version, output.id],
        },
        {
          name: "event",
          values: [
            w,
            w,
            ids.next(),
            output.id,
            output.version,
            type,
            clock.now(),
            actor(scope),
            scope.clientId ?? null,
            output.id,
          ],
        },
      ]);
      return output;
    } catch (error) {
      try {
        const saved = await replay(scope, operationId, fingerprint);
        if (saved) return saved;
      } catch (recovery) {
        if (recovery instanceof PlatformError) throw recovery;
        throw new PlatformError(
          "unknown",
          "Operation outcome unknown; retry the same operation ID",
        );
      }
      if (error instanceof Error && /scope frozen/i.test(error.message))
        throw new PlatformError("conflict", "Scope frozen");
      if (
        error instanceof Error &&
        /(?:CHECK|UNIQUE|FOREIGN KEY) constraint failed/i.test(error.message)
      )
        throw new PlatformError("conflict", "Version or invariant conflict");
      throw new PlatformError("unknown", "Operation outcome unknown; retry the same operation ID");
    }
  }
  async function fingerprint(
    kind: string,
    operationId: unknown,
    values: readonly unknown[],
  ): Promise<string> {
    id(operationId);
    return digest(JSON.stringify([kind, ...values]));
  }
  function guarded(scope: RequestScope, change: Statement): readonly Statement[] {
    const guardId = ids.next();
    return [
      change,
      { name: "guard", values: [workspace(scope), guardId] },
      { name: "clearGuard", values: [workspace(scope), guardId] },
    ];
  }
  const api: ProjectsApi = {
    async createProject(scope, input) {
      const s = await access.authorize(scope, "write");
      if (!privileged(s)) forbidden();
      inputObject(input);
      const projectId = id(input.projectId);
      const projectKey = key(input.key);
      const projectName = name(input.name);
      const projectDescription = description(input.description ?? "");
      const projectSlug = slug(input.slug ?? projectKey.toLowerCase());
      const fp = await fingerprint("createProject", input.operationId, [
        projectId,
        projectKey,
        projectName,
        projectDescription,
        projectSlug,
      ]);
      const saved = await replay(s, input.operationId, fp);
      if (saved) return saved;
      return commit(
        s,
        input.operationId,
        fp,
        { id: projectId, version: 1 },
        "ProjectChanged",
        guarded(s, {
          name: "create",
          values: [
            workspace(s),
            projectId,
            projectKey,
            projectName,
            projectDescription,
            projectSlug,
            clock.now(),
            clock.now(),
          ],
        }),
      );
    },
    async renameProject(scope, input) {
      inputObject(input);
      const projectId = id(input.projectId);
      const expected = version(input.expectedVersion);
      const projectName = name(input.name);
      const projectKey = input.key === undefined ? undefined : key(input.key);
      const current = await authorizeProject(scope, projectId, "manage");
      const fp = await fingerprint("renameProject", input.operationId, [
        projectId,
        expected,
        projectKey ?? null,
        projectName,
      ]);
      const saved = await replay(scope, input.operationId, fp);
      if (saved) return saved;
      return commit(
        scope,
        input.operationId,
        fp,
        { id: projectId, version: expected + 1 },
        "ProjectChanged",
        guarded(scope, {
          name: "rename",
          values: [
            projectKey ?? current.key,
            projectName,
            clock.now(),
            workspace(scope),
            projectId,
            expected,
          ],
        }),
      );
    },
    async updateProject(scope, input) {
      inputObject(input);
      const projectId = id(input.projectId);
      const expected = version(input.expectedVersion);
      const current = await authorizeProject(scope, projectId, "manage");
      const nextName = input.name === undefined ? current.name : name(input.name);
      const nextKey = input.key === undefined ? current.key : key(input.key);
      const nextDescription =
        input.description === undefined ? current.description : description(input.description);
      const nextSlug = input.slug === undefined ? current.slug : slug(input.slug);
      if (
        input.name === undefined &&
        input.key === undefined &&
        input.description === undefined &&
        input.slug === undefined
      )
        invalid();
      const fp = await fingerprint("updateProject", input.operationId, [
        projectId,
        expected,
        input.name ?? null,
        input.key ?? null,
        input.description ?? null,
        input.slug ?? null,
      ]);
      const saved = await replay(scope, input.operationId, fp);
      if (saved) return saved;
      return commit(
        scope,
        input.operationId,
        fp,
        { id: projectId, version: expected + 1 },
        "ProjectChanged",
        guarded(scope, {
          name: "updateProject",
          values: [
            nextKey,
            nextName,
            nextDescription,
            nextSlug,
            clock.now(),
            workspace(scope),
            projectId,
            expected,
          ],
        }),
      );
    },
    async grantProjectRole(scope, input) {
      inputObject(input);
      const projectId = id(input.projectId);
      const expected = version(input.expectedVersion);
      const principalId = id(input.principalId);
      const projectRole = role(input.role);
      await authorizeProject(scope, projectId, "manage");
      const fp = await fingerprint("grantProjectRole", input.operationId, [
        projectId,
        expected,
        principalId,
        projectRole,
      ]);
      const saved = await replay(scope, input.operationId, fp);
      if (saved) return saved;
      await access.getPrincipalSummary(scope, principalId);
      const w = workspace(scope);
      return commit(
        scope,
        input.operationId,
        fp,
        { id: projectId, version: expected + 1 },
        "ProjectGrantChanged",
        [
          ...guarded(scope, { name: "bump", values: [w, projectId, expected] }),
          ...guarded(scope, {
            name: "grantRole",
            values: [w, projectId, principalId, projectRole],
          }),
        ],
      );
    },
    async revokeProjectRole(scope, input) {
      inputObject(input);
      const projectId = id(input.projectId);
      const expected = version(input.expectedVersion);
      const principalId = id(input.principalId);
      await authorizeProject(scope, projectId, "manage");
      const fp = await fingerprint("revokeProjectRole", input.operationId, [
        projectId,
        expected,
        principalId,
      ]);
      const saved = await replay(scope, input.operationId, fp);
      if (saved) return saved;
      const w = workspace(scope);
      return commit(
        scope,
        input.operationId,
        fp,
        { id: projectId, version: expected + 1 },
        "ProjectGrantChanged",
        [
          ...guarded(scope, { name: "bump", values: [w, projectId, expected] }),
          ...guarded(scope, { name: "revokeRole", values: [w, projectId, principalId] }),
        ],
      );
    },
    async archiveProject(scope, input) {
      inputObject(input);
      const projectId = id(input.projectId);
      const expected = version(input.expectedVersion);
      await authorizeProject(scope, projectId, "manage", true);
      const fp = await fingerprint("archiveProject", input.operationId, [projectId, expected]);
      const saved = await replay(scope, input.operationId, fp);
      if (saved) return saved;
      return commit(
        scope,
        input.operationId,
        fp,
        { id: projectId, version: expected + 1 },
        "ProjectArchived",
        guarded(scope, { name: "archive", values: [workspace(scope), projectId, expected] }),
      );
    },
    getProject: (scope, projectId) => authorizeProject(scope, projectId),
    async getProjectBySlug(scope, projectSlug) {
      const live = await access.authorize(scope, "read");
      const row = await one("projectBySlug", [workspace(live), slug(projectSlug)]);
      if (!row) missing();
      return projectRole(live, str(row, "id"));
    },
    async getProjectByKey(scope, projectKey) {
      const live = await access.authorize(scope, "read");
      const row = await one("projectByKey", [
        actor(live),
        workspace(live),
        key(projectKey),
        privileged(live) ? 1 : 0,
      ]);
      if (!row) missing();
      return {
        id: str(row, "id"),
        key: str(row, "project_key"),
        name: str(row, "name"),
        description: str(row, "description"),
        slug: str(row, "slug"),
        createdAt: num(row, "created_at"),
        updatedAt: num(row, "updated_at"),
        version: num(row, "version"),
        archived: false,
        role: privileged(live) ? "manager" : role(row.grant_role),
      };
    },
    getProjectIncludingArchived: (scope, projectId) =>
      authorizeProject(scope, projectId, "read", true),
    async listVisibleProjects(scope, cursor = "", limit = 50) {
      const live = await access.authorize(scope, "read");
      if (typeof cursor !== "string") invalid();
      if (cursor) id(cursor);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) invalid();
      const rows = (
        await store.run("visible", [
          actor(live),
          workspace(live),
          cursor,
          privileged(live) ? 1 : 0,
          limit + 1,
        ])
      ).rows;
      const selected = rows.slice(0, limit);
      return {
        projects: selected.map((row) => ({
          id: str(row, "id"),
          key: str(row, "project_key"),
          name: str(row, "name"),
          description: str(row, "description"),
          slug: str(row, "slug"),
          createdAt: num(row, "created_at"),
          updatedAt: num(row, "updated_at"),
          version: num(row, "version"),
          archived: false,
          role: privileged(live) ? "manager" : role(row.grant_role),
        })),
        nextCursor: rows.length > limit ? str(selected[selected.length - 1], "id") : null,
      };
    },
    authorizeProject,
    async authorizeProjectPrincipal(scope, projectId, principalId) {
      await authorizeProject(scope, id(projectId), "write");
      const member = await access.getMembership(scope, id(principalId));
      if (!member.active) missing();
      if (member.role === "owner" || member.role === "admin") return;
      const grant = await one("grant", [workspace(scope), projectId, principalId]);
      if (!grant || grant.active !== 1) missing();
    },
    async readOperation(scope, operationId) {
      const s = await access.authorize(scope, "read");
      const saved = await one("readReceipt", [workspace(s), actor(s), id(operationId)]);
      if (!saved) return null;
      await projectRole(s, str(saved, "result_id"), true);
      return { id: str(saved, "result_id"), version: num(saved, "result_version") };
    },
    async readEvents(reader, workspaceId, cursor, limit) {
      if (!eventReader || reader !== eventReader) forbidden();
      id(workspaceId);
      if (
        !Number.isSafeInteger(cursor) ||
        cursor < 0 ||
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > 100
      )
        invalid();
      const rows = (await store.run("events", [workspaceId, cursor, limit])).rows;
      return rows.map(
        (row): ProjectEvent => ({
          eventId: str(row, "event_id"),
          source: "projects",
          schemaVersion: num(row, "schema_version") as 1 | 2,
          workspaceId,
          projectId: row.project_id === null ? null : str(row, "project_id"),
          aggregateId: str(row, "aggregate_id"),
          aggregateVersion: num(row, "aggregate_version"),
          type: str(row, "type") as ProjectEventType,
          occurredAt: num(row, "occurred_at"),
          payload: {
            actorId: str(row, "actor_id"),
            clientId: row.client_id === null ? null : str(row, "client_id"),
          },
          cursor: num(row, "sequence"),
        }),
      );
    },
  };
  return { api: Object.freeze(api), eventReader, maintenance: createMaintenance(store) };
}
