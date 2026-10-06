import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
	authHeaders,
	hashToken,
	seedGroupGrant,
	seedMember,
	seedProject,
	seedToken,
	seedUser,
	seedUserToken,
	seedWorkspace,
} from "./helpers";

async function fixture(role = "owner", scopes = ["read", "write"]) {
	const a = await seedWorkspace();
	const b = await seedWorkspace();
	const user = await seedUser(`isolation-${crypto.randomUUID()}@example.com`);
	await seedMember(a.id, user.id, role);
	await seedMember(b.id, user.id, "owner");
	const pa = await seedProject(a.id, "AAA");
	const pb = await seedProject(b.id, "BBB");
	const seeded = await seedToken(a.id, user.id, { scopes });
	// Exercise the production pk_ prefix as well as actual D1 token authentication.
	const token = `pk_${crypto.randomUUID().replace(/-/g, "")}`;
	await env.DB.prepare("UPDATE api_tokens SET token_hash = ? WHERE token_hash = ?")
		.bind(await hashToken(token), await hashToken(seeded))
		.run();
	return { a, b, pa, pb, user, token };
}

async function getIds(path: string, token: string, slug?: string) {
	const res = await SELF.fetch(`http://localhost${path}`, {
		headers: slug ? authHeaders(token, slug) : { Authorization: `Bearer ${token}` },
	});
	expect(res.status).toBe(200);
	return ((await res.json()) as Array<{ id: string }>).map((row) => row.id).sort();
}

async function mcp(workspaceId: string, token: string, name: string, args = {}) {
	const res = await SELF.fetch(`http://localhost/mcp/${workspaceId}`, {
		method: "POST",
		headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: { name, arguments: args },
		}),
	});
	return {
		status: res.status,
		body: (await res.json()) as { result: { isError?: boolean; content: Array<{ text: string }> } },
	};
}

describe("workspace-scoped credential confinement", () => {
	it.each(["/api/workspaces", "/api/projects"])(
		"%s does not enumerate the user's other workspace",
		async (path) => {
			const f = await fixture();
			const expected = path.endsWith("projects") ? f.pa.id : f.a.id;
			expect(await getIds(path, f.token)).toEqual([expected]);
			// A header cannot widen the authenticated credential's scope on a global list.
			expect(await getIds(path, f.token, f.b.slug)).toEqual([expected]);
		}
	);

	it("/auth/me confines its nested workspace memberships", async () => {
		const f = await fixture();
		const res = await SELF.fetch("http://localhost/auth/me", {
			headers: authHeaders(f.token, f.b.slug),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { workspaces: Array<{ id: string }> };
		expect(body.workspaces.map((row) => row.id)).toEqual([f.a.id]);
	});

	it("includeArchived does not widen the token workspace", async () => {
		const f = await fixture();
		await env.DB.prepare("UPDATE projects SET archived_at = ? WHERE id IN (?, ?)")
			.bind(Math.floor(Date.now() / 1000), f.pa.id, f.pb.id)
			.run();
		expect(await getIds("/api/projects", f.token)).toEqual([]);
		expect(await getIds("/api/projects?includeArchived=true", f.token)).toEqual([f.pa.id]);
	});

	it("MCP list_workspaces returns only the credential workspace", async () => {
		const f = await fixture();
		const result = await mcp(f.a.id, f.token, "list_workspaces");
		expect(result.status).toBe(200);
		expect(result.body.result.isError).not.toBe(true);
		const rows = JSON.parse(result.body.result.content[0].text) as Array<{ id: string }>;
		expect(rows.map((row) => row.id)).toEqual([f.a.id]);
	});

	it("membership removal takes effect on both global lists", async () => {
		const f = await fixture();
		await env.DB.prepare("DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?")
			.bind(f.a.id, f.user.id)
			.run();
		expect(await getIds("/api/workspaces", f.token)).toEqual([]);
		expect(await getIds("/api/projects", f.token)).toEqual([]);
	});

	it("project group grants still restrict non-admin tokens", async () => {
		const f = await fixture("viewer", ["read"]);
		expect(await getIds("/api/projects", f.token)).toEqual([]);
		await seedGroupGrant(f.a.id, f.user.id, f.pa.id, "viewer");
		expect(await getIds("/api/projects", f.token)).toEqual([f.pa.id]);
	});

	it("REST workspace creation cannot escape a workspace credential", async () => {
		const f = await fixture();
		const slug = `escape-${crypto.randomUUID()}`;
		const res = await SELF.fetch("http://localhost/api/workspaces", {
			method: "POST",
			headers: authHeaders(f.token, f.a.slug),
			body: JSON.stringify({ name: "Forbidden workspace", slug }),
		});
		expect(res.status).toBe(403);
		expect(
			await env.DB.prepare("SELECT id FROM workspaces WHERE slug = ?").bind(slug).first()
		).toBeNull();
	});

	it("MCP workspace creation cannot escape a workspace credential", async () => {
		const f = await fixture();
		const slug = `escape-${crypto.randomUUID()}`;
		const res = await mcp(f.a.id, f.token, "create_workspace", {
			name: "Forbidden workspace",
			slug,
		});
		expect(res.body.result.isError).toBe(true);
		expect(
			await env.DB.prepare("SELECT id FROM workspaces WHERE slug = ?").bind(slug).first()
		).toBeNull();
	});

	it("cross-workspace direct REST and MCP requests remain forbidden", async () => {
		const f = await fixture();
		const res = await SELF.fetch(`http://localhost/api/projects/${f.pb.id}`, {
			headers: authHeaders(f.token, f.b.slug),
		});
		expect(res.status).toBe(403);
		expect((await mcp(f.b.id, f.token, "list_projects")).status).toBe(403);
	});

	it("read-only tokens cannot write and writable owner tokens still can", async () => {
		const f = await fixture("owner", ["read"]);
		const res = await SELF.fetch(`http://localhost/api/projects/${f.pa.id}`, {
			method: "PATCH",
			headers: authHeaders(f.token, f.a.slug),
			body: JSON.stringify({ name: "Blocked" }),
		});
		expect(res.status).toBe(403);
		const writeToken = await seedToken(f.a.id, f.user.id, { scopes: ["read", "write"] });
		const allowed = await SELF.fetch(`http://localhost/api/projects/${f.pa.id}`, {
			method: "PATCH",
			headers: authHeaders(writeToken, f.a.slug),
			body: JSON.stringify({ name: "Allowed" }),
		});
		expect(allowed.status).toBe(200);
	});

	it("personal tokens preserve cross-workspace listing and workspace creation", async () => {
		const f = await fixture();
		const personal = await seedUserToken(f.user.id);
		expect(await getIds("/api/workspaces", personal)).toEqual([f.a.id, f.b.id].sort());
		expect(await getIds("/api/projects", personal)).toEqual([f.pa.id, f.pb.id].sort());
		const result = await mcp(f.a.id, personal, "list_workspaces");
		const rows = JSON.parse(result.body.result.content[0].text) as Array<{ id: string }>;
		expect(rows.map((row) => row.id).sort()).toEqual([f.a.id, f.b.id].sort());
		const created = await SELF.fetch("http://localhost/api/workspaces", {
			method: "POST",
			headers: authHeaders(personal, f.a.slug),
			body: JSON.stringify({ name: "Personal allowed", slug: `personal-${crypto.randomUUID()}` }),
		});
		expect(created.status).toBe(201);
	});

	it("a signed-in owner preserves the cross-workspace browser view", async () => {
		const f = await fixture();
		const previous = env.DEV_USER_EMAIL;
		env.DEV_USER_EMAIL = f.user.email;
		try {
			for (const path of ["/api/workspaces", "/api/projects"]) {
				const res = await SELF.fetch(`http://localhost${path}`);
				expect(res.status).toBe(200);
				const ids = ((await res.json()) as Array<{ id: string }>).map((row) => row.id);
				expect(ids).toContain(path.endsWith("projects") ? f.pb.id : f.b.id);
			}
		} finally {
			env.DEV_USER_EMAIL = previous;
		}
	});
});
