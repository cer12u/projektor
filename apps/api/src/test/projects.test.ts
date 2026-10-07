import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
	authHeaders,
	type JsonRpcError,
	type JsonRpcResult,
	seedWorkspaceRoles,
	toolError,
} from "./helpers";
import { resetRateLimits } from "./rate-limit-reset";

async function mcpCall<T>(
	workspaceId: string,
	name: string,
	args: unknown,
	headers: Record<string, string>
): Promise<JsonRpcResult<T> | JsonRpcError> {
	const res = await SELF.fetch(`http://localhost/mcp/${workspaceId}`, {
		method: "POST",
		headers,
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: { name, arguments: args },
		}),
	});
	return res.json();
}

function isMcpError(r: JsonRpcResult | JsonRpcError): r is JsonRpcError {
	return "error" in r;
}

describe("Projects REST", () => {
	let ownerToken: string;
	let memberToken: string;
	let viewerToken: string;
	let slug: string;
	let _workspaceId: string;
	let ownerHeaders: Record<string, string>;
	let memberHeaders: Record<string, string>;
	let viewerHeaders: Record<string, string>;

	beforeEach(async () => {
		const roles = await seedWorkspaceRoles();
		slug = roles.workspace.slug;
		_workspaceId = roles.workspace.id;
		ownerToken = roles.owner.token;
		memberToken = roles.member.token;
		viewerToken = roles.viewer.token;
		ownerHeaders = authHeaders(ownerToken, slug);
		memberHeaders = authHeaders(memberToken, slug);
		viewerHeaders = authHeaders(viewerToken, slug);
	});

	it("GET /api/projects returns empty list initially", async () => {
		const res = await SELF.fetch("http://localhost/api/projects", { headers: ownerHeaders });
		expect(res.status).toBe(200);
		const body = (await res.json()) as unknown[];
		expect(Array.isArray(body)).toBe(true);
		expect(body).toHaveLength(0);
	});

	it("POST /api/projects creates a project (owner)", async () => {
		const res = await SELF.fetch("http://localhost/api/projects", {
			method: "POST",
			headers: ownerHeaders,
			body: JSON.stringify({ name: "Alpha", key: "ALPHA" }),
		});
		expect(res.status).toBe(201);
		const body = (await res.json()) as { id: string; name: string; key: string };
		expect(body.id).toBeTruthy();
		expect(body.name).toBe("Alpha");
		expect(body.key).toBe("ALPHA");
	});

	it("POST /api/projects accepts lowercase key and uppercases it", async () => {
		const res = await SELF.fetch("http://localhost/api/projects", {
			method: "POST",
			headers: ownerHeaders,
			body: JSON.stringify({ name: "Beta", key: "beta" }),
		});
		expect(res.status).toBe(201);
		const body = (await res.json()) as { key: string };
		expect(body.key).toBe("BETA");
	});

	it("POST /api/projects rejects member role (403)", async () => {
		const res = await SELF.fetch("http://localhost/api/projects", {
			method: "POST",
			headers: memberHeaders,
			body: JSON.stringify({ name: "Gamma", key: "GAMMA" }),
		});
		expect(res.status).toBe(403);
	});

	it("POST /api/projects rejects viewer role (403)", async () => {
		const res = await SELF.fetch("http://localhost/api/projects", {
			method: "POST",
			headers: viewerHeaders,
			body: JSON.stringify({ name: "Delta", key: "DELTA" }),
		});
		expect(res.status).toBe(403);
	});

	it("POST /api/projects returns 409 for duplicate key", async () => {
		await SELF.fetch("http://localhost/api/projects", {
			method: "POST",
			headers: ownerHeaders,
			body: JSON.stringify({ name: "First", key: "DUPL" }),
		});
		const res = await SELF.fetch("http://localhost/api/projects", {
			method: "POST",
			headers: ownerHeaders,
			body: JSON.stringify({ name: "Second", key: "DUPL" }),
		});
		expect(res.status).toBe(409);
	});

	it("POST /api/projects returns 400 for invalid key format", async () => {
		const res = await SELF.fetch("http://localhost/api/projects", {
			method: "POST",
			headers: ownerHeaders,
			body: JSON.stringify({ name: "Bad", key: "BAD KEY!" }),
		});
		expect(res.status).toBe(400);
	});

	it("POST /api/projects returns 400 for a key starting with a digit (PROJ-440)", async () => {
		const res = await SELF.fetch("http://localhost/api/projects", {
			method: "POST",
			headers: ownerHeaders,
			body: JSON.stringify({ name: "Leading digit", key: "2FA" }),
		});
		expect(res.status).toBe(400);
	});

	it("POST /api/projects accepts a key containing digits after the first character (PROJ-440)", async () => {
		const res = await SELF.fetch("http://localhost/api/projects", {
			method: "POST",
			headers: ownerHeaders,
			body: JSON.stringify({ name: "Digit key", key: "WEB2" }),
		});
		expect(res.status).toBe(201);
	});

	it("POST /api/projects returns 400 for name too long", async () => {
		const res = await SELF.fetch("http://localhost/api/projects", {
			method: "POST",
			headers: ownerHeaders,
			body: JSON.stringify({ name: "x".repeat(101), key: "TOOLONG" }),
		});
		expect(res.status).toBe(400);
	});

	it("POST /api/projects stores NULL description by default", async () => {
		await SELF.fetch("http://localhost/api/projects", {
			method: "POST",
			headers: ownerHeaders,
			body: JSON.stringify({ name: "NullDesc", key: "NULLD" }),
		});
		const listRes = await SELF.fetch("http://localhost/api/projects", { headers: ownerHeaders });
		const projects = (await listRes.json()) as Array<{ key: string; description: string | null }>;
		const proj = projects.find((p) => p.key === "NULLD");
		expect(proj).toBeTruthy();
		expect(proj!.description).toBeNull();
	});

	it("GET /api/projects/:id returns the project", async () => {
		const createRes = await SELF.fetch("http://localhost/api/projects", {
			method: "POST",
			headers: ownerHeaders,
			body: JSON.stringify({ name: "GetMe", key: "GETME" }),
		});
		const { id } = (await createRes.json()) as { id: string };

		const res = await SELF.fetch(`http://localhost/api/projects/${id}`, { headers: ownerHeaders });
		expect(res.status).toBe(200);
		const proj = (await res.json()) as { name: string; key: string };
		expect(proj.name).toBe("GetMe");
		expect(proj.key).toBe("GETME");
	});

	it("GET /api/projects/:id returns 404 for missing project", async () => {
		const res = await SELF.fetch(`http://localhost/api/projects/${crypto.randomUUID()}`, {
			headers: ownerHeaders,
		});
		expect(res.status).toBe(404);
	});

	it("PATCH /api/projects/:id updates name (owner)", async () => {
		const createRes = await SELF.fetch("http://localhost/api/projects", {
			method: "POST",
			headers: ownerHeaders,
			body: JSON.stringify({ name: "OldName", key: "PATCH1" }),
		});
		const { id } = (await createRes.json()) as { id: string };

		const patchRes = await SELF.fetch(`http://localhost/api/projects/${id}`, {
			method: "PATCH",
			headers: ownerHeaders,
			body: JSON.stringify({ name: "NewName" }),
		});
		expect(patchRes.status).toBe(200);
	});

	it("PATCH /api/projects/:id rejects member (403)", async () => {
		const createRes = await SELF.fetch("http://localhost/api/projects", {
			method: "POST",
			headers: ownerHeaders,
			body: JSON.stringify({ name: "PatchTarget", key: "PTGT" }),
		});
		const { id } = (await createRes.json()) as { id: string };

		const patchRes = await SELF.fetch(`http://localhost/api/projects/${id}`, {
			method: "PATCH",
			headers: memberHeaders,
			body: JSON.stringify({ name: "Hacked" }),
		});
		expect(patchRes.status).toBe(403);
	});

	it("PATCH /api/projects/:id archives and unarchives a project", async () => {
		const createRes = await SELF.fetch("http://localhost/api/projects", {
			method: "POST",
			headers: ownerHeaders,
			body: JSON.stringify({ name: "Archivable", key: "ARCH1" }),
		});
		const { id } = (await createRes.json()) as { id: string };

		const archiveRes = await SELF.fetch(`http://localhost/api/projects/${id}`, {
			method: "PATCH",
			headers: ownerHeaders,
			body: JSON.stringify({ archived: true }),
		});
		expect(archiveRes.status).toBe(200);

		const listRes = await SELF.fetch("http://localhost/api/projects", { headers: ownerHeaders });
		const keys = ((await listRes.json()) as Array<{ key: string }>).map((p) => p.key);
		expect(keys).not.toContain("ARCH1");

		const includeArchivedRes = await SELF.fetch(
			"http://localhost/api/projects?includeArchived=true",
			{ headers: ownerHeaders }
		);
		const withArchived = (await includeArchivedRes.json()) as Array<{
			key: string;
			archived_at: number | null;
		}>;
		const archived = withArchived.find((p) => p.key === "ARCH1");
		expect(archived).toBeTruthy();
		expect(archived!.archived_at).not.toBeNull();

		await resetRateLimits();

		const unarchiveRes = await SELF.fetch(`http://localhost/api/projects/${id}`, {
			method: "PATCH",
			headers: ownerHeaders,
			body: JSON.stringify({ archived: false }),
		});
		expect(unarchiveRes.status).toBe(200);

		const afterUnarchive = await SELF.fetch("http://localhost/api/projects", {
			headers: ownerHeaders,
		});
		const afterKeys = ((await afterUnarchive.json()) as Array<{ key: string }>).map((p) => p.key);
		expect(afterKeys).toContain("ARCH1");
	});

	it("DELETE /api/projects/:id works for owner", async () => {
		const createRes = await SELF.fetch("http://localhost/api/projects", {
			method: "POST",
			headers: ownerHeaders,
			body: JSON.stringify({ name: "ToDelete", key: "DEL1" }),
		});
		const { id } = (await createRes.json()) as { id: string };

		const delRes = await SELF.fetch(`http://localhost/api/projects/${id}`, {
			method: "DELETE",
			headers: ownerHeaders,
		});
		expect(delRes.status).toBe(200);
	});

	it("DELETE /api/projects/:id rejects member (403)", async () => {
		const createRes = await SELF.fetch("http://localhost/api/projects", {
			method: "POST",
			headers: ownerHeaders,
			body: JSON.stringify({ name: "NoDelete", key: "NODEL" }),
		});
		const { id } = (await createRes.json()) as { id: string };

		const delRes = await SELF.fetch(`http://localhost/api/projects/${id}`, {
			method: "DELETE",
			headers: memberHeaders,
		});
		expect(delRes.status).toBe(403);
	});
});

describe("Projects MCP", () => {
	let ownerToken: string;
	let slug: string;
	let workspaceId: string;
	let ownerHeaders: Record<string, string>;
	let memberHeaders: Record<string, string>;
	let viewerHeaders: Record<string, string>;

	beforeEach(async () => {
		const roles = await seedWorkspaceRoles();
		slug = roles.workspace.slug;
		workspaceId = roles.workspace.id;
		ownerToken = roles.owner.token;
		ownerHeaders = authHeaders(ownerToken, slug);
		memberHeaders = authHeaders(roles.member.token, slug);
		viewerHeaders = authHeaders(roles.viewer.token, slug);
	});

	it("list_projects returns empty list initially", async () => {
		const res = (await mcpCall<{ content: Array<{ text: string }> }>(
			workspaceId,
			"list_projects",
			{},
			ownerHeaders
		)) as JsonRpcResult<{ content: Array<{ text: string }> }>;
		expect(isMcpError(res)).toBe(false);
		expect(toolError(res)).toBeUndefined();
		const data = JSON.parse(res.result.content[0].text) as unknown[];
		expect(Array.isArray(data)).toBe(true);
		expect(data).toHaveLength(0);
	});

	it("create_project succeeds for owner", async () => {
		const res = await mcpCall(
			workspaceId,
			"create_project",
			{ name: "MCP Project", key: "MCP" },
			ownerHeaders
		);
		expect(isMcpError(res)).toBe(false);
		expect(toolError(res)).toBeUndefined();
		const result = res as JsonRpcResult<{ content: Array<{ text: string }> }>;
		const data = JSON.parse(result.result.content[0].text) as { id: string; key: string };
		expect(data.id).toBeTruthy();
		expect(data.key).toBe("MCP");
	});

	it("create_project uppercases key", async () => {
		const res = (await mcpCall(
			workspaceId,
			"create_project",
			{ name: "Lower", key: "lower" },
			ownerHeaders
		)) as JsonRpcResult<{ content: Array<{ text: string }> }>;
		const data = JSON.parse(res.result.content[0].text) as { key: string };
		expect(data.key).toBe("LOWER");
	});

	it("create_project rejects member role", async () => {
		const res = await mcpCall(
			workspaceId,
			"create_project",
			{ name: "Blocked", key: "BLKD" },
			memberHeaders
		);
		expect(toolError(res)?.code).toBe("forbidden");
	});

	it("create_project rejects viewer role", async () => {
		const res = await mcpCall(
			workspaceId,
			"create_project",
			{ name: "Blocked", key: "BLKD" },
			viewerHeaders
		);
		expect(toolError(res)?.code).toBe("forbidden");
	});

	it("create_project rejects duplicate key", async () => {
		await mcpCall(workspaceId, "create_project", { name: "First", key: "DUPL" }, ownerHeaders);
		const res = await mcpCall(
			workspaceId,
			"create_project",
			{ name: "Second", key: "DUPL" },
			ownerHeaders
		);
		expect(toolError(res)?.code).toBe("conflict");
	});

	it("create_project rejects invalid key format", async () => {
		const res = await mcpCall(
			workspaceId,
			"create_project",
			{ name: "Bad", key: "BAD KEY!" },
			ownerHeaders
		);
		expect(toolError(res)?.code).toBe("validation");
	});

	it("create_project rejects name too long", async () => {
		const res = await mcpCall(
			workspaceId,
			"create_project",
			{ name: "x".repeat(101), key: "TOOLNG" },
			ownerHeaders
		);
		expect(toolError(res)?.code).toBe("validation");
	});

	it("create_project stores NULL description by default", async () => {
		await mcpCall(workspaceId, "create_project", { name: "NullDesc", key: "MCPND" }, ownerHeaders);

		const listRes = (await mcpCall<{ content: Array<{ text: string }> }>(
			workspaceId,
			"list_projects",
			{},
			ownerHeaders
		)) as JsonRpcResult<{ content: Array<{ text: string }> }>;
		const projects = JSON.parse(listRes.result.content[0].text) as Array<{
			key: string;
			description: string | null;
		}>;
		const proj = projects.find((p) => p.key === "MCPND");
		expect(proj).toBeTruthy();
		expect(proj!.description).toBeNull();
	});

	it("REST GET /api/projects returns workspace_slug and open_issue_count fields", async () => {
		await SELF.fetch("http://localhost/api/projects", {
			method: "POST",
			headers: ownerHeaders,
			body: JSON.stringify({ name: "Shape Check", key: "SHAPE" }),
		});

		const res = await SELF.fetch("http://localhost/api/projects", { headers: ownerHeaders });
		const projects = (await res.json()) as Array<{
			key: string;
			workspace_id: string;
			workspace_slug: string;
			workspace_name: string;
			open_issue_count: number;
		}>;
		const proj = projects.find((p) => p.key === "SHAPE");
		expect(proj).toBeTruthy();
		expect(proj!.workspace_id).toBeTruthy();
		expect(typeof proj!.workspace_slug).toBe("string");
		expect(typeof proj!.workspace_name).toBe("string");
		expect(typeof proj!.open_issue_count).toBe("number");
		expect(proj!.open_issue_count).toBe(0);
	});

	it("REST and MCP list_projects return the same keys", async () => {
		// Create via REST
		await SELF.fetch("http://localhost/api/projects", {
			method: "POST",
			headers: ownerHeaders,
			body: JSON.stringify({ name: "Parity Test", key: "PARITY" }),
		});

		const restRes = await SELF.fetch("http://localhost/api/projects", { headers: ownerHeaders });
		const restProjects = (await restRes.json()) as Array<{ key: string }>;

		const mcpRes = (await mcpCall<{ content: Array<{ text: string }> }>(
			workspaceId,
			"list_projects",
			{},
			ownerHeaders
		)) as JsonRpcResult<{ content: Array<{ text: string }> }>;
		const mcpProjects = JSON.parse(mcpRes.result.content[0].text) as Array<{ key: string }>;

		expect(restProjects.map((p) => p.key)).toEqual(mcpProjects.map((p) => p.key));
	});

	it("update_project archives a project and list_projects excludes it by default", async () => {
		const createRes = await mcpCall(
			workspaceId,
			"create_project",
			{ name: "MCP Archivable", key: "MARCH" },
			ownerHeaders
		);
		const { id } = JSON.parse(
			(createRes as JsonRpcResult<{ content: Array<{ text: string }> }>).result.content[0].text
		) as { id: string };

		const updateRes = await mcpCall(
			workspaceId,
			"update_project",
			{ id, archived: true },
			ownerHeaders
		);
		expect(isMcpError(updateRes)).toBe(false);
		expect(toolError(updateRes)).toBeUndefined();

		const listRes = (await mcpCall<{ content: Array<{ text: string }> }>(
			workspaceId,
			"list_projects",
			{},
			ownerHeaders
		)) as JsonRpcResult<{ content: Array<{ text: string }> }>;
		const keys = (JSON.parse(listRes.result.content[0].text) as Array<{ key: string }>).map(
			(p) => p.key
		);
		expect(keys).not.toContain("MARCH");

		const includeArchivedRes = (await mcpCall<{ content: Array<{ text: string }> }>(
			workspaceId,
			"list_projects",
			{ includeArchived: true },
			ownerHeaders
		)) as JsonRpcResult<{ content: Array<{ text: string }> }>;
		const includeArchivedKeys = (
			JSON.parse(includeArchivedRes.result.content[0].text) as Array<{ key: string }>
		).map((p) => p.key);
		expect(includeArchivedKeys).toContain("MARCH");
	});

	it("REST create_project and MCP create_project enforce the same role guard", async () => {
		const restRes = await SELF.fetch("http://localhost/api/projects", {
			method: "POST",
			headers: memberHeaders,
			body: JSON.stringify({ name: "ByMember", key: "MEMBR" }),
		});
		const mcpRes = await mcpCall(
			workspaceId,
			"create_project",
			{ name: "ByMember", key: "MEMBR" },
			memberHeaders
		);

		// Both must reject member
		expect(restRes.status).toBe(403);
		expect(toolError(mcpRes)?.code).toBe("forbidden");
	});
});

describe("GET /api/projects cross-workspace", () => {
	it("returns projects from all workspaces the user belongs to", async () => {
		const { seedFixture, seedProject, seedWorkspace, seedMember, seedGroupGrant, seedUserToken } =
			await import("./helpers");

		const ws1 = await seedFixture({ role: "owner" });
		const ws2 = await seedWorkspace();
		await seedProject(ws1.workspace.id, "WS1P");
		const ws2p = await seedProject(ws2.id, "WS2P");
		await seedMember(ws2.id, ws1.user.id, "member");
		// PROJ-311: a member sees a project only via a grant (owner-of-ws1 bypasses in ws1).
		await seedGroupGrant(ws2.id, ws1.user.id, ws2p.id);

		const res = await SELF.fetch("http://localhost/api/projects", {
			headers: { Authorization: `Bearer ${await seedUserToken(ws1.user.id)}` },
		});
		expect(res.status).toBe(200);
		const keys = ((await res.json()) as Array<{ key: string }>).map((p) => p.key);
		expect(keys).toContain("WS1P");
		expect(keys).toContain("WS2P");
	});

	it("does not return projects from workspaces the user is not a member of", async () => {
		const { seedFixture, seedProject, seedWorkspace } = await import("./helpers");

		const user = await seedFixture({ role: "owner" });
		const other = await seedWorkspace();
		await seedProject(user.workspace.id, "MINE");
		await seedProject(other.id, "NOTMINE");

		const res = await SELF.fetch("http://localhost/api/projects", {
			headers: { Authorization: `Bearer ${user.token}` },
		});
		expect(res.status).toBe(200);
		const keys = ((await res.json()) as Array<{ key: string }>).map((p) => p.key);
		expect(keys).toContain("MINE");
		expect(keys).not.toContain("NOTMINE");
	});

	it("returns 401 with no auth", async () => {
		const res = await SELF.fetch("http://localhost/api/projects");
		expect(res.status).toBe(401);
	});

	it("open_issue_count reflects non-done issues only", async () => {
		const { seedFixture, seedProject, seedIssue } = await import("./helpers");

		const fixture = await seedFixture({ role: "owner" });
		const project = await seedProject(fixture.workspace.id, "ICNT");

		await seedIssue(fixture.workspace.id, project.id, fixture.user.id, { status: "backlog" });
		await seedIssue(fixture.workspace.id, project.id, fixture.user.id, { status: "todo" });
		await seedIssue(fixture.workspace.id, project.id, fixture.user.id, { status: "done" });

		const res = await SELF.fetch("http://localhost/api/projects", {
			headers: { Authorization: `Bearer ${fixture.token}` },
		});
		const projects = (await res.json()) as Array<{ key: string; open_issue_count: number }>;
		const proj = projects.find((p) => p.key === "ICNT");
		expect(proj).toBeTruthy();
		expect(proj!.open_issue_count).toBe(2);
	});
});

// PTORDEV-6: exercise the shared service through REST and MCP on real local D1.
describe("Project write atomicity", () => {
	async function fixture() {
		const roles = await seedWorkspaceRoles();
		return {
			roles,
			headers: authHeaders(roles.owner.token, roles.workspace.slug),
		};
	}

	function create(headers: Record<string, string>, key: string, name = key) {
		return SELF.fetch("http://localhost/api/projects", {
			method: "POST",
			headers,
			body: JSON.stringify({ name, key }),
		});
	}

	function update(headers: Record<string, string>, id: string, input: unknown) {
		return SELF.fetch(`http://localhost/api/projects/${id}`, {
			method: "PATCH",
			headers,
			body: JSON.stringify(input),
		});
	}

	async function auditCount(workspaceId: string, action: string) {
		return env.DB.prepare(
			"SELECT count(*) AS n FROM activity WHERE workspace_id = ? AND entity_type = 'project' AND action = ?"
		)
			.bind(workspaceId, action)
			.first<number>("n");
	}

	it("concurrent case-insensitive creates commit one project and one audit (201/409)", async () => {
		const { roles, headers } = await fixture();
		const results = await Promise.all([
			create(headers, "RACE", "First name"),
			create(headers, "race", "Second name"),
		]);
		expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
		const conflict = results.find((r) => r.status === 409)!;
		expect(await conflict.json()).toEqual({ error: "Project key RACE already exists" });
		expect(await auditCount(roles.workspace.id, "created")).toBe(1);
		expect(
			await env.DB.prepare("SELECT count(*) AS n FROM projects WHERE workspace_id = ?")
				.bind(roles.workspace.id)
				.first<number>("n")
		).toBe(1);
	});

	it("competing updates and create/update races return one success and one conflict", async () => {
		const { roles, headers } = await fixture();
		const a = (await (await create(headers, "FIRST")).json()) as { id: string };
		const b = (await (await create(headers, "SECOND")).json()) as { id: string };
		const updates = await Promise.all([
			update(headers, a.id, { key: "TARGET" }),
			update(headers, b.id, { key: "target" }),
		]);
		expect(updates.map((r) => r.status).sort()).toEqual([200, 409]);
		expect(await auditCount(roles.workspace.id, "updated")).toBe(1);
		await resetRateLimits();
		const mixed = await Promise.all([
			create(headers, "MIXED"),
			update(headers, a.id, { key: "mixed" }),
		]);
		expect(mixed.filter((r) => r.status === 409)).toHaveLength(1);
		expect(mixed.filter((r) => r.status === 200 || r.status === 201)).toHaveLength(1);
	});

	it("reserves archived keys, allows self-update and other workspaces, frees a deleted key", async () => {
		const first = await fixture();
		const second = await fixture();
		const a = (await (await create(first.headers, "KEPT")).json()) as { id: string };
		expect((await update(first.headers, a.id, { key: "kept", archived: true })).status).toBe(200);
		expect((await create(first.headers, "KEPT", "Different name")).status).toBe(409);
		expect((await create(second.headers, "kept")).status).toBe(201);
		await resetRateLimits();
		expect((await update(first.headers, a.id, { archived: false })).status).toBe(200);
		expect((await update(second.headers, a.id, { key: "HIDDEN" })).status).toBe(404);
		expect(await auditCount(second.roles.workspace.id, "updated")).toBe(0);
		expect(
			(
				await SELF.fetch(`http://localhost/api/projects/${a.id}`, {
					method: "DELETE",
					headers: first.headers,
				})
			).status
		).toBe(200);
		expect((await create(first.headers, "kept")).status).toBe(201);
	});

	it("rolls create and update back when their audit INSERT fails", async () => {
		const { roles, headers } = await fixture();
		const project = (await (await create(headers, "BEFORE")).json()) as { id: string };
		const trigger = `project_audit_failure_${roles.workspace.id.replaceAll("-", "")}`;
		await env.DB.prepare(
			`CREATE TRIGGER ${trigger} BEFORE INSERT ON activity
			 WHEN NEW.workspace_id = '${roles.workspace.id}' AND NEW.entity_type = 'project'
			 BEGIN SELECT RAISE(ABORT, 'synthetic project audit failure'); END`
		).run();
		try {
			expect((await create(headers, "FAILED")).status).toBe(500);
			expect((await update(headers, project.id, { key: "AFTER", name: "Changed" })).status).toBe(
				500
			);
			const row = await env.DB.prepare("SELECT key, name FROM projects WHERE id = ?")
				.bind(project.id)
				.first();
			expect(row).toEqual({ key: "BEFORE", name: "BEFORE" });
			expect(
				await env.DB.prepare("SELECT count(*) AS n FROM projects WHERE workspace_id = ?")
					.bind(roles.workspace.id)
					.first<number>("n")
			).toBe(1);
			expect(await auditCount(roles.workspace.id, "created")).toBe(1);
			expect(await auditCount(roles.workspace.id, "updated")).toBe(0);
		} finally {
			await env.DB.prepare(`DROP TRIGGER ${trigger}`).run();
		}
	});

	it("same-value updates succeed and missing updates produce no orphan audit", async () => {
		const { roles, headers } = await fixture();
		const project = (await (await create(headers, "SAME")).json()) as { id: string };
		expect((await update(headers, project.id, { key: "same", name: "SAME" })).status).toBe(200);
		expect(await auditCount(roles.workspace.id, "updated")).toBe(1);
		expect((await update(headers, crypto.randomUUID(), { key: "MISSING" })).status).toBe(404);
		expect(await auditCount(roles.workspace.id, "updated")).toBe(1);
	});

	it("MCP key updates use the same conflict contract", async () => {
		const { roles, headers } = await fixture();
		await create(headers, "TAKEN");
		const other = (await (await create(headers, "OTHER")).json()) as { id: string };
		const result = await mcpCall(
			roles.workspace.id,
			"update_project",
			{
				id: other.id,
				key: "taken",
			},
			headers
		);
		expect(toolError(result)?.code).toBe("conflict");
		expect(toolError(result)?.message).toBe("Project key TAKEN already exists");
	});
});
