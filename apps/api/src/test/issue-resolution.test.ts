import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createIssue, getIssue, updateIssue } from "../services/issues";
import { updateTaskStatus } from "../services/task-statuses";
import type { ServiceCtx } from "../services/types";
import { seedIssueFixture, seedTaskStatus } from "./helpers";

async function fixture() {
	const f = await seedIssueFixture({ role: "owner" });
	const ctx: ServiceCtx = {
		db: env.DB, kv: env.KV, r2: env.R2,
		workspaceId: f.workspaceId, userId: f.userId, role: "owner",
		auth: { kind: "agent", method: "pk" },
	};
	return { ...f, ctx };
}

async function events(ctx: ServiceCtx, id: string) {
	return (await env.DB.prepare("SELECT * FROM issue_resolution_events WHERE workspace_id = ? AND issue_id = ? ORDER BY sequence")
		.bind(ctx.workspaceId, id).all()).results;
}

async function times(id: string) {
	return env.DB.prepare("SELECT completed_at, done_at FROM issues WHERE id = ?")
		.bind(id).first<{ completed_at: number | null; done_at: number | null }>();
}

describe("durable issue resolution", () => {
	it("retains completion/reopen/re-completion history and authenticated actor", async () => {
		const { ctx, issueId } = await fixture();
		await updateIssue(ctx, issueId, { status: "done" });
		const first = await times(issueId);
		await updateIssue(ctx, issueId, { status: "done" });
		expect(await times(issueId)).toEqual(first);
		await updateIssue(ctx, issueId, { status: "todo" });
		expect((await times(issueId))?.completed_at).toBeNull();
		await updateIssue(ctx, issueId, { status: "done" });
		const history = await events(ctx, issueId);
		expect(history.map((e) => e.kind)).toEqual(["completed", "reopened", "completed"]);
		expect(history.every((e) => e.actor_id === ctx.userId && e.auth_kind === "agent")).toBe(true);
		expect((await times(issueId))?.done_at).toBe(first?.done_at);
		expect((await getIssue(ctx, { id: issueId })).resolution_history).toHaveLength(3);
	});

	it("does not fabricate legacy unknown completion time or history on a repeat", async () => {
		const { ctx, issueId } = await fixture();
		await env.DB.prepare("UPDATE issues SET status = 'done', status_category = 'done' WHERE id = ?").bind(issueId).run();
		await updateIssue(ctx, issueId, { status: "done" });
		expect(await times(issueId)).toEqual({ completed_at: null, done_at: null });
		expect(await events(ctx, issueId)).toHaveLength(0);
	});

	it("distinguishes cancellation and custom done statuses", async () => {
		const { ctx, issueId } = await fixture();
		const status = await seedTaskStatus(ctx.workspaceId, { key: "shipped", category: "done" });
		await updateIssue(ctx, issueId, { statusId: status.id });
		await updateIssue(ctx, issueId, { status: "cancelled" });
		expect((await times(issueId))?.completed_at).toBeNull();
		await updateIssue(ctx, issueId, { status: "todo" });
		expect((await events(ctx, issueId)).map((e) => e.kind)).toEqual(["completed", "cancelled", "reopened"]);
	});

	it("records terminal creation and rejects client-invented completion fields", async () => {
		const { ctx, projectId } = await fixture();
		const issue = await createIssue(ctx, { projectId, title: "Created complete", status: "done" });
		expect((await times(issue.id))?.completed_at).toBeTypeOf("number");
		expect((await events(ctx, issue.id))[0]?.from_status).toBeNull();
		await expect(updateIssue(ctx, issue.id, { completedAt: 1, actorId: "forged" })).rejects.toThrow();
	});

	it("serializes simultaneous repeated closes into a single durable event", async () => {
		const { ctx, issueId } = await fixture();
		await Promise.all([
			updateIssue(ctx, issueId, { status: "done" }),
			updateIssue(ctx, issueId, { status: "done" }),
		]);
		expect(await events(ctx, issueId)).toHaveLength(1);
		const event = (await events(ctx, issueId))[0];
		expect((await times(issueId))?.completed_at).toBe(event?.occurred_at);
	});
	it("records bulk custom-category reclassification atomically", async () => {
		const { ctx, issueId } = await fixture();
		const status = await seedTaskStatus(ctx.workspaceId, { key: "custom", category: "todo" });
		await updateIssue(ctx, issueId, { statusId: status.id });
		await updateTaskStatus(ctx, status.id, { category: "done" });
		const first = await times(issueId);
		expect(first?.completed_at).toBeTypeOf("number");
		await updateTaskStatus(ctx, status.id, { category: "done" });
		expect(await times(issueId)).toEqual(first);
		await updateTaskStatus(ctx, status.id, { category: "todo" });
		expect((await times(issueId))?.completed_at).toBeNull();
		expect((await events(ctx, issueId)).map((event) => event.kind)).toEqual(["completed", "reopened"]);
	});

	it("keeps the latest observed completion available beyond the history preview", async () => {
		const { ctx, issueId } = await fixture();
		await updateIssue(ctx, issueId, { status: "done" });
		const completed = (await times(issueId))?.completed_at;
		await updateIssue(ctx, issueId, { status: "todo" });
		for (let i = 0; i < 11; i++) {
			await updateIssue(ctx, issueId, { status: "cancelled" });
			await updateIssue(ctx, issueId, { status: "todo" });
		}
		const issue = await getIssue(ctx, { id: issueId });
		expect(issue.last_completed_at).toBe(completed);
		expect(issue.resolution_history_has_more).toBe(true);
		expect(issue.resolution_history).toHaveLength(20);
	});

});
