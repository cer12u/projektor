import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
	ListIssueResolutionEventsSchema,
	MAX_RESOLUTION_WINDOW_SECONDS,
} from "../schemas/issue-resolution";
import { getIssue } from "../services/issues";
import type { listIssueResolutionEvents } from "../services/issue-resolution-query";
import {
	authHeaders,
	type JsonRpcResult,
	seedGroupGrant,
	seedIssue,
	seedProject,
	seedProjectFixture,
} from "./helpers";

type ResolutionPage = Awaited<ReturnType<typeof listIssueResolutionEvents>>;
type Fixture = Awaited<ReturnType<typeof seedProjectFixture>>;
type QueryInput = Record<string, string | number | undefined>;

async function seedEvent(
	fixture: Fixture,
	issueId: string,
	occurredAt: number,
	opts: {
		id?: string;
		workspaceId?: string;
		kind?: "completed" | "reopened" | "cancelled";
	} = {}
) {
	const id = opts.id ?? crypto.randomUUID();
	const kind = opts.kind ?? "completed";
	await env.DB.prepare(
		`INSERT INTO issue_resolution_events
		 (id, workspace_id, issue_id, occurred_at, kind, actor_id, from_status, to_status)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
	)
		.bind(
			id,
			opts.workspaceId ?? fixture.workspaceId,
			issueId,
			occurredAt,
			kind,
			fixture.userId,
			kind === "reopened" ? "done" : "in_progress",
			kind === "reopened" ? "in_progress" : kind === "cancelled" ? "cancelled" : "done"
		)
		.run();
	return id;
}

async function restResponse(fixture: Fixture, input: QueryInput) {
	const query = new URLSearchParams(
		Object.entries(input)
			.filter(([, value]) => value !== undefined)
			.map(([key, value]) => [key, String(value)])
	);
	return SELF.fetch(`http://localhost/api/issues/resolution-events?${query}`, {
		headers: authHeaders(fixture.token, fixture.slug),
	});
}

async function restPage(fixture: Fixture, input: QueryInput = {}) {
	const response = await restResponse(fixture, { after: 0, before: 100, ...input });
	expect(response.status).toBe(200);
	return (await response.json()) as ResolutionPage;
}

async function mcpCall(fixture: Fixture, input: Record<string, unknown>) {
	const response = await SELF.fetch(`http://localhost/mcp/${fixture.workspaceId}`, {
		method: "POST",
		headers: authHeaders(fixture.token, fixture.slug),
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: { name: "list_issue_resolution_events", arguments: input },
		}),
	});
	expect(response.status).toBe(200);
	const rpc = (await response.json()) as JsonRpcResult<{
		isError?: boolean;
		content: Array<{ text: string }>;
	}>;
	return rpc.result;
}

describe("Resolution event input validation", () => {
	it("requires an ordered window of at most 366 days, including epoch zero", () => {
		expect(
			ListIssueResolutionEventsSchema.parse({
				after: "0",
				before: `${MAX_RESOLUTION_WINDOW_SECONDS}`,
			})
		).toMatchObject({ after: 0, before: MAX_RESOLUTION_WINDOW_SECONDS, limit: 100 });
		for (const input of [
			{},
			{ after: 0 },
			{ before: 1 },
			{ after: 1, before: 1 },
			{ after: 2, before: 1 },
			{ after: 0, before: MAX_RESOLUTION_WINDOW_SECONDS + 1 },
		]) {
			expect(ListIssueResolutionEventsSchema.safeParse(input).success).toBe(false);
		}
	});

	it("rejects lossy or nonnumeric inputs rather than coercing them to epoch zero", () => {
		for (const value of [
			null,
			false,
			true,
			"",
			" ",
			[],
			{},
			-1,
			"-1",
			0.5,
			"1.5",
			Infinity,
			NaN,
			Number.MAX_SAFE_INTEGER + 1,
		]) {
			expect(
				ListIssueResolutionEventsSchema.safeParse({ after: value, before: 100 }).success
			).toBe(false);
		}
	});

	it("validates page size and compound cursor", () => {
		for (const limit of [0, -1, 201, 1.5, "", null, false]) {
			expect(
				ListIssueResolutionEventsSchema.safeParse({ after: 0, before: 100, limit }).success
			).toBe(false);
		}
		expect(
			ListIssueResolutionEventsSchema.parse({ after: 0, before: 100, limit: "200" }).limit
		).toBe(200);
		for (const cursor of [
			"",
			"5",
			"5:",
			"-1:abc",
			"1.5:abc",
			"1:a:b",
			"0:a b",
			"0:abc",
			"0:0",
			"0:-1",
			"0:1.5",
			"9007199254740992:1",
			"0:9007199254740992",
		]) {
			expect(
				ListIssueResolutionEventsSchema.safeParse({ after: 0, before: 100, cursor }).success
			).toBe(false);
		}
		expect(
			ListIssueResolutionEventsSchema.safeParse({ after: 0, before: 100, cursor: "0:1" }).success
		).toBe(true);
	});
});

describe("Issue resolution event query", () => {
	let fixture: Fixture;
	let issue: Awaited<ReturnType<typeof seedIssue>>;

	beforeEach(async () => {
		fixture = await seedProjectFixture({ role: "owner" });
		issue = await seedIssue(fixture.workspaceId, fixture.projectId, fixture.userId, {
			title: "Recorded completion",
		});
	});

	it("returns event facts in an inclusive/exclusive range, including epoch zero", async () => {
		const zero = await seedEvent(fixture, issue.id, 0);
		const middle = await seedEvent(fixture, issue.id, 1, { kind: "reopened" });
		await seedEvent(fixture, issue.id, 2, { kind: "cancelled" });
		const page = await restPage(fixture, { before: 2 });
		expect(page.items.map((item) => item.id)).toEqual([zero, middle]);
		expect(page.nextCursor).toBeNull();
		expect(page.items[0]).toMatchObject({
			workspace_id: fixture.workspaceId,
			issue_id: issue.id,
			occurred_at: 0,
			kind: "completed",
			actor_id: fixture.userId,
			from_status: "in_progress",
			to_status: "done",
			issue_title: "Recorded completion",
			issue_number: issue.number,
			project_id: fixture.projectId,
			project_key: "PROJ",
			issue_ref: `PROJ-${issue.number}`,
		});
		expect(page.items[0].sequence).toEqual(expect.any(Number));
		expect(page.items[0]).not.toHaveProperty("start");
		expect(page.items[0]).not.toHaveProperty("end");
		expect((await restPage(fixture, { after: 1, before: 2 })).items.map((item) => item.id)).toEqual([
			middle,
		]);
		expect((await restPage(fixture, { after: 2, before: 3 })).items[0].kind).toBe("cancelled");
	});

	it("paginates same-second events exactly once, including a zero cursor", async () => {
		const prefix = crypto.randomUUID();
		const ids = ["a", "b", "c"].map((suffix) => `${prefix}-${suffix}`);
		// UUID order differs from lifecycle order: the sequence must preserve completion,
		// reopening, and re-completion even when all three occur in the same second.
		await seedEvent(fixture, issue.id, 0, { id: ids[2] });
		await seedEvent(fixture, issue.id, 0, { id: ids[0], kind: "reopened" });
		await seedEvent(fixture, issue.id, 0, { id: ids[1] });
		const later = await seedEvent(fixture, issue.id, 1);
		const first = await restPage(fixture, { limit: 2 });
		expect(first.items.map((item) => item.id)).toEqual([ids[2], ids[0]]);
		expect(first.items.map((item) => item.kind)).toEqual(["completed", "reopened"]);
		expect(first.nextCursor).toBe(`0:${first.items[1].sequence}`);
		const second = await restPage(fixture, { limit: 2, cursor: first.nextCursor! });
		expect(second.items.map((item) => item.id)).toEqual([ids[1], later]);
		expect(second.nextCursor).toBeNull();
	});

	it("limits pages to 100 by default and allows at most 200", async () => {
		await env.DB.batch(
			Array.from({ length: 201 }, (_, index) =>
				env.DB.prepare(
					`INSERT INTO issue_resolution_events
					 (id, workspace_id, issue_id, occurred_at, kind, from_status, to_status)
					 VALUES (?, ?, ?, ?, 'completed', 'in_progress', 'done')`
				).bind(crypto.randomUUID(), fixture.workspaceId, issue.id, index)
			)
		);
		const first = await restPage(fixture, { before: 1000 });
		expect(first.items).toHaveLength(100);
		expect(first.nextCursor).not.toBeNull();
		const maxPage = await restPage(fixture, { before: 1000, limit: 200 });
		expect(maxPage.items).toHaveLength(200);
		const lastPage = await restPage(fixture, {
			before: 1000,
			limit: 200,
			cursor: maxPage.nextCursor!,
		});
		expect(lastPage.items).toHaveLength(1);
		expect(lastPage.nextCursor).toBeNull();
		expect((await restResponse(fixture, { after: 0, before: 1000, limit: 201 })).status).toBe(400);
	});

	it("filters by project UUID/key and issue UUID/ref", async () => {
		const otherProject = await seedProject(fixture.workspaceId, "OTHER");
		const otherIssue = await seedIssue(fixture.workspaceId, otherProject.id, fixture.userId);
		const sameProjectIssue = await seedIssue(fixture.workspaceId, fixture.projectId, fixture.userId);
		const match = await seedEvent(fixture, issue.id, 1);
		const sameProject = await seedEvent(fixture, sameProjectIssue.id, 2);
		await seedEvent(fixture, otherIssue.id, 3);
		for (const projectId of [fixture.projectId, "PROJ"]) {
			expect((await restPage(fixture, { projectId })).items.map((item) => item.id)).toEqual([
				match,
				sameProject,
			]);
		}
		for (const issueId of [issue.id, `PROJ-${issue.number}`]) {
			expect((await restPage(fixture, { issueId })).items.map((item) => item.id)).toEqual([match]);
		}
		expect(await restPage(fixture, { projectId: otherProject.id, issueId: issue.id })).toEqual({
			items: [],
			nextCursor: null,
		});
	});

	it("matches REST and MCP payloads and compound pagination", async () => {
		await seedEvent(fixture, issue.id, 0);
		await seedEvent(fixture, issue.id, 1, { kind: "reopened" });
		const input = { after: 0, before: 2, limit: 1, issueId: `PROJ-${issue.number}` };
		const rest = await restPage(fixture, input);
		const mcp = await mcpCall(fixture, input);
		expect(mcp.isError).not.toBe(true);
		expect(JSON.parse(mcp.content[0].text)).toEqual(rest);
		const nextInput = { ...input, cursor: rest.nextCursor! };
		expect(JSON.parse((await mcpCall(fixture, nextInput)).content[0].text)).toEqual(
			await restPage(fixture, nextInput)
		);
	});

	it("uses the same validation errors on REST and MCP", async () => {
		const input = { after: 2, before: 1 };
		const rest = await restResponse(fixture, input);
		expect(rest.status).toBe(400);
		const restBody = (await rest.json()) as { error: { fieldErrors: Record<string, string[]> } };
		const mcp = await mcpCall(fixture, input);
		expect(mcp.isError).toBe(true);
		const mcpBody = JSON.parse(mcp.content[0].text);
		expect(mcpBody.error.code).toBe("validation");
		expect(mcpBody.error.fields).toEqual(restBody.error.fieldErrors);
	});

	it("does not leak other workspaces or events with a mismatched issue workspace", async () => {
		const other = await seedProjectFixture({ role: "owner" });
		const foreignIssue = await seedIssue(other.workspaceId, other.projectId, other.userId);
		const visible = await seedEvent(fixture, issue.id, 1);
		await seedEvent(other, foreignIssue.id, 1);
		// Individual foreign keys cannot prove that an event and its issue share a tenant.
		await seedEvent(fixture, foreignIssue.id, 1);
		await seedEvent(other, issue.id, 1);
		expect((await restPage(fixture)).items.map((item) => item.id)).toEqual([visible]);
		for (const filter of [{ projectId: other.projectId }, { issueId: foreignIssue.id }]) {
			expect(await restPage(fixture, filter)).toEqual({ items: [], nextCursor: null });
		}
	});

	it("also checks the issue project's workspace for owners", async () => {
		const other = await seedProjectFixture({ role: "owner" });
		const inconsistentIssue = await seedIssue(fixture.workspaceId, other.projectId, fixture.userId);
		await seedEvent(fixture, inconsistentIssue.id, 1);
		expect(await restPage(fixture)).toEqual({ items: [], nextCursor: null });
	});

	// Each filter is an independent case with its own fixture/rate window. Keep the
	// normal limiter active: one case must not make 11 requests against the test cap of 5.
	it.each(["project-id", "project-key", "unknown-project", "issue-id", "issue-ref", "unknown-issue"])(
		"does not expose an ungranted project through %s", async (kind) => {
			const viewer = await seedProjectFixture({ role: "viewer" });
			const hiddenProject = await seedProject(viewer.workspaceId, "HIDDEN");
			const hiddenIssue = await seedIssue(viewer.workspaceId, hiddenProject.id, viewer.userId);
			await seedEvent(viewer, hiddenIssue.id, 2);
			const filters: Record<string, QueryInput> = {
				"project-id": { projectId: hiddenProject.id },
				"project-key": { projectId: "HIDDEN" },
				"unknown-project": { projectId: "UNKNOWN" },
				"issue-id": { issueId: hiddenIssue.id },
				"issue-ref": { issueId: `HIDDEN-${hiddenIssue.number}` },
				"unknown-issue": { issueId: "HIDDEN-999" },
			};
			expect(await restPage(viewer, filters[kind])).toEqual({ items: [], nextCursor: null });
		}
	);

	it("issue history stays behind guarded reads without extra authorization queries", async () => {
		const viewer = await seedProjectFixture({ role: "viewer" });
		const hiddenProject = await seedProject(viewer.workspaceId, "HIDDEN");
		const hiddenIssue = await seedIssue(viewer.workspaceId, hiddenProject.id, viewer.userId);
		await seedEvent(viewer, hiddenIssue.id, 2);
		const ctx = { db: env.DB, kv: env.KV, r2: env.R2, workspaceId: viewer.workspaceId, userId: viewer.userId, role: "viewer" as const };
		for (const lookup of [{ id: hiddenIssue.id }, { ref: `HIDDEN-${hiddenIssue.number}` }, { id: `HIDDEN-${hiddenIssue.number}` }]) {
			await expect(getIssue(ctx, lookup)).rejects.toMatchObject({ kind: "not_found" });
		}
		await expect(getIssue(ctx, { id: issue.id })).rejects.toMatchObject({ kind: "not_found" });
		const inconsistent = await seedIssue(fixture.workspaceId, hiddenProject.id, fixture.userId);
		const ownerCtx = { ...ctx, workspaceId: fixture.workspaceId, userId: fixture.userId, role: "owner" as const };
		for (const lookup of [{ id: inconsistent.id }, { ref: `HIDDEN-${inconsistent.number}` }]) {
			await expect(getIssue(ownerCtx, lookup)).rejects.toMatchObject({ kind: "not_found" });
		}
	});

	it.each(["group-membership", "project-grant"])("cached issue history obeys next-request %s revocation", async (kind) => {
		const viewer = await seedProjectFixture({ role: "viewer" });
		const ownedIssue = await seedIssue(viewer.workspaceId, viewer.projectId, viewer.userId);
		await seedEvent(viewer, ownedIssue.id, 2);
		const ctx = { db: env.DB, kv: env.KV, r2: env.R2, workspaceId: viewer.workspaceId, userId: viewer.userId, role: "viewer" as const };
		for (const lookup of [{ id: ownedIssue.id }, { ref: `PROJ-${ownedIssue.number}` }]) {
			expect(await getIssue(ctx, lookup)).toMatchObject({ id: ownedIssue.id });
		}
		if (kind === "group-membership") {
			await env.DB.prepare("DELETE FROM user_group_members WHERE user_id = ?").bind(viewer.userId).run();
		} else {
			await env.DB.prepare("DELETE FROM group_project_grants WHERE project_id = ?").bind(viewer.projectId).run();
		}
		for (const lookup of [{ id: ownedIssue.id }, { ref: `PROJ-${ownedIssue.number}` }]) {
			await expect(getIssue(ctx, lookup)).rejects.toMatchObject({ kind: "not_found" });
		}
	});

	it("workspace removal blocks a warmed issue read before history is returned", async () => {
		const viewer = await seedProjectFixture({ role: "viewer" });
		const ownedIssue = await seedIssue(viewer.workspaceId, viewer.projectId, viewer.userId);
		const url = `http://localhost/api/issues/${ownedIssue.id}`;
		const headers = authHeaders(viewer.token, viewer.slug);
		expect((await SELF.fetch(url, { headers })).status).toBe(200);
		await env.DB.prepare("DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?")
			.bind(viewer.workspaceId, viewer.userId).run();
		expect((await SELF.fetch(url, { headers })).status).toBe(403);
	});

	it("applies default-deny group visibility and responds immediately to revocation", async () => {
		const viewer = await seedProjectFixture({ role: "viewer" });
		const publicIssue = await seedIssue(viewer.workspaceId, viewer.projectId, viewer.userId);
		const hiddenProject = await seedProject(viewer.workspaceId, "HIDDEN");
		const hiddenIssue = await seedIssue(viewer.workspaceId, hiddenProject.id, viewer.userId);
		const visible = await seedEvent(viewer, publicIssue.id, 1);
		const hidden = await seedEvent(viewer, hiddenIssue.id, 2);
		expect((await restPage(viewer)).items.map((item) => item.id)).toEqual([visible]);
		const grant = await seedGroupGrant(viewer.workspaceId, viewer.userId, hiddenProject.id, "viewer");
		expect((await restPage(viewer)).items.map((item) => item.id)).toEqual([visible, hidden]);
		await env.DB.prepare("DELETE FROM user_group_members WHERE group_id = ? AND user_id = ?")
			.bind(grant.groupId, viewer.userId)
			.run();
		expect((await restPage(viewer)).items.map((item) => item.id)).toEqual([visible]);
		const mcp = await mcpCall(viewer, { after: 0, before: 100, issueId: hiddenIssue.id });
		expect(JSON.parse(mcp.content[0].text)).toEqual({ items: [], nextCursor: null });
	});
});
