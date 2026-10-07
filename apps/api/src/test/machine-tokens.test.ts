import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { effectiveProjectRole } from "../services/access";
import { listProjectsAcrossWorkspaces } from "../services/projects";
import { getUserWorkspaces } from "../services/user-tokens";
import { listWorkspaces } from "../services/workspaces";
import {
	authHeaders,
	seedFixture,
	seedGroupGrant,
	seedMember,
	seedProject,
	seedUser,
	seedWorkspace,
} from "./helpers";

type IssuedToken = { id: string; token: string; userId: string; issuedByUserId: string; workspaceId: string };

async function asHuman<T>(email: string, fn: () => Promise<T>): Promise<T> {
	const previous = env.DEV_USER_EMAIL;
	env.DEV_USER_EMAIL = email;
	try { return await fn(); } finally { env.DEV_USER_EMAIL = previous; }
}

async function setup() {
	const owner = await seedFixture({ role: "owner" });
	const actor = await seedUser(`machine-${crypto.randomUUID()}@example.com`);
	await seedMember(owner.workspace.id, actor.id, "member");
	const project = await seedProject(owner.workspace.id, "MCH");
	const hidden = await seedProject(owner.workspace.id, "HID");
	const { groupId } = await seedGroupGrant(owner.workspace.id, actor.id, project.id);
	const body = { name: `machine-${crypto.randomUUID()}`, machineActorId: actor.id, scopes: ["read", "write"], expiresInDays: 30 };
	const mint = (input: unknown = body, email = owner.user.email, slug = owner.workspace.slug) =>
		asHuman(email, () => SELF.fetch(`http://localhost/api/workspaces/${slug}/tokens`, {
			method: "POST", headers: { "X-Workspace-Slug": owner.workspace.slug, "Content-Type": "application/json" }, body: JSON.stringify(input),
		}));
	const issue = (token: string, projectId = project.id, extra = {}) => SELF.fetch("http://localhost/api/issues", {
		method: "POST", headers: authHeaders(token, owner.workspace.slug),
		body: JSON.stringify({ projectId, title: "Machine-managed issue", assigneeId: actor.id, ...extra }),
	});
	const mcp = async (token: string, name: string, args = {}, workspaceId = owner.workspace.id) => {
		const response = await SELF.fetch(`http://localhost/mcp/${workspaceId}`, {
			method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
		});
		return { response, body: await response.json() as { result?: { isError?: boolean; content: Array<{ text: string }> } } };
	};
	return { owner, actor, project, hidden, groupId, body, mint, issue, mcp };
}

async function issueToken(f: Awaited<ReturnType<typeof setup>>, scopes = ["read", "write"]) {
	const response = await f.mint({ ...f.body, scopes });
	expect(response.status).toBe(201);
	return await response.json() as IssuedToken;
}

describe("owner-provisioned machine credentials", () => {
	it("keeps issuer and actor distinct, with workspace confinement and no owner session for routine work", async () => {
		const f = await setup();
		const token = await issueToken(f);
		expect(token).toMatchObject({ userId: f.actor.id, issuedByUserId: f.owner.user.id, workspaceId: f.owner.workspace.id });
		expect(token.token).toMatch(/^pk_[a-f0-9]{64}$/);
		const stored = await env.DB.prepare("SELECT user_id, issued_by_user_id, workspace_id FROM api_tokens WHERE id = ?").bind(token.id).first();
		expect(stored).toEqual({ user_id: f.actor.id, issued_by_user_id: f.owner.user.id, workspace_id: f.owner.workspace.id });
		const me = await SELF.fetch("http://localhost/auth/me", { headers: { Authorization: `Bearer ${token.token}` } });
		expect(me.status).toBe(200);
		expect(await me.json()).toMatchObject({ user: { id: f.actor.id }, auth: { kind: "agent", principalKind: "machine", issuedByUserId: f.owner.user.id } });
		const created = await f.issue(token.token);
		expect(created.status).toBe(201);
		const { id } = await created.json() as { id: string };
		expect(await env.DB.prepare("SELECT created_by_id, author_kind, assignee_id FROM issues WHERE id = ?").bind(id).first()).toEqual({ created_by_id: f.actor.id, author_kind: "agent", assignee_id: f.actor.id });
		const comment = await SELF.fetch(`http://localhost/api/issues/${id}/comments`, { method: "POST", headers: authHeaders(token.token, f.owner.workspace.slug), body: JSON.stringify({ body: "Progress from the machine actor" }) });
		expect(comment.status).toBe(201);
		expect(await env.DB.prepare("SELECT author_id, author_kind FROM issue_comments WHERE issue_id = ?").bind(id).first()).toEqual({ author_id: f.actor.id, author_kind: "agent" });
		const mine = await SELF.fetch("http://localhost/api/issues?assignee=me", { headers: authHeaders(token.token, f.owner.workspace.slug) });
		expect((await mine.json() as { items: Array<{ id: string }> }).items.map((row) => row.id)).toEqual([id]);
		const changed = await f.mcp(token.token, "update_issue", { id, title: "Updated through MCP" });
		expect(changed.body.result?.isError).not.toBe(true);
		expect(await env.DB.prepare("SELECT title FROM issues WHERE id = ?").bind(id).first()).toEqual({ title: "Updated through MCP" });
		const activities = await env.DB.prepare("SELECT DISTINCT actor_id FROM activity WHERE entity_id = ?").bind(id).all();
		expect(activities.results).toEqual([{ actor_id: f.actor.id }]);
	});

	it("does not change legacy token subjects, defaults or privileges", async () => {
		const f = await setup();
		const issued = await f.mint({ name: "ordinary-owner-token" });
		expect(issued.status).toBe(201);
		const token = await issued.json() as IssuedToken & { scopes: string[]; expiresAt: number | null };
		expect(token).toMatchObject({ userId: f.owner.user.id, issuedByUserId: f.owner.user.id, scopes: ["read", "write"], expiresAt: null });
		expect((await f.issue(token.token, f.hidden.id)).status).toBe(201);
		expect((await f.issue(f.owner.token, f.hidden.id)).status).toBe(201);
	});

	it.each(["admin", "member", "viewer"])("a human %s cannot delegate a credential", async (role) => {
		const f = await setup();
		const user = await seedUser(`issuer-${crypto.randomUUID()}@example.com`);
		await seedMember(f.owner.workspace.id, user.id, role);
		expect((await f.mint(f.body, user.email)).status).toBe(403);
	});

	it("even an owner's bearer token cannot provision a machine credential", async () => {
		const f = await setup();
		const response = await SELF.fetch(`http://localhost/api/workspaces/${f.owner.workspace.slug}/tokens`, { method: "POST", headers: authHeaders(f.owner.token, f.owner.workspace.slug), body: JSON.stringify(f.body) });
		expect(response.status).toBe(403);
		expect(await env.DB.prepare("SELECT id FROM api_tokens WHERE name = ?").bind(f.body.name).first()).toBeNull();
	});

	it.each(["owner", "admin", "viewer", "missing", "other-workspace", "deleted"])("rejects %s actors without creating credentials", async (role) => {
		const f = await setup();
		let target = f.actor.id;
		if (role === "missing" || role === "deleted") target = crypto.randomUUID();
		else if (role === "other-workspace") {
			const other = await seedWorkspace();
			await env.DB.prepare("DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?").bind(f.owner.workspace.id, target).run();
			await seedMember(other.id, target);
		} else await env.DB.prepare("UPDATE workspace_members SET role = ? WHERE workspace_id = ? AND user_id = ?").bind(role, f.owner.workspace.id, target).run();
		expect((await f.mint({ ...f.body, machineActorId: target })).status).toBe(403);
		expect(await env.DB.prepare("SELECT id FROM api_tokens WHERE name = ?").bind(f.body.name).first()).toBeNull();
	});

	it.each([
		{ scopes: undefined }, { scopes: [] }, { scopes: ["*"] }, { scopes: ["admin"] },
		{ expiresInDays: undefined }, { expiresInDays: 0 }, { expiresInDays: -1 }, { expiresInDays: 366 },
		{ machineActorId: "not-a-uuid" }, { issuedByUserId: "forged" }, { issued_by_user_id: "forged" },
		{ userId: "forged" }, { workspaceId: "forged" },
	])("rejects invalid or forged issuance fields %j", async (override) => {
		const f = await setup();
		expect((await f.mint({ ...f.body, ...override })).status).toBe(400);
		expect(await env.DB.prepare("SELECT id FROM api_tokens WHERE name = ?").bind(f.body.name).first()).toBeNull();
	});

	it("rejects a path/header workspace mismatch", async () => {
		const f = await setup();
		const other = await seedWorkspace();
		expect((await f.mint(f.body, f.owner.user.email, other.slug)).status).toBe(404);
	});

	it("keeps hidden projects invisible on REST and MCP and cannot gain access by reassignment", async () => {
		const f = await setup();
		const token = await issueToken(f);
		expect((await f.issue(token.token, f.hidden.id, { assigneeId: f.actor.id })).status).toBe(404);
		const hidden = await f.mcp(token.token, "create_issue", { projectId: f.hidden.id, title: "Blocked", assigneeId: f.actor.id });
		expect(hidden.body.result?.isError).toBe(true);
		const list = await SELF.fetch("http://localhost/api/projects", { headers: { Authorization: `Bearer ${token.token}` } });
		expect((await list.json() as Array<{ id: string }>).map((row) => row.id)).toEqual([f.project.id]);
	});

	it("a group-grant removal immediately hides and blocks the previously allowed project", async () => {
		const f = await setup();
		const token = await issueToken(f);
		expect((await f.issue(token.token)).status).toBe(201);
		await env.DB.prepare("DELETE FROM group_project_grants WHERE group_id = ? AND project_id = ?").bind(f.groupId, f.project.id).run();
		expect((await f.issue(token.token)).status).toBe(404);
		const result = await f.mcp(token.token, "list_projects");
		expect(JSON.parse(result.body.result!.content[0].text)).toEqual([]);
	});

	it.each(["owner", "admin", "viewer", "removed"])("%s membership fails closed even on auth-only/global-list routes", async (role) => {
		const f = await setup();
		const token = await issueToken(f);
		if (role === "removed") await env.DB.prepare("DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?").bind(f.owner.workspace.id, f.actor.id).run();
		else await env.DB.prepare("UPDATE workspace_members SET role = ? WHERE workspace_id = ? AND user_id = ?").bind(role, f.owner.workspace.id, f.actor.id).run();
		for (const path of ["/auth/me", "/api/projects", "/api/workspaces", "/api/issues"]) {
			expect((await SELF.fetch(`http://localhost${path}`, { headers: authHeaders(token.token, f.owner.workspace.slug) })).status).toBe(403);
		}
		expect((await f.mcp(token.token, "list_projects")).response.status).toBe(403);
	});

	it("a promotion between authentication and the list query cannot activate an admin bypass", async () => {
		const f = await setup();
		await issueToken(f);
		await env.DB.prepare("UPDATE workspace_members SET role = 'owner' WHERE workspace_id = ? AND user_id = ?").bind(f.owner.workspace.id, f.actor.id).run();
		expect(await listProjectsAcrossWorkspaces(f.actor.id, env.DB, false, f.owner.workspace.id, true)).toEqual([]);
		expect(await listWorkspaces(env.DB, f.actor.id, f.owner.workspace.id, true)).toEqual([]);
		expect(await getUserWorkspaces({ db: env.DB, userId: f.actor.id, tokenWorkspaceId: f.owner.workspace.id, machinePrincipal: true })).toEqual([]);
		// Ordinary owner tokens retain their existing all-project behavior.
		expect(await listProjectsAcrossWorkspaces(f.actor.id, env.DB, false, f.owner.workspace.id)).toHaveLength(2);
	});

	it("read scope refuses mutations over REST and MCP", async () => {
		const f = await setup();
		const token = await issueToken(f, ["read"]);
		expect((await f.issue(token.token)).status).toBe(403);
		const write = await f.mcp(token.token, "create_issue", { projectId: f.project.id, title: "Blocked" });
		expect(write.response.status).toBe(403);
	});

	it("cannot mint, grant, invite or promote itself", async () => {
		const f = await setup();
		const token = await issueToken(f);
		for (const [path, method, body] of [
			[`/api/workspaces/${f.owner.workspace.slug}/tokens`, "POST", f.body],
			["/auth/tokens", "POST", { name: "escape", scopes: ["*"] }],
			[`/api/workspaces/${f.owner.workspace.slug}/members/${f.actor.id}`, "PATCH", { role: "owner" }],
			[`/api/workspaces/${f.owner.workspace.slug}/members`, "POST", { email: "escape@example.com", role: "owner" }],
			[`/api/workspaces/${f.owner.workspace.slug}/groups/${f.groupId}/grants`, "PUT", { projectId: f.hidden.id, role: "admin" }],
		] as const) {
			const response = await SELF.fetch(`http://localhost${path}`, { method, headers: authHeaders(token.token, f.owner.workspace.slug), body: JSON.stringify(body) });
			expect(response.status).toBe(403);
		}
	});

	it("a viewer grant remains read-only despite a write-capable machine token", async () => {
		const f = await setup();
		const token = await issueToken(f);
		await env.DB.prepare("UPDATE group_project_grants SET role = 'viewer' WHERE group_id = ?").bind(f.groupId).run();
		expect((await f.issue(token.token)).status).toBe(403);
		const result = await f.mcp(token.token, "create_issue", { projectId: f.project.id, title: "Viewer cannot write" });
		expect(result.body.result?.isError).toBe(true);
	});

	it("caller-supplied actor headers cannot turn an owner token into a machine token", async () => {
		const f = await setup();
		const response = await SELF.fetch("http://localhost/auth/me", { headers: {
			...authHeaders(f.owner.token, f.owner.workspace.slug), "X-Actor-Id": f.actor.id,
		} });
		expect(await response.json()).toMatchObject({ user: { id: f.owner.user.id }, auth: { principalKind: "user" } });
	});

	it("a machine's project-admin grant is capped at member", async () => {
		const f = await setup();
		await env.DB.prepare("UPDATE group_project_grants SET role = 'admin' WHERE group_id = ?").bind(f.groupId).run();
		expect(await effectiveProjectRole({ db: env.DB, kv: env.KV, r2: env.R2, workspaceId: f.owner.workspace.id, userId: f.actor.id, role: "member", auth: { kind: "agent", method: "pk", principalKind: "machine" } }, f.project.id)).toBe("member");
	});

	it("cannot read another workspace even when its actor is an owner there", async () => {
		const f = await setup();
		const other = await seedWorkspace();
		await seedMember(other.id, f.actor.id, "owner");
		const token = await issueToken(f);
		const response = await SELF.fetch("http://localhost/api/issues", { headers: authHeaders(token.token, other.slug) });
		expect(response.status).toBe(403);
		expect((await f.mcp(token.token, "list_projects", {}, other.id)).response.status).toBe(403);
	});

	it("expiry and human revocation end machine access without falling back to a browser login", async () => {
		const f = await setup();
		const token = await issueToken(f);
		await env.DB.prepare("UPDATE api_tokens SET expires_at = ? WHERE id = ?").bind(Math.floor(Date.now() / 1000) - 1, token.id).run();
		expect((await f.issue(token.token)).status).toBe(401);
		const fresh = await issueToken(f);
		const revoked = await asHuman(f.owner.user.email, () => SELF.fetch(`http://localhost/api/workspaces/${f.owner.workspace.slug}/tokens/${fresh.id}`, { method: "DELETE", headers: { "X-Workspace-Slug": f.owner.workspace.slug } }));
		expect(revoked.status).toBe(200);
		expect((await f.issue(fresh.token)).status).toBe(401);
	});
});
