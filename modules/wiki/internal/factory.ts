import {
  type Call,
  type Clock,
  type IdGenerator,
  type ModuleStore,
  PlatformError,
  type Row,
} from "../../../platform/public";
import type { ProjectsApi } from "../../projects/public";
import type {
  WikiApi,
  WikiEvent,
  WikiEventReader,
  WikiPage,
  WikiResult,
  WikiRevision,
} from "../public";
import type { queries } from "../storage/queries";
import { searchExpression, searchPattern, searchTerms } from "./rules";

type Scope = Parameters<ProjectsApi["authorizeProject"]>[0];
type Name = keyof typeof queries;
type Statement = Call<Name>;
interface Dependencies {
  readonly store: ModuleStore<"wiki", Name>;
  readonly projects: Pick<ProjectsApi, "authorizeProject">;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly eventConsumer?: string;
}
function fail(
  code: "validation" | "not_found" | "forbidden" | "conflict" | "unknown",
  message: string,
): never {
  throw new PlatformError(code, message);
}
function object(value: unknown): void {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    fail("validation", "Invalid Wiki input");
}
function id(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value))
    fail("validation", "Invalid ID");
  return value;
}
function slug(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) || value.length > 128)
    fail("validation", "Invalid slug");
  return value;
}
function title(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 512)
    fail("validation", "Invalid title");
  return value.trim();
}
function body(value: unknown): string {
  if (typeof value !== "string" || value.length > 100000)
    fail("validation", "Invalid Markdown body");
  return value;
}
function version(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value >= Number.MAX_SAFE_INTEGER
  )
    fail("validation", "Invalid version");
  return value;
}
function field(row: Row, name: string): string {
  if (typeof row[name] !== "string") fail("unknown", `Invalid ${name}`);
  return row[name];
}
function integer(row: Row, name: string): number {
  if (typeof row[name] !== "number") fail("unknown", `Invalid ${name}`);
  return row[name];
}
async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
export function createWiki(deps: Dependencies): { api: WikiApi; eventReader?: WikiEventReader } {
  const { store, projects, clock, ids } = deps;
  if (store.owner !== "wiki") fail("forbidden", "Wrong Wiki store");
  const eventReader = deps.eventConsumer ? (Object.freeze({}) as WikiEventReader) : undefined;
  const one = async (name: Name, values: Statement["values"]): Promise<Row | undefined> =>
    (await store.run(name, values)).rows[0];
  const workspace = (scope: Scope) => id(scope.workspaceId);
  const actor = (scope: Scope) => id(scope.principalId);
  const kind = (scope: Scope) => (scope.kind === "machine" ? "machine" : "human");
  const fromRow = (row: Row): WikiPage => ({
    id: field(row, "id"),
    projectId: field(row, "project_id"),
    slug: field(row, "slug"),
    title: field(row, "title"),
    body: field(row, "body"),
    version: integer(row, "version"),
    archived: row.archived === 1,
  });
  const revisionFromRow = (row: Row): WikiRevision => ({
    pageId: field(row, "page_id"),
    version: integer(row, "version"),
    action: row.action === "create" ? "create" : row.action === "archive" ? "archive" : "edit",
    title: field(row, "title"),
    body: field(row, "body"),
    actorId: field(row, "actor_id"),
    actorKind: row.actor_kind === "machine" ? "machine" : "human",
    clientId: row.client_id === null ? null : field(row, "client_id"),
    occurredAt: integer(row, "occurred_at"),
  });
  async function page(
    scope: Scope,
    pageId: string,
    permission: "read" | "write" = "read",
    archived = false,
  ): Promise<WikiPage> {
    const row = await one("page", [workspace(scope), id(pageId)]);
    if (!row) fail("not_found", "Page not found");
    await projects.authorizeProject(scope, field(row, "project_id"), permission);
    if (!archived && row.archived === 1) fail("not_found", "Page not found");
    return fromRow(row);
  }
  async function replay(
    scope: Scope,
    operationId: string,
    fingerprint: string,
  ): Promise<WikiResult | null> {
    const row = await one("readReceipt", [workspace(scope), actor(scope), id(operationId)]);
    if (!row) return null;
    await page(scope, field(row, "result_id"), "read", true);
    if (row.fingerprint !== fingerprint)
      fail("conflict", "Operation ID reused with different input");
    return { id: field(row, "result_id"), version: integer(row, "result_version") };
  }
  function guarded(scope: Scope, change: Statement): readonly Statement[] {
    const guardId = ids.next();
    return [
      change,
      { name: "guard", values: [workspace(scope), guardId] },
      { name: "clearGuard", values: [workspace(scope), guardId] },
    ];
  }
  async function commit(
    scope: Scope,
    operationId: string,
    fingerprint: string,
    pageId: string,
    nextVersion: number,
    action: "create" | "edit" | "archive",
    calls: readonly Statement[],
  ): Promise<WikiResult> {
    const w = workspace(scope),
      at = clock.now();
    try {
      await store.batch([
        ...calls,
        { name: "deleteSearch", values: [w, pageId] },
        { name: "upsertSearch", values: [w, pageId] },
        {
          name: "revision",
          values: [action, actor(scope), kind(scope), scope.clientId ?? null, at, w, pageId],
        },
        { name: "receipt", values: [w, actor(scope), operationId, fingerprint, w, pageId] },
        {
          name: "event",
          values: [
            w,
            w,
            ids.next(),
            pageId,
            nextVersion,
            action === "create"
              ? "PageCreated"
              : action === "archive"
                ? "PageArchived"
                : "PageChanged",
            at,
            actor(scope),
            kind(scope),
            scope.clientId ?? null,
          ],
        },
      ]);
    } catch (error) {
      try {
        const saved = await replay(scope, operationId, fingerprint);
        if (saved) return saved;
      } catch (recovery) {
        if (recovery instanceof PlatformError) throw recovery;
        fail("unknown", "Operation outcome unknown; retry same operation ID");
      }
      if (
        error instanceof Error &&
        /(?:CHECK|UNIQUE|FOREIGN KEY) constraint failed/i.test(error.message)
      ) {
        const current = await one("page", [w, pageId]);
        fail(
          "conflict",
          current
            ? `Version or invariant conflict; current version ${integer(current, "version")}`
            : "Slug or page ID conflict",
        );
      }
      fail("unknown", "Operation outcome unknown; retry same operation ID");
    }
    const saved = await replay(scope, operationId, fingerprint);
    if (!saved) fail("unknown", "Operation outcome unknown; retry same operation ID");
    return saved;
  }
  async function fingerprint(
    action: string,
    operationId: unknown,
    values: readonly unknown[],
  ): Promise<string> {
    id(operationId);
    return digest(JSON.stringify([action, ...values]));
  }
  const api: WikiApi = {
    async createPage(scope, input) {
      object(input);
      const projectId = id(input.projectId),
        pageId = id(input.pageId),
        pageSlug = slug(input.slug),
        pageTitle = title(input.title),
        markdown = body(input.body);
      await projects.authorizeProject(scope, projectId, "write");
      const fp = await fingerprint("create", input.operationId, [
        projectId,
        pageId,
        pageSlug,
        pageTitle,
        markdown,
      ]);
      const saved = await replay(scope, input.operationId, fp);
      if (saved) return saved;
      return commit(
        scope,
        input.operationId,
        fp,
        pageId,
        1,
        "create",
        guarded(scope, {
          name: "create",
          values: [workspace(scope), pageId, projectId, pageSlug, pageTitle, markdown],
        }),
      );
    },
    async editPage(scope, input) {
      object(input);
      const current = await page(scope, input.pageId, "write", true),
        expected = version(input.expectedVersion),
        pageTitle = title(input.title),
        markdown = body(input.body);
      const fp = await fingerprint("edit", input.operationId, [
        current.id,
        expected,
        pageTitle,
        markdown,
      ]);
      const saved = await replay(scope, input.operationId, fp);
      if (saved) return saved;
      if (current.archived) fail("not_found", "Page not found");
      return commit(
        scope,
        input.operationId,
        fp,
        current.id,
        expected + 1,
        "edit",
        guarded(scope, {
          name: "edit",
          values: [pageTitle, markdown, workspace(scope), current.id, expected],
        }),
      );
    },
    async archivePage(scope, input) {
      object(input);
      const current = await page(scope, input.pageId, "write", true),
        expected = version(input.expectedVersion);
      const fp = await fingerprint("archive", input.operationId, [current.id, expected]);
      const saved = await replay(scope, input.operationId, fp);
      if (saved) return saved;
      if (current.archived) fail("not_found", "Page not found");
      return commit(
        scope,
        input.operationId,
        fp,
        current.id,
        expected + 1,
        "archive",
        guarded(scope, { name: "archive", values: [workspace(scope), current.id, expected] }),
      );
    },
    async getPage(scope, input) {
      object(input);
      if ("pageId" in input) return page(scope, input.pageId);
      const projectId = id(input.projectId),
        pageSlug = slug(input.slug);
      await projects.authorizeProject(scope, projectId);
      const row = await one("bySlug", [workspace(scope), projectId, pageSlug]);
      if (!row || row.archived === 1) fail("not_found", "Page not found");
      return fromRow(row);
    },
    async listPages(scope, input) {
      object(input);
      const projectId = id(input.projectId);
      await projects.authorizeProject(scope, projectId);
      const limit = input.limit ?? 50;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
        fail("validation", "Invalid limit");
      const cursor = input.cursor === undefined ? "" : slug(input.cursor);
      const rows = (await store.run("list", [workspace(scope), projectId, cursor, limit + 1])).rows;
      const selected = rows.slice(0, limit);
      return {
        pages: selected.map(fromRow),
        nextCursor: rows.length > limit ? field(selected[selected.length - 1], "slug") : null,
      };
    },
    async searchPages(scope, input) {
      object(input);
      const projectId = id(input.projectId);
      await projects.authorizeProject(scope, projectId);
      if (typeof input.text !== "string" || input.text.length > 256)
        fail("validation", "Invalid search text");
      const terms = searchTerms(input.text);
      if (!terms.length || terms.length > 12) fail("validation", "Expected 1–12 search terms");
      const limit = input.limit ?? 20;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
        fail("validation", "Invalid limit");
      const rows = (
        await (terms.some((term) => Array.from(term).length < 3)
          ? store.run("searchShort", [
              ...Array.from({ length: 12 }, (_, index) =>
                terms[index] === undefined ? null : searchPattern(terms[index]),
              ),
              workspace(scope),
              projectId,
              limit,
            ])
          : store.run("search", [
              searchExpression(terms),
              workspace(scope),
              projectId,
              workspace(scope),
              projectId,
              limit,
            ]))
      ).rows;
      return rows.map(fromRow);
    },
    async getRevision(scope, pageId, revisionVersion) {
      await page(scope, pageId, "read", true);
      const row = await one("getRevision", [workspace(scope), pageId, version(revisionVersion)]);
      if (!row) fail("not_found", "Revision not found");
      return revisionFromRow(row);
    },
    async listRevisions(scope, pageId, cursor, limit = 50) {
      const current = await page(scope, pageId, "read", true);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
        fail("validation", "Invalid limit");
      const before = cursor === undefined ? current.version + 1 : version(cursor);
      const rows = (await store.run("listRevisions", [workspace(scope), pageId, before, limit + 1]))
        .rows;
      const selected = rows.slice(0, limit);
      return {
        revisions: selected.map(revisionFromRow),
        nextCursor: rows.length > limit ? integer(selected[selected.length - 1], "version") : null,
      };
    },
    authorizePage: page,
    async readOperation(scope, operationId) {
      const row = await one("readReceipt", [workspace(scope), actor(scope), id(operationId)]);
      if (!row) return null;
      await page(scope, field(row, "result_id"), "read", true);
      return { id: field(row, "result_id"), version: integer(row, "result_version") };
    },
    async readEvents(reader, workspaceId, cursor, limit) {
      if (!eventReader || reader !== eventReader) fail("forbidden", "Event reader denied");
      id(workspaceId);
      if (
        !Number.isSafeInteger(cursor) ||
        cursor < 0 ||
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > 100
      )
        fail("validation", "Invalid cursor");
      return (await store.run("events", [workspaceId, cursor, limit])).rows.map(
        (row): WikiEvent => ({
          eventId: field(row, "event_id"),
          source: "wiki",
          schemaVersion: 1,
          workspaceId,
          aggregateId: field(row, "aggregate_id"),
          aggregateVersion: integer(row, "aggregate_version"),
          type:
            row.type === "PageCreated"
              ? "PageCreated"
              : row.type === "PageArchived"
                ? "PageArchived"
                : "PageChanged",
          occurredAt: integer(row, "occurred_at"),
          payload: {
            actorId: field(row, "actor_id"),
            actorKind: row.actor_kind === "machine" ? "machine" : "human",
            clientId: row.client_id === null ? null : field(row, "client_id"),
          },
          cursor: integer(row, "sequence"),
        }),
      );
    },
  };
  return { api: Object.freeze(api), eventReader };
}
