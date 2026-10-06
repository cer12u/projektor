import { drizzle, schema } from "@projektor/db";
import { and, asc, eq, gt, gte, lt, or } from "drizzle-orm";
import { ListIssueResolutionEventsSchema } from "../schemas/issue-resolution";
import { visibleProjectPredicate } from "./access";
import { ValidationError } from "./errors";
import { resolveOptionalIssueId } from "./issue-ref";
import { resolveVisibleProjectIdParam } from "./projects";
import type { ServiceCtx } from "./types";

/**
 * Actual resolution transitions, ordered by (occurred_at, sequence), for a bounded UTC
 * window [after, before). These are point-in-time facts, not estimated work spans.
 * Both REST and MCP use this exact validation, visibility, and pagination path.
 */
export async function listIssueResolutionEvents(ctx: ServiceCtx, raw: unknown) {
	const result = ListIssueResolutionEventsSchema.safeParse(raw);
	if (!result.success) throw new ValidationError(result.error.flatten());
	const { after, before, cursor, limit } = result.data;
	const projectId = result.data.projectId
		? await resolveVisibleProjectIdParam(ctx, result.data.projectId)
		: undefined;
	const issueId = await resolveOptionalIssueId(ctx, result.data.issueId);
	const events = schema.issueResolutionEvents;
	const cursorAt = cursor === undefined ? undefined : Number(cursor.slice(0, cursor.indexOf(":")));
	const cursorSequence =
		cursor === undefined ? undefined : Number(cursor.slice(cursor.indexOf(":") + 1));
	const orm = drizzle(ctx.db, { schema });
	const rows = await orm
		.select({
			id: events.id,
			sequence: events.sequence,
			workspace_id: events.workspaceId,
			issue_id: events.issueId,
			occurred_at: events.occurredAt,
			kind: events.kind,
			actor_id: events.actorId,
			auth_kind: events.authKind,
			auth_method: events.authMethod,
			from_status: events.fromStatus,
			to_status: events.toStatus,
			issue_title: schema.issues.title,
			issue_number: schema.issues.number,
			project_id: schema.projects.id,
			project_key: schema.projects.key,
		})
		.from(events)
		.innerJoin(
			schema.issues,
			and(eq(events.issueId, schema.issues.id), eq(events.workspaceId, schema.issues.workspaceId))
		)
		.innerJoin(
			schema.projects,
			and(
				eq(schema.issues.projectId, schema.projects.id),
				eq(schema.issues.workspaceId, schema.projects.workspaceId)
			)
		)
		.where(
			and(
				eq(events.workspaceId, ctx.workspaceId),
				eq(schema.issues.workspaceId, ctx.workspaceId),
				eq(schema.projects.workspaceId, ctx.workspaceId),
				visibleProjectPredicate(ctx, schema.issues.projectId),
				gte(events.occurredAt, after),
				lt(events.occurredAt, before),
				projectId === undefined ? undefined : eq(schema.projects.id, projectId),
				issueId === undefined ? undefined : eq(events.issueId, issueId),
				cursorAt === undefined || cursorSequence === undefined
					? undefined
					: or(
							gt(events.occurredAt, cursorAt),
							and(eq(events.occurredAt, cursorAt), gt(events.sequence, cursorSequence))
						)
			)
		)
		.orderBy(asc(events.occurredAt), asc(events.sequence))
		.limit(limit + 1);

	const items = rows.slice(0, limit).map((row) => ({
		...row,
		issue_ref: `${row.project_key}-${row.issue_number}`,
	}));
	const last = items.at(-1);
	return {
		items,
		nextCursor: rows.length > limit && last ? `${last.occurred_at}:${last.sequence}` : null,
	};
}
