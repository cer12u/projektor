import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import type { Env } from "@projektor/types";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../index";
import { resetAuthCachesForTests } from "../middleware/auth";
import { ConflictError } from "../services/errors";
import {
	ensureUserProvisioned,
	forgetProvisionedForTests,
	resetProvisioningCacheForTests,
} from "../services/provisioning";
import { createWorkspace } from "../services/workspaces";
import { seedUser } from "./helpers";

beforeEach(resetProvisioningCacheForTests);

type Hooks = {
	afterRead?: (sql: string, result: unknown) => Promise<void>;
	beforeExecute?: (sql: string) => Promise<void>;
	beforeBatch?: () => Promise<void>;
};

// Real workerd/D1 statements with only scheduling and failure-injection hooks.
// Do not record bound values. Unwrap statements before D1.batch receives them.
function instrumentDb(db: D1Database, hooks: Hooks = {}) {
	const originals = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
	const statements: string[] = [];
	let batchCalls = 0;
	function wrap(statement: D1PreparedStatement, sql: string): D1PreparedStatement {
		const proxy = new Proxy(statement, {
			get(target, property) {
				if (property === "bind") {
					return (...values: unknown[]) => wrap(target.bind(...values), sql);
				}
				const value = Reflect.get(target, property);
				if (["raw", "all", "first", "run"].includes(String(property))) {
					return async (...args: unknown[]) => {
						await hooks.beforeExecute?.(sql);
						statements.push(sql);
						const result = await Reflect.apply(value, target, args);
						await hooks.afterRead?.(sql, result);
						return result;
					};
				}
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		originals.set(proxy, statement);
		return proxy;
	}
	const proxy = new Proxy(db, {
		get(target, property) {
			if (property === "prepare") {
				return (sql: string) => wrap(target.prepare(sql), sql);
			}
			if (property === "batch") {
				return async (batch: D1PreparedStatement[]) => {
					await hooks.beforeBatch?.();
					batchCalls++;
					return target.batch(batch.map((statement) => originals.get(statement) ?? statement));
				};
			}
			const value = Reflect.get(target, property);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	return { db: proxy, statements, batchCalls: () => batchCalls };
}

function emptySlugBarrier(participants: number) {
	let arrived = 0;
	let release: () => void = () => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	return {
		async afterRead(sql: string, result: unknown) {
			if (
				/^select "id" from "workspaces" where "workspaces"\."slug" = \?$/.test(sql) &&
				Array.isArray(result) &&
				result.length === 0
			) {
				arrived++;
				if (arrived === participants) release();
				await gate;
			}
		},
		arrived: () => arrived,
	};
}

function newSlug() {
	return `race-${crypto.randomUUID().slice(0, 8)}`;
}

function config(db: D1Database, slug: string, emails: string[]): Env {
	return {
		...(env as unknown as Env),
		DB: db,
		ADMIN_EMAILS: emails.join(","),
		DEFAULT_WORKSPACE_SLUG: slug,
		DEFAULT_WORKSPACE_NAME: "Concurrency fixture",
		AUTO_JOIN_ROLE: "none",
	};
}

async function workspaceState(slug: string) {
	const workspace = await env.DB.prepare("SELECT id FROM workspaces WHERE slug = ?")
		.bind(slug)
		.first<{ id: string }>();
	if (!workspace) return null;
	const counts: Record<string, number> = {};
	for (const table of [
		"workspace_members",
		"task_types",
		"task_statuses",
		"custom_field_definitions",
		"wiki_pages",
	]) {
		counts[table] =
			(await env.DB.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE workspace_id = ?`)
				.bind(workspace.id)
				.first<number>("count")) ?? 0;
	}
	const { results } = await env.DB.prepare(
		"SELECT user_id, role FROM workspace_members WHERE workspace_id = ? ORDER BY user_id"
	)
		.bind(workspace.id)
		.all<{ user_id: string; role: string }>();
	return { id: workspace.id, counts, members: results };
}

function expectDefaults(state: Awaited<ReturnType<typeof workspaceState>>, members: number) {
	expect(state?.counts).toEqual({
		workspace_members: members,
		task_types: 4,
		task_statuses: 6,
		custom_field_definitions: 1,
		wiki_pages: 4,
	});
	expect(state?.members.every((member) => member.role === "owner")).toBe(true);
}

async function newAdmin() {
	return seedUser(`race-${crypto.randomUUID()}@example.invalid`);
}

describe("first-admin provisioning concurrency", () => {
	it("settles four same-admin cold requests after all miss the slug, with one complete workspace", async () => {
		const admin = await newAdmin();
		const slug = newSlug();
		const barrier = emptySlugBarrier(4);
		const wrapped = instrumentDb(env.DB, barrier);
		const bindings = config(wrapped.db, slug, [admin.email]);
		const outcomes = await Promise.allSettled(
			Array.from({ length: 4 }, () => ensureUserProvisioned(bindings, admin))
		);
		expect(barrier.arrived()).toBe(4);
		expect(outcomes.map((result) => result.status)).toEqual(Array(4).fill("fulfilled"));
		expect(wrapped.batchCalls()).toBe(4);
		expectDefaults(await workspaceState(slug), 1);
	});

	it("serves concurrent first-login project and account requests successfully through the real Worker", async () => {
		resetAuthCachesForTests();
		const admin = await newAdmin();
		const slug = newSlug();
		const paths = ["/api/projects", "/auth/me", "/api/projects", "/auth/me"];
		const barrier = emptySlugBarrier(paths.length);
		const wrapped = instrumentDb(env.DB, barrier);
		const bindings: Env = {
			...config(wrapped.db, slug, [admin.email]),
			ENVIRONMENT: "development",
			DEV_USER_EMAIL: admin.email,
		};
		const responses = await Promise.all(
			paths.map(async (path) => {
				const context = createExecutionContext();
				const response = await worker.fetch(
					new Request(`http://localhost${path}`),
					bindings,
					context
				);
				await waitOnExecutionContext(context);
				return response;
			})
		);
		expect(barrier.arrived()).toBe(4);
		expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 200]);
		for (const [index, response] of responses.entries()) {
			const body = await response.json();
			if (paths[index] === "/api/projects") expect(body).toEqual([]);
			else expect(body).toMatchObject({ user: { id: admin.id } });
		}
		expectDefaults(await workspaceState(slug), 1);
	});

	it("settles distinct-admin cold requests, grants both owners and seeds defaults only once", async () => {
		const admins = await Promise.all([newAdmin(), newAdmin()]);
		const slug = newSlug();
		const barrier = emptySlugBarrier(2);
		const wrapped = instrumentDb(env.DB, barrier);
		const bindings = config(
			wrapped.db,
			slug,
			admins.map((admin) => admin.email)
		);
		const outcomes = await Promise.allSettled(
			admins.map((admin) => ensureUserProvisioned(bindings, admin))
		);
		expect(barrier.arrived()).toBe(2);
		expect(outcomes.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
		const state = await workspaceState(slug);
		expectDefaults(state, 2);
		expect(state?.members.map((member) => member.user_id).sort()).toEqual(
			admins.map((admin) => admin.id).sort()
		);
	});

	it("keeps direct concurrent createWorkspace losers as typed conflicts, without phantom memberships", async () => {
		const admins = await Promise.all([newAdmin(), newAdmin()]);
		const slug = newSlug();
		const barrier = emptySlugBarrier(2);
		const wrapped = instrumentDb(env.DB, barrier);
		const outcomes = await Promise.allSettled(
			admins.map((admin) => createWorkspace(wrapped.db, admin.id, { name: "Race", slug }))
		);
		expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		const rejected = outcomes.find((result) => result.status === "rejected");
		expect(rejected?.status === "rejected" && rejected.reason instanceof ConflictError).toBe(true);
		expectDefaults(await workspaceState(slug), 1);
	});

	it("rolls back the workspace when the creator membership fails its real D1 foreign key", async () => {
		const slug = newSlug();
		const outcome = await Promise.allSettled([
			createWorkspace(env.DB, crypto.randomUUID(), { name: "Invalid creator", slug }),
		]);
		const failure = outcome[0];
		expect(failure.status).toBe("rejected");
		if (failure.status !== "rejected") throw new Error("Expected membership FK failure");
		expect(failure.reason).not.toBeInstanceOf(ConflictError);
		expect(String(failure.reason)).toMatch(/FOREIGN KEY constraint failed/);
		expect(await workspaceState(slug)).toBeNull();
		const admin = await newAdmin();
		await createWorkspace(env.DB, admin.id, { name: "Valid creator", slug });
		expectDefaults(await workspaceState(slug), 1);
	});

	it("propagates an unrelated injected batch outage, leaves no marker, and permits retry", async () => {
		const admin = await newAdmin();
		const slug = newSlug();
		const failure = new Error("Injected local D1 batch outage");
		const wrapped = instrumentDb(env.DB, {
			beforeBatch: async () => {
				// Reject after the D1 promise is wired up, as a real binding outage does.
				await new Promise((resolve) => setTimeout(resolve, 0));
				throw failure;
			},
		});
		await expect(
			ensureUserProvisioned(config(wrapped.db, slug, [admin.email]), admin)
		).rejects.toBe(failure);
		expect(await workspaceState(slug)).toBeNull();
		expect(await env.KV.get(`provisioned:${admin.id}`)).toBeNull();
		await ensureUserProvisioned(config(env.DB, slug, [admin.email]), admin);
		expectDefaults(await workspaceState(slug), 1);
	});

	it("does not claim rollback or suppress a seed failure after the atomic workspace/member pair", async () => {
		const admin = await newAdmin();
		const slug = newSlug();
		const failure = new Error("Injected local task-type seed outage");
		const wrapped = instrumentDb(env.DB, {
			beforeExecute: async (sql) => {
				if (sql.startsWith('insert into "task_types"')) {
					await new Promise((resolve) => setTimeout(resolve, 0));
					throw failure;
				}
			},
		});
		const outcome = await Promise.allSettled([
			ensureUserProvisioned(config(wrapped.db, slug, [admin.email]), admin),
		]);
		const rejected = outcome[0];
		expect(rejected.status).toBe("rejected");
		if (rejected.status !== "rejected") throw new Error("Expected seed failure");
		expect(rejected.reason).not.toBeInstanceOf(ConflictError);
		expect(rejected.reason.cause).toBe(failure);
		expect((await workspaceState(slug))?.counts).toEqual({
			workspace_members: 1,
			task_types: 0,
			task_statuses: 0,
			custom_field_definitions: 0,
			wiki_pages: 0,
		});
		expect(await env.KV.get(`provisioned:${admin.id}`)).toBeNull();
		// Defaults are deliberately outside this narrowly scoped atomic pair. Do not
		// erase a now-visible workspace as compensation: another request may use it.
	});

	it("re-enters an existing owner workspace without reseeding, duplication, or a create batch", async () => {
		const admin = await newAdmin();
		const slug = newSlug();
		const bindings = config(env.DB, slug, [admin.email]);
		await ensureUserProvisioned(bindings, admin);
		const before = await workspaceState(slug);
		await forgetProvisionedForTests(bindings, admin.id);
		const wrapped = instrumentDb(env.DB);
		await ensureUserProvisioned({ ...bindings, DB: wrapped.db }, admin);
		expect(await workspaceState(slug)).toEqual(before);
		expect(wrapped.batchCalls()).toBe(0);
		expect(wrapped.statements).toHaveLength(1);
	});
});
