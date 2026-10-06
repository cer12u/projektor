import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import type { Env } from "@projektor/types";
import { describe, expect, it } from "vitest";
import worker from "../index";
import {
	authHeaders,
	seedCustomFieldDef,
	seedCustomFieldValue,
	seedIssue,
	seedMember,
	seedProject,
	seedToken,
	seedUser,
	seedWorkspace,
} from "./helpers";

// Local instrumentation only: real workerd, migrated D1 and the real limiter DO.
// No production binding is used. SQL bind values and credentials are never recorded.
// SQL statement counts are not D1 billed row counts. Timings are wall time, NOT CPU.
type StatementKind = "read" | "write";
type Statement = { sql: string; kind: StatementKind; boundParameters: number };
type Execution = Statement & { method: string };

function instrument(bindings: Env) {
	const prepared: Statement[] = [];
	const executed: Execution[] = [];
	const unwrapped = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
	const statements = new WeakMap<D1PreparedStatement, Statement>();
	const kv: Record<string, number> = {};
	let d1Calls = 0;
	let limiterCalls = 0;

	function wrapStatement(target: D1PreparedStatement, info: Statement): D1PreparedStatement {
		const wrapped = new Proxy(target, {
			get(statement, property) {
				const value = Reflect.get(statement, property);
				if (property === "bind") {
					return (...values: unknown[]) => {
						info.boundParameters = Math.max(info.boundParameters, values.length);
						return wrapStatement(statement.bind(...values), {
							...info,
							boundParameters: values.length,
						});
					};
				}
				if (["all", "first", "raw", "run"].includes(String(property))) {
					return (...args: unknown[]) => {
						d1Calls++;
						executed.push({ ...info, method: String(property) });
						return Reflect.apply(value, statement, args);
					};
				}
				return typeof value === "function" ? value.bind(statement) : value;
			},
		});
		unwrapped.set(wrapped, target);
		statements.set(wrapped, info);
		return wrapped;
	}

	const db = new Proxy(bindings.DB, {
		get(target, property) {
			if (property === "prepare") {
				return (sql: string) => {
					const normalized = sql.replace(/\s+/g, " ").trim();
					const kind: StatementKind = /^select\b/i.test(normalized) ? "read" : "write";
					// Fail loudly if a new SQL form needs classification rather than undercounting it.
					expect(normalized).toMatch(/^(select|insert|update|delete)\b/i);
					const info: Statement = { sql: normalized, kind, boundParameters: 0 };
					prepared.push(info);
					return wrapStatement(target.prepare(sql), info);
				};
			}
			if (property === "batch") {
				return (batch: D1PreparedStatement[]) => {
					d1Calls++;
					return target.batch(
						batch.map((statement) => {
							const info = statements.get(statement);
							const original = unwrapped.get(statement);
							if (!info || !original) throw new Error("Uninstrumented batch statement");
							executed.push({ ...info, method: "batch" });
							return original;
						})
					);
				};
			}
			if (property === "exec" || property === "withSession") {
				return () => {
					throw new Error(`Uninstrumented D1 operation: ${String(property)}`);
				};
			}
			const value = Reflect.get(target, property);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	const cache = new Proxy(bindings.KV, {
		get(target, property) {
			const value = Reflect.get(target, property);
			if (typeof value !== "function") return value;
			return (...args: unknown[]) => {
				kv[String(property)] = (kv[String(property)] ?? 0) + 1;
				return Reflect.apply(value, target, args);
			};
		},
	});
	if (!bindings.RATE_LIMITER) throw new Error("Real rate-limiter DO binding is required");
	const limiter = new Proxy(bindings.RATE_LIMITER, {
		get(target, property) {
			if (property === "get") {
				return (...args: Parameters<typeof target.get>) => {
					const stub = target.get(...args);
					return new Proxy(stub, {
						get(object, method) {
							const value = Reflect.get(object, method);
							if (method === "increment") {
								return (...callArgs: unknown[]) => {
									limiterCalls++;
									return Reflect.apply(value, object, callArgs);
								};
							}
							return typeof value === "function" ? value.bind(object) : value;
						},
					});
				};
			}
			const value = Reflect.get(target, property);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	return {
		bindings: { ...bindings, DB: db, KV: cache, RATE_LIMITER: limiter },
		report() {
			return {
				prepared: {
					read: prepared.filter((s) => s.kind === "read").length,
					write: prepared.filter((s) => s.kind === "write").length,
					total: prepared.length,
				},
				executed: {
					read: executed.filter((s) => s.kind === "read").length,
					write: executed.filter((s) => s.kind === "write").length,
					total: executed.length,
				},
				d1BindingCalls: d1Calls,
				maxBoundParameters: Math.max(0, ...executed.map((s) => s.boundParameters)),
				rateLimiterDoIncrementCalls: limiterCalls,
				d1RateLimitStatements: executed.filter((s) => /\brate_limit\b/.test(s.sql)).length,
				kvCalls: kv,
				statements: executed,
			};
		},
	};
}

type IssuePage = {
	items: { id: string; customFields?: unknown[] }[];
	nextCursor: string | null;
	total: number | null;
};
type McpResponse = {
	error?: unknown;
	result: { isError?: boolean; content: { type: string; text: string }[] };
};

function toolResult<T>(body: unknown): T {
	const rpc = body as McpResponse;
	expect(rpc.error).toBeUndefined();
	expect(rpc.result.isError).not.toBe(true);
	return JSON.parse(rpc.result.content[0]!.text) as T;
}

describe("local deployment budget for 50 projects and 500 tasks", () => {
	it("measures authenticated REST and MCP requests including background token auditing", async () => {
		const workspace = await seedWorkspace();
		const user = await seedUser(`budget-${crypto.randomUUID()}@example.test`);
		await seedMember(workspace.id, user.id, "owner");
		const token = await seedToken(workspace.id, user.id, { scopes: ["read"] });
		const field = await seedCustomFieldDef(workspace.id, { key: "budget-note" });
		const projectIds: string[] = [];
		for (let projectIndex = 0; projectIndex < 50; projectIndex++) {
			const project = await seedProject(workspace.id, `B${projectIndex}`);
			projectIds.push(project.id);
			let parentId: string | undefined;
			for (let issueIndex = 0; issueIndex < 10; issueIndex++) {
				const issue = await seedIssue(workspace.id, project.id, user.id, {
					title: `Synthetic project ${projectIndex} task ${issueIndex}`,
					status: issueIndex % 3 === 0 ? "done" : "todo",
					parentId,
				});
				if (issueIndex === 0) parentId = issue.id;
				await seedCustomFieldValue(issue.id, field.id, "synthetic-value");
			}
		}
		const fixtureCounts = await env.DB.prepare(
			"SELECT (SELECT count(*) FROM projects WHERE workspace_id = ?) AS projects, (SELECT count(*) FROM issues WHERE workspace_id = ?) AS tasks"
		)
			.bind(workspace.id, workspace.id)
			.first<{ projects: number; tasks: number }>();
		expect(fixtureCounts).toEqual({ projects: 50, tasks: 500 });
		const headers = authHeaders(token, workspace.slug);
		const measurements: unknown[] = [];
		// Use production's default request allowance, not the test fixture's five-hit cap.
		// Keep development mode solely for the isolated DO epoch and no real Access login.
		const bindings: Env = { ...env, RATE_LIMIT_API_MAX: "600" };

		async function measure(name: string, path: string, mcp?: { name: string; arguments: unknown }) {
			const tracked = instrument(bindings);
			const ctx = createExecutionContext();
			const start = performance.now();
			const response = await worker.fetch(
				new Request(`http://localhost${path}`, {
					method: mcp ? "POST" : "GET",
					headers,
					body: mcp
						? JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: mcp })
						: undefined,
				}),
				tracked.bindings,
				ctx
			);
			const responseText = await response.text();
			const responseWallMs = performance.now() - start;
			await waitOnExecutionContext(ctx);
			const completedWallMs = performance.now() - start;
			expect(response.status).toBe(200);
			const report = tracked.report();
			expect(report.executed.total).toBeGreaterThan(0);
			expect(report.executed.total).toBeLessThanOrEqual(50);
			expect(report.maxBoundParameters).toBeLessThanOrEqual(100);
			expect(report.rateLimiterDoIncrementCalls).toBe(1);
			expect(report.d1RateLimitStatements).toBe(0);
			const body = JSON.parse(responseText) as unknown;
			const data = mcp ? toolResult<unknown>(body) : body;
			const page = data as { items?: unknown[]; total?: number; truncated?: boolean };
			measurements.push({
				returnedItems: Array.isArray(data) ? data.length : page.items?.length,
				matchedTotal: page.total,
				mcpResponseCapped: page.truncated ?? false,
				name,
				status: response.status,
				responseBytes: new TextEncoder().encode(responseText).byteLength,
				responseWallMs,
				completedWallMs,
				...report,
			});
			return body;
		}

		const firstProjects = await measure("REST projects, first token use", "/api/projects");
		expect(firstProjects).toHaveLength(50);
		expect(await measure("REST projects, warm token", "/api/projects")).toHaveLength(50);
		const defaultPage = (await measure("REST issues, default page 30", "/api/issues")) as IssuePage;
		expect(defaultPage.items).toHaveLength(30);
		expect(defaultPage.total).toBe(500);
		expect(defaultPage.items.every((issue) => issue.customFields?.length === 1)).toBe(true);

		const seen = new Set<string>();
		let cursor: string | null = null;
		for (let pageNumber = 1; pageNumber <= 5; pageNumber++) {
			const suffix = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
			const page = (await measure(
				`REST issues, page ${pageNumber}/5, limit 100 with rollups`,
				`/api/issues?limit=100&includeRollups=1${suffix}`
			)) as IssuePage;
			expect(page.items).toHaveLength(100);
			expect(page.total).toBe(pageNumber === 1 ? 500 : null);
			for (const issue of page.items) seen.add(issue.id);
			cursor = page.nextCursor;
		}
		expect(seen.size).toBe(500);
		expect(cursor).toBeNull();
		const oneProject = (await measure(
			"REST issues, one project 10 tasks",
			`/api/issues?project=${projectIds[0]}`
		)) as IssuePage;
		expect(oneProject.items).toHaveLength(10);
		expect(oneProject.total).toBe(10);

		const mcpPath = `/mcp/${workspace.id}`;
		for (const temperature of ["cold project cache", "warm project cache"]) {
			const result = await measure(`MCP list_projects, ${temperature}`, mcpPath, {
				name: "list_projects",
				arguments: {},
			});
			expect(toolResult<unknown[]>(result)).toHaveLength(50);
		}
		const mcpIssues = await measure("MCP list_issues, limit 100 with rollups", mcpPath, {
			name: "list_issues",
			arguments: { limit: 100, includeRollups: true, verbose: true },
		});
		const mcpPage = toolResult<{
			items: unknown[];
			next?: string;
			truncated?: boolean;
			total: number;
		}>(mcpIssues);
		expect(mcpPage.items.length).toBeGreaterThan(0);
		expect(mcpPage.items.length).toBeLessThan(100);
		expect(mcpPage.total).toBe(500);
		expect(mcpPage.truncated).toBe(true);
		expect(mcpPage.next).toBeTruthy();

		console.log(
			`DEPLOYMENT_BUDGET_JSON=${JSON.stringify({
				fixture: {
					projects: 50,
					tasks: 500,
					customFieldValues: 500,
					parentIssues: 50,
					childrenPerParent: 9,
					role: "owner",
					authentication: "synthetic workspace-scoped read-only API token",
				},
				method:
					"Real Worker default fetch handler in vitest workerd with migrated local D1 and real RateLimiter Durable Object; fixture seeding excluded; execution-context background work awaited; no SQL bind values recorded",
				limitations: [
					"Wall timings are local elapsed time including I/O and instrumentation, not Cloudflare CPU time or billing",
					"Statement read/write counts are not D1 billed rows read/written",
					"No production Free-tier limit enforcement, network latency, concurrency or cold isolate startup benchmark",
					"Browser Access JWT and provisioning, OAuth, mutations, attachments, realtime, and scheduled purges are outside this test",
					"RateLimiter uses in-memory counters; this test counts RPCs, not Durable Object billing duration",
				],
				measurements,
			})}`
		);
	}, 30_000);
});
