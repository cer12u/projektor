import type { ServiceCtx } from "./types";

// Deliberately matches the existing status category OR legacy-key contract.
export function resolutionState(category: string | null | undefined, status: string): string {
	if (category === "done" || status === "done") return "completed";
	if (category === "cancelled" || status === "cancelled") return "cancelled";
	return "open";
}

// Read the actual row inside the mutation batch, never a pre-batch snapshot. D1
// serializes batches, so simultaneous identical closes produce exactly one event.
// Database time avoids delayed requests recording an earlier cycle's request time.
export const INSERT_RESOLUTION_TRANSITION_SQL = `
INSERT INTO issue_resolution_events
  (id, workspace_id, issue_id, occurred_at, kind, actor_id, from_status, to_status, auth_kind, auth_method)
SELECT ?1, workspace_id, id, unixepoch(),
  CASE WHEN ?2 = 'open' THEN 'reopened' ELSE ?2 END, ?3, status, ?4, ?7, ?8
FROM issues WHERE id = ?5 AND workspace_id = ?6
  AND (CASE WHEN status_category = 'done' OR status = 'done' THEN 'completed'
            WHEN status_category = 'cancelled' OR status = 'cancelled' THEN 'cancelled'
            ELSE 'open' END) <> ?2`;

export function buildResolutionTransitionStatement(
	ctx: ServiceCtx,
	issueId: string,
	status: string,
	category: string | null | undefined
): D1PreparedStatement {
	return ctx.db
		.prepare(INSERT_RESOLUTION_TRANSITION_SQL)
		.bind(
			crypto.randomUUID(),
			resolutionState(category, status),
			ctx.userId ?? null,
			status,
			issueId,
			ctx.workspaceId,
			ctx.auth?.kind ?? ctx.authKind ?? null,
			ctx.auth?.method ?? null
		);
}

export function buildInitialResolutionStatement(
	ctx: ServiceCtx,
	issueId: string,
	status: string,
	category: string | null | undefined,
	occurredAt: number
): D1PreparedStatement | null {
	const state = resolutionState(category, status);
	if (state === "open") return null;
	return ctx.db.prepare(`INSERT INTO issue_resolution_events
		(id, workspace_id, issue_id, occurred_at, kind, actor_id, from_status, to_status, auth_kind, auth_method)
		VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`).bind(
		crypto.randomUUID(), ctx.workspaceId, issueId, occurredAt, state, ctx.userId ?? null, status, ctx.auth?.kind ?? ctx.authKind ?? null, ctx.auth?.method ?? null
	);
}

// Taxonomy edits reclassify every issue using that custom status. Keep the bulk
// reclassification and its observed events atomic, without a row-scaled bind list.
export function buildCategoryResolutionStatements(
	ctx: ServiceCtx,
	statusId: string,
	category: string,
	occurredAt: number
): D1PreparedStatement[] {
	const oldState = `(CASE WHEN status_category = 'done' OR status = 'done' THEN 'completed'
		WHEN status_category = 'cancelled' OR status = 'cancelled' THEN 'cancelled' ELSE 'open' END)`;
	const newState = `(CASE WHEN ?1 = 'done' OR status = 'done' THEN 'completed'
		WHEN ?1 = 'cancelled' OR status = 'cancelled' THEN 'cancelled' ELSE 'open' END)`;
	return [
		ctx.db.prepare(`INSERT INTO issue_resolution_events
			(id, workspace_id, issue_id, occurred_at, kind, actor_id, auth_kind, auth_method, from_status, to_status)
			SELECT lower(hex(randomblob(16))), workspace_id, id, unixepoch(),
			CASE WHEN ${newState} = 'open' THEN 'reopened' ELSE ${newState} END,
			?2, ?3, ?4, status, status FROM issues
			WHERE status_id = ?5 AND workspace_id = ?6 AND ${oldState} <> ${newState}`)
			.bind(category, ctx.userId ?? null, ctx.auth?.kind ?? ctx.authKind ?? null,
				ctx.auth?.method ?? null, statusId, ctx.workspaceId),
		ctx.db.prepare(`UPDATE issues SET
			completed_at = CASE WHEN ${newState} = 'completed'
				THEN CASE WHEN ${oldState} = 'completed' THEN completed_at ELSE (SELECT occurred_at FROM issue_resolution_events e WHERE e.issue_id = issues.id AND e.workspace_id = issues.workspace_id ORDER BY sequence DESC LIMIT 1) END ELSE NULL END,
			done_at = CASE WHEN ${newState} = 'completed' AND ${oldState} <> 'completed'
				THEN COALESCE(done_at, (SELECT occurred_at FROM issue_resolution_events e WHERE e.issue_id = issues.id AND e.workspace_id = issues.workspace_id ORDER BY sequence DESC LIMIT 1)) ELSE done_at END,
			updated_at = CASE WHEN status_category <> ?1 THEN ?2 ELSE updated_at END,
			status_category = ?1 WHERE status_id = ?3 AND workspace_id = ?4`)
			.bind(category, occurredAt, statusId, ctx.workspaceId),
	];
}
