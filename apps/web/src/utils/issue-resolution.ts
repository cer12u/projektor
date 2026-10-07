/** Resolution timestamps come from the server in Unix seconds, never browser-local time. */
export const ISSUE_TIME_ZONE = "Asia/Tokyo";

export interface IssueResolutionEvent {
	id: string;
	sequence?: number;
	issue_id: string;
	occurred_at: number;
	kind: "completed" | "reopened" | "cancelled";
	actor_id: string | null;
	from_status: string | null;
	to_status: string;
}

export function isIssueCompleted(issue: {
	status?: string;
	status_key?: string | null;
	status_category?: string | null;
}): boolean {
	return issue.status_category === "done" || issue.status_key === "done" || issue.status === "done";
}

export function issueTimestampDate(unixSeconds: number | null | undefined): Date | null {
	// Do not coerce a missing timestamp to the Unix epoch, or treat the valid epoch as missing.
	if (unixSeconds == null || !Number.isFinite(unixSeconds)) return null;
	const date = new Date(unixSeconds * 1000);
	return Number.isNaN(date.getTime()) ? null : date;
}

export function formatIssueTimestamp(
	unixSeconds: number | null | undefined,
	timeZone = ISSUE_TIME_ZONE
): string {
	const date = issueTimestampDate(unixSeconds);
	if (!date) return "Unknown (not recorded)";
	const parts = new Intl.DateTimeFormat("en-GB", {
		timeZone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
	}).formatToParts(date);
	const part = (type: Intl.DateTimeFormatPartTypes) =>
		parts.find((value) => value.type === type)?.value;
	return `${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")} ${timeZone}`;
}

/** Sort a copy: rendering must not mutate the API response used by sibling components. */
export function newestResolutionEvents(
	events: readonly IssueResolutionEvent[]
): IssueResolutionEvent[] {
	return [...events].sort(
		(a, b) => b.occurred_at - a.occurred_at || (b.sequence ?? 0) - (a.sequence ?? 0)
	);
}

/** Prefer the full ledger summary; older APIs can fall back to current/recent completion data. */
export function latestCompletionTime(
	completedAt: number | null | undefined,
	events: readonly IssueResolutionEvent[],
	lastCompletedAt?: number | null
): number | null {
	if (lastCompletedAt != null && issueTimestampDate(lastCompletedAt)) return lastCompletedAt;
	let latest = issueTimestampDate(completedAt) ? (completedAt ?? null) : null;
	for (const event of events) {
		if (
			event.kind === "completed" &&
			issueTimestampDate(event.occurred_at) &&
			(latest === null || event.occurred_at > latest)
		) {
			latest = event.occurred_at;
		}
	}
	return latest;
}
