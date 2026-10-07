import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import type { Env } from "@projektor/types";
import { describe, expect, it } from "vitest";
import worker from "../index";
import { seedMember, seedToken, seedUser, seedUserToken, seedWorkspace } from "./helpers";

const SHELL_HTML = `<!doctype html><html><head><title>Wiki — Projektor</title>
<meta property="og:title" content="Projektor" />
<meta property="og:description" content="Public shell" />
<meta property="og:url" content="https://example.test/wiki/view" />
</head><body>Static wiki shell</body></html>`;

async function seedWikiFixture() {
	const user = await seedUser(`wiki-scope-${crypto.randomUUID()}@example.test`);
	const own = await seedWorkspace();
	const other = await seedWorkspace();
	await seedMember(own.id, user.id, "owner");
	await seedMember(other.id, user.id, "owner");
	const token = await seedToken(own.id, user.id, { scopes: ["read"] });
	const page = {
		id: crypto.randomUUID(),
		slug: "private-runbook",
		title: "Other workspace confidential runbook",
		content: "Other workspace confidential deployment instructions",
	};
	const now = Math.floor(Date.now() / 1000);
	await env.DB.prepare(
		`INSERT INTO wiki_pages
		 (id, workspace_id, slug, title, content, created_by_id, updated_by_id, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
	)
		.bind(page.id, other.id, page.slug, page.title, page.content, user.id, user.id, now, now)
		.run();
	return { user, own, other, token, page };
}

async function wikiRequest(
	path: string,
	headers: Record<string, string>,
	overrides: Partial<Env> = {}
) {
	const ctx = createExecutionContext();
	const response = await worker.fetch(
		new Request(`http://localhost${path}`, { headers }),
		{
			...env,
			ASSETS: {
				fetch: async () => new Response(SHELL_HTML, { headers: { "Content-Type": "text/html" } }),
				connect: () => {
					throw new Error("Not used by static asset fixture");
				},
			},
			...overrides,
		},
		ctx
	);
	await waitOnExecutionContext(ctx);
	return response;
}

describe("wiki SSR workspace-token confinement", () => {
	it.each(["header", "default", "subdomain"])(
		"serves only the static shell when the %s resolves another workspace",
		async (target) => {
			const { token, other, page } = await seedWikiFixture();
			const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
			const overrides: Partial<Env> = {};
			if (target === "header") headers["X-Workspace-Slug"] = other.slug;
			if (target === "default") overrides.DEFAULT_WORKSPACE_SLUG = other.slug;
			if (target === "subdomain") {
				headers.Host = `${other.slug}.example.test`;
				overrides.WORKSPACE_SUBDOMAIN_ROUTING = "true";
			}

			const response = await wikiRequest(`/wiki/${page.slug}`, headers, overrides);
			expect(response.status).toBe(200);
			expect(await response.text()).toBe(SHELL_HTML);
		}
	);

	it("does not disclose another workspace's canonical URL through the legacy redirect", async () => {
		const { token, other, page } = await seedWikiFixture();
		const response = await wikiRequest(`/wiki?slug=${page.id}`, {
			Authorization: `Bearer ${token}`,
			"X-Workspace-Slug": other.slug,
		});
		expect(response.status).toBe(200);
		expect(response.headers.get("Location")).toBeNull();
		expect(await response.text()).toBe(SHELL_HTML);
	});

	it("still injects wiki metadata for a token confined to the requested workspace", async () => {
		const { user, other, page } = await seedWikiFixture();
		const token = await seedToken(other.id, user.id, { scopes: ["read"] });
		const response = await wikiRequest(`/wiki/${page.slug}`, {
			Authorization: `Bearer ${token}`,
			"X-Workspace-Slug": other.slug,
		});
		expect(response.status).toBe(200);
		const html = await response.text();
		expect(html).toContain(`<title>${page.title} — Projektor Wiki</title>`);
		expect(html).toContain(`content="${page.content}"`);
	});

	it("preserves user-scoped token access to a workspace the user belongs to", async () => {
		const { user, other, page } = await seedWikiFixture();
		const token = await seedUserToken(user.id, { scopes: ["read"] });
		const response = await wikiRequest(`/wiki/${page.slug}`, {
			Authorization: `Bearer ${token}`,
			"X-Workspace-Slug": other.slug,
		});
		expect(response.status).toBe(200);
		expect(await response.text()).toContain(`<title>${page.title} — Projektor Wiki</title>`);
	});

	it("keeps the shell free of wiki metadata for unauthenticated requests", async () => {
		const { other, page } = await seedWikiFixture();
		const response = await wikiRequest(`/wiki/${page.slug}`, {
			"X-Workspace-Slug": other.slug,
		});
		expect(response.status).toBe(200);
		expect(await response.text()).toBe(SHELL_HTML);
	});
});
