import {
  type Call,
  type Clock,
  type IdGenerator,
  type ModuleStore,
  PlatformError,
  type RateLimiter,
  type Row,
  type SecretVault,
} from "../../../platform/public";
import type { AccessApi, RequestScope } from "../../access/public";
import type { IssuesApi } from "../../issues/public";
import type { ProjectsApi } from "../../projects/public";
import type { WikiApi } from "../../wiki/public";
import type {
  Delivery,
  ExternalKind,
  ExternalRef,
  ExternalTarget,
  Feedback,
  IntegrationsApi,
} from "../public";
import type { queries } from "../storage/queries";

type Name = keyof typeof queries;
type Statement = Call<Name>;
interface Dependencies {
  readonly store: ModuleStore<"integrations", Name>;
  readonly access: Pick<AccessApi, "authorize">;
  readonly projects: Pick<ProjectsApi, "authorizeProject">;
  readonly issues: Pick<IssuesApi, "authorizeIssue" | "createIssue">;
  readonly wiki: Pick<WikiApi, "authorizePage">;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly vault: SecretVault;
  readonly limiter: RateLimiter;
  readonly send: (url: string, init: RequestInit) => Promise<Response>;
}
const enc = new TextEncoder();
const kinds: readonly ExternalKind[] = [
  "github_issue",
  "github_pr",
  "github_commit",
  "gitlab_issue",
  "gitlab_mr",
  "gitlab_commit",
];
function fail(
  code: "validation" | "not_found" | "forbidden" | "conflict" | "unknown",
  message: string,
): never {
  throw new PlatformError(code, message);
}
function id(v: unknown): string {
  return typeof v === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(v)
    ? v
    : fail("validation", "Invalid ID");
}
function limit(v?: number): number {
  const n = v ?? 30;
  return Number.isSafeInteger(n) && n > 0 && n <= 50 ? n : fail("validation", "Invalid limit");
}
function str(r: Row, k: string): string {
  return typeof r[k] === "string" ? r[k] : fail("unknown", `Invalid ${k}`);
}
function num(r: Row, k: string): number {
  return typeof r[k] === "number" ? r[k] : fail("unknown", `Invalid ${k}`);
}
function https(v: string): string {
  try {
    const u = new URL(v);
    if (
      u.protocol !== "https:" ||
      u.username ||
      u.password ||
      u.hash ||
      !u.hostname ||
      v.length > 2048
    )
      fail("validation", "Invalid HTTPS URL");
    return u.toString();
  } catch {
    return fail("validation", "Invalid HTTPS URL");
  }
}
function outboundUrl(v: string): string {
  const value = https(v);
  const host = new URL(value).hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".cloudflare.internal") ||
    host.endsWith(".workers.internal") ||
    host === "metadata.google.internal" ||
    host === "cloudflare" ||
    host.endsWith(".cloudflare") ||
    host.includes(":") ||
    /^\d+[.]\d+[.]\d+[.]\d+$/.test(host)
  )
    fail("validation", "Outbound host denied");
  return value;
}
async function sha(v: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", enc.encode(v));
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}
async function mac(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const bytes = await crypto.subtle.sign("HMAC", key, enc.encode(value));
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}
function equal(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let n = 0;
  for (let i = 0; i < a.length; i++) n |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return n === 0;
}
function link(r: Row): ExternalRef {
  return {
    id: str(r, "id"),
    target: { kind: str(r, "target_kind") as ExternalTarget["kind"], id: str(r, "target_id") },
    kind: str(r, "kind") as ExternalKind,
    url: str(r, "url"),
    version: num(r, "version"),
  };
}
function feedback(r: Row): Feedback {
  return {
    id: str(r, "id"),
    sourceId: str(r, "source_id"),
    projectId: str(r, "project_id"),
    title: str(r, "title"),
    body: str(r, "body"),
    issueId: r.issue_id === null ? null : str(r, "issue_id"),
    version: num(r, "version"),
    receivedAt: num(r, "received_at"),
  };
}
function delivery(r: Row): Delivery {
  return {
    id: str(r, "id"),
    sourceId: str(r, "source_id"),
    eventType: str(r, "event_type"),
    status: str(r, "status") as Delivery["status"],
    attempts: num(r, "attempts"),
    nextAttemptAt: num(r, "next_attempt_at"),
  };
}
export function createIntegrations(d: Dependencies): {
  api: IntegrationsApi;
  background: { drain(limit?: number): Promise<number> };
} {
  if (d.store.owner !== "integrations") fail("forbidden", "Wrong Integrations store");
  const { store, access, projects, issues, wiki, clock, ids, vault } = d;
  const one = async (name: Name, values: Statement["values"]) =>
    (await store.run(name, values)).rows[0];
  const own = async (s: RequestScope, mode: "read" | "write" = "read") => {
    await access.authorize(s, mode);
    return id(s.workspaceId);
  };
  async function target(s: RequestScope, t: ExternalTarget, mode: "read" | "write") {
    id(t.id);
    if (t.kind === "issue") await issues.authorizeIssue(s, t.id, mode);
    else if (t.kind === "wiki") await wiki.authorizePage(s, t.id, mode);
    else fail("validation", "Invalid target");
  }
  async function receipt(s: RequestScope, operationId: string, input: unknown) {
    const op = id(operationId);
    const fingerprint = await sha(JSON.stringify(input));
    const old = await one("receipt", [s.workspaceId, s.principalId, op]);
    if (old && str(old, "fingerprint") !== fingerprint) fail("conflict", "Operation ID reused");
    return { op, fingerprint, old: old ? str(old, "result_id") : null };
  }
  const audit = (s: RequestScope, action: string, aggregate: string): Statement[] => {
    const at = clock.now();
    return [
      { name: "history", values: [s.workspaceId, ids.next(), action, s.principalId, at] },
      { name: "event", values: [s.workspaceId, ids.next(), aggregate, action, at] },
    ];
  };
  async function page<T>(
    name: Name,
    s: RequestScope,
    cursor: string | undefined,
    n: number | undefined,
    map: (r: Row) => T,
  ): Promise<{ items: readonly T[]; nextCursor: string | null }> {
    await own(s);
    const rows = (await store.run(name, [s.workspaceId, cursor ? id(cursor) : "", limit(n) + 1]))
      .rows;
    const count = limit(n);
    return {
      items: rows.slice(0, count).map(map),
      nextCursor: rows.length > count ? str(rows[count - 1], "id") : null,
    };
  }
  const api: IntegrationsApi = {
    async linkExternalRef(s, input) {
      await own(s, "write");
      await target(s, input.target, "write");
      id(input.refId);
      if (!kinds.includes(input.kind)) fail("validation", "Invalid ref kind");
      const url = https(input.url);
      const r = await receipt(s, input.operationId, { ...input, url });
      if (r.old)
        return link((await one("link", [s.workspaceId, r.old])) ?? fail("unknown", "Missing link"));
      await store.batch([
        {
          name: "addLink",
          values: [s.workspaceId, input.refId, input.target.kind, input.target.id, input.kind, url],
        },
        {
          name: "putReceipt",
          values: [s.workspaceId, s.principalId, r.op, r.fingerprint, input.refId],
        },
        ...audit(s, "ExternalRefLinked", input.refId),
      ]);
      return link(
        (await one("link", [s.workspaceId, input.refId])) ?? fail("unknown", "Missing link"),
      );
    },
    async unlinkExternalRef(s, input) {
      await own(s, "write");
      const current = await one("link", [s.workspaceId, id(input.refId)]);
      if (!current) fail("not_found", "Ref not found");
      await target(
        s,
        {
          kind: str(current, "target_kind") as ExternalTarget["kind"],
          id: str(current, "target_id"),
        },
        "write",
      );
      const r = await receipt(s, input.operationId, input);
      if (r.old)
        return link((await one("link", [s.workspaceId, r.old])) ?? fail("unknown", "Missing link"));
      if (num(current, "version") !== input.expectedVersion || current.active !== 1)
        fail("conflict", "Stale ref");
      const guard = ids.next();
      try {
        await store.batch([
          { name: "removeLink", values: [s.workspaceId, input.refId, input.expectedVersion] },
          { name: "guard", values: [s.workspaceId, guard] },
          { name: "clearGuard", values: [s.workspaceId, guard] },
          {
            name: "putReceipt",
            values: [s.workspaceId, s.principalId, r.op, r.fingerprint, input.refId],
          },
          ...audit(s, "ExternalRefUnlinked", input.refId),
        ]);
      } catch (error) {
        const latest = await one("link", [s.workspaceId, input.refId]);
        if (latest && (num(latest, "version") !== input.expectedVersion || latest.active !== 1))
          fail("conflict", "Stale ref");
        throw error;
      }
      return link(
        (await one("link", [s.workspaceId, input.refId])) ?? fail("unknown", "Missing link"),
      );
    },
    async listExternalRefs(s, t, cursor, n) {
      await own(s);
      await target(s, t, "read");
      const count = limit(n);
      const rows = (
        await store.run("links", [s.workspaceId, t.kind, t.id, cursor ? id(cursor) : "", count + 1])
      ).rows;
      return {
        items: rows.slice(0, count).map(link),
        nextCursor: rows.length > count ? str(rows[count - 1], "id") : null,
      };
    },
    async registerSource(s, input) {
      await own(s, "write");
      if (s.kind !== "human" || (s.role !== "owner" && s.role !== "admin"))
        fail("forbidden", "Admin human required");
      await projects.authorizeProject(s, id(input.projectId), "manage");
      id(input.sourceId);
      if (!input.name.trim() || input.name.length > 120) fail("validation", "Invalid name");
      const r = await receipt(s, input.operationId, input);
      if (r.old) return { id: r.old, secret: null };
      const secret = await vault.inboundSecret(`${s.workspaceId}:${input.sourceId}`);
      await store.batch([
        {
          name: "addSource",
          values: [s.workspaceId, input.sourceId, input.projectId, input.name, await sha(secret)],
        },
        {
          name: "putReceipt",
          values: [s.workspaceId, s.principalId, r.op, r.fingerprint, input.sourceId],
        },
        ...audit(s, "SourceRegistered", input.sourceId),
      ]);
      return { id: input.sourceId, secret };
    },
    async registerWebhook(s, input) {
      await own(s, "write");
      if (s.kind !== "human" || (s.role !== "owner" && s.role !== "admin"))
        fail("forbidden", "Admin human required");
      const source = await one("source", [s.workspaceId, id(input.sourceId)]);
      if (!source) fail("not_found", "Source not found");
      await projects.authorizeProject(s, str(source, "project_id"), "manage");
      const url = outboundUrl(input.url);
      if (
        !input.eventTypes.length ||
        input.eventTypes.length > 20 ||
        input.eventTypes.some((x) => !/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(x))
      )
        fail("validation", "Invalid event types");
      const r = await receipt(s, input.operationId, { ...input, url });
      if (r.old) return { id: r.old, secret: null };
      const secret = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
        b.toString(16).padStart(2, "0"),
      ).join("");
      const guard = ids.next();
      await store.batch([
        {
          name: "webhook",
          values: [
            url,
            JSON.stringify(input.eventTypes),
            await vault.seal(secret),
            s.workspaceId,
            input.sourceId,
          ],
        },
        { name: "guard", values: [s.workspaceId, guard] },
        { name: "clearGuard", values: [s.workspaceId, guard] },
        {
          name: "putReceipt",
          values: [s.workspaceId, s.principalId, r.op, r.fingerprint, input.sourceId],
        },
        ...audit(s, "WebhookRegistered", input.sourceId),
      ]);
      return { id: input.sourceId, secret };
    },
    async listSources(s, cursor, n) {
      if (s.kind !== "human" || (s.role !== "owner" && s.role !== "admin"))
        fail("forbidden", "Admin human required");
      return page("sources", s, cursor, n, (r) => ({
        id: str(r, "id"),
        projectId: str(r, "project_id"),
        name: str(r, "name"),
        webhookUrl: r.webhook_url === null ? null : str(r, "webhook_url"),
        eventTypes: JSON.parse(str(r, "webhook_events")) as string[],
      }));
    },
    async receiveFeedback(input) {
      const ws = id(input.workspaceId),
        sourceId = id(input.sourceId),
        deliveryId = id(input.deliveryId);
      if (!(await d.limiter.allow(`feedback:${(await sha(`${ws}:${sourceId}`)).slice(0, 64)}`)))
        fail("forbidden", "Rate limited");
      if (!Number.isSafeInteger(input.timestamp) || Math.abs(clock.now() - input.timestamp) > 300)
        fail("forbidden", "Stale timestamp");
      if (input.rawBody.length > 32768) fail("validation", "Body too large");
      const source = await one("source", [ws, sourceId]);
      if (!source) fail("not_found", "Source not found");
      const secret = await vault.inboundSecret(`${ws}:${sourceId}`);
      if (!equal(await sha(secret), str(source, "secret_hash")))
        fail("unknown", "Source secret mismatch");
      const expected = await mac(secret, `${input.timestamp}.${deliveryId}.${input.rawBody}`);
      if (!/^[0-9a-f]{64}$/.test(input.signature) || !equal(expected, input.signature))
        fail("forbidden", "Invalid signature");
      const old = await one("feedbackByDelivery", [ws, sourceId, deliveryId]);
      if (old) return { id: str(old, "id") };
      let body: unknown;
      try {
        body = JSON.parse(input.rawBody);
      } catch {
        fail("validation", "Invalid feedback");
      }
      if (!body || typeof body !== "object" || Array.isArray(body))
        fail("validation", "Invalid feedback");
      const data = body as Record<string, unknown>;
      if (
        typeof data.title !== "string" ||
        !data.title.trim() ||
        data.title.length > 240 ||
        typeof data.body !== "string" ||
        data.body.length > 16000
      )
        fail("validation", "Invalid feedback");
      const fid = ids.next();
      try {
        await store.run("addFeedback", [
          ws,
          fid,
          sourceId,
          deliveryId,
          str(source, "project_id"),
          data.title,
          data.body,
          clock.now(),
        ]);
      } catch (error) {
        const duplicate = await one("feedbackByDelivery", [ws, sourceId, deliveryId]);
        if (duplicate) return { id: str(duplicate, "id") };
        throw error;
      }
      return { id: fid };
    },
    async convertFeedback(s, input) {
      await own(s, "write");
      const row = await one("feedback", [s.workspaceId, id(input.feedbackId)]);
      if (!row) fail("not_found", "Feedback not found");
      const f = feedback(row);
      await projects.authorizeProject(s, f.projectId, "write");
      const r = await receipt(s, input.operationId, input);
      if (r.old) return { id: f.id, issueId: r.old, version: f.version };
      if (f.issueId) fail("conflict", "Already converted");
      if (f.version !== input.expectedVersion) fail("conflict", "Stale feedback");
      const issueId = `int_${f.id}`;
      await issues.createIssue(s, {
        operationId: `int_convert_${f.id}`,
        issueId,
        projectId: f.projectId,
        title: f.title,
        description: f.body,
        priority: "medium",
      });
      const guard = ids.next();
      try {
        await store.batch([
          { name: "convert", values: [issueId, s.workspaceId, f.id, f.version] },
          { name: "guard", values: [s.workspaceId, guard] },
          { name: "clearGuard", values: [s.workspaceId, guard] },
          {
            name: "putReceipt",
            values: [s.workspaceId, s.principalId, r.op, r.fingerprint, issueId],
          },
          ...audit(s, "FeedbackConverted", f.id),
        ]);
      } catch (error) {
        const now = await one("feedback", [s.workspaceId, f.id]);
        if (now && now.issue_id === issueId)
          return { id: f.id, issueId, version: num(now, "version") };
        throw error;
      }
      return { id: f.id, issueId, version: f.version + 1 };
    },
    async listFeedback(s, cursor, n) {
      await own(s);
      const count = limit(n);
      const rows = (
        await store.run("feedbackPage", [s.workspaceId, cursor ? id(cursor) : "", count + 1])
      ).rows;
      const items: Feedback[] = [];
      for (const row of rows.slice(0, count)) {
        try {
          await projects.authorizeProject(s, str(row, "project_id"), "read");
          items.push(feedback(row));
        } catch (error) {
          if (!(error instanceof PlatformError) || !["forbidden", "not_found"].includes(error.code))
            throw error;
        }
      }
      return { items, nextCursor: rows.length > count ? str(rows[count - 1], "id") : null };
    },
    async deliverWebhook(s, input) {
      await own(s, "write");
      const source = await one("source", [s.workspaceId, id(input.sourceId)]);
      if (!source) fail("not_found", "Source not found");
      await projects.authorizeProject(s, str(source, "project_id"), "write");
      if (source.webhook_url === null) fail("validation", "Webhook unavailable");
      const events = JSON.parse(str(source, "webhook_events")) as string[];
      if (!events.includes(input.eventType) || input.body.length > 32768)
        fail("validation", "Event unavailable");
      id(input.externalId);
      const r = await receipt(s, input.operationId, input);
      if (r.old)
        return delivery(
          (await one("delivery", [s.workspaceId, r.old])) ?? fail("unknown", "Missing delivery"),
        );
      const existing = await one("deliveryByExternal", [
        s.workspaceId,
        input.sourceId,
        input.externalId,
      ]);
      if (
        existing &&
        (str(existing, "body") !== input.body || str(existing, "event_type") !== input.eventType)
      )
        fail("conflict", "Delivery ID reused");
      const did = ids.next();
      await store.batch([
        {
          name: "addDelivery",
          values: [
            s.workspaceId,
            did,
            input.sourceId,
            input.externalId,
            input.eventType,
            input.body,
            clock.now(),
          ],
        },
        {
          name: "putDeliveryReceipt",
          values: [
            s.workspaceId,
            s.principalId,
            r.op,
            r.fingerprint,
            s.workspaceId,
            input.sourceId,
            input.externalId,
          ],
        },
      ]);
      const actual = await one("deliveryByExternal", [
        s.workspaceId,
        input.sourceId,
        input.externalId,
      ]);
      if (!actual) fail("unknown", "Missing delivery");
      if (str(actual, "body") !== input.body || str(actual, "event_type") !== input.eventType)
        fail("conflict", "Delivery ID reused");
      return delivery(actual);
    },
    async getDeliveryStatus(s, cursor, n) {
      if (s.kind !== "human" || (s.role !== "owner" && s.role !== "admin"))
        fail("forbidden", "Admin human required");
      return page("deliveries", s, cursor, n, delivery);
    },
  };
  return {
    api,
    background: {
      async drain(n = 20) {
        const rows = (await store.run("due", [clock.now(), Math.min(Math.max(n, 1), 50)])).rows;
        let sent = 0;
        for (const row of rows) {
          const ws = str(row, "workspace_id"),
            did = str(row, "id"),
            attempts = num(row, "attempts");
          const url = outboundUrl(str(row, "webhook_url"));
          const secret = await vault.open(str(row, "webhook_cipher"));
          const body = str(row, "body");
          const timestamp = clock.now();
          let ok = false;
          try {
            const response = await d.send(url, {
              method: "POST",
              headers: {
                "content-type": "application/json",
                "x-projektor-timestamp": String(timestamp),
                "x-projektor-event": str(row, "event_type"),
                "x-projektor-signature": await mac(secret, `${timestamp}.${body}`),
              },
              body,
              redirect: "manual",
              signal: AbortSignal.timeout(10000),
            });
            ok = response.ok;
          } catch {
            /* retry */
          }
          const next = attempts + 1;
          await store.run("updateDelivery", [
            ok ? "delivered" : next >= 5 ? "failed" : "pending",
            next,
            ok ? timestamp : timestamp + Math.min(3600, 30 * 2 ** attempts),
            ws,
            did,
            attempts,
          ]);
          if (ok) sent++;
        }
        return sent;
      },
    },
  };
}
