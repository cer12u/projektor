import {
	formatIssueTimestamp,
	isIssueCompleted,
	issueTimestampDate,
	latestCompletionTime,
	newestResolutionEvents,
} from "../utils/issue-resolution";
import type { IssueData } from "./issue-detail-helpers";

export function IssueTimestamp({ value }: { value: number | null | undefined }) {
	const date = issueTimestampDate(value);
	const label = formatIssueTimestamp(value);
	return date ? <time dateTime={date.toISOString()}>{label}</time> : <span>{label}</span>;
}

export function IssueCompletionTimestamp({
	issue,
	value = issue.completed_at,
}: {
	issue: IssueData;
	value?: number | null;
}) {
	const observed =
		(issue.last_completed_at != null && value === issue.last_completed_at) ||
		(value === issue.completed_at && issue.completed_at_source === "observed") ||
		issue.resolution_history?.some(
			(event) => event.kind === "completed" && event.occurred_at === value
		);
	return (
		<>
			<IssueTimestamp value={value} />
			{issueTimestampDate(value) && !observed && (
				<span class="block text-xs text-text-muted">Legacy time (unverified)</span>
			)}
		</>
	);
}

const EVENT_LABELS = {
	completed: "Completed",
	reopened: "Reopened",
	cancelled: "Cancelled",
};

export function IssueResolutionHistory({ issue }: { issue: IssueData }) {
	const events = newestResolutionEvents(issue.resolution_history ?? []);
	const lastCompleted = latestCompletionTime(issue.completed_at, events, issue.last_completed_at);
	const isDone = isIssueCompleted(issue);

	return (
		<section class="mb-8" aria-label="Resolution history">
			<div class="flex items-center gap-3 mb-4">
				<h2 class="text-[0.7rem] font-semibold uppercase tracking-wider text-text-muted whitespace-nowrap">
					Resolution history
				</h2>
				<div class="flex-1 h-px bg-border" />
			</div>
			{(lastCompleted !== null || isDone) && (
				<p class="text-sm text-text-base mb-3">
					<span class="font-medium">Last completed: </span>
					<IssueCompletionTimestamp issue={issue} value={lastCompleted} />
				</p>
			)}
			{events.length > 0 ? (
				<ol
					class="list-none m-0 p-0 divide-y divide-border"
					aria-label="Resolution events, newest first"
				>
					{events.map((event) => (
						<li key={event.id} class="py-2 text-sm">
							<div class="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
								<span class="font-medium text-text-base">{EVENT_LABELS[event.kind]}</span>
								<span class="text-xs text-text-muted">
									<IssueTimestamp value={event.occurred_at} />
								</span>
							</div>
							<p class="text-xs text-text-muted mt-1 break-words">
								{event.from_status ?? "No previous status"} → {event.to_status}
							</p>
						</li>
					))}
				</ol>
			) : (
				<p class="text-sm text-text-muted">No recorded resolution events.</p>
			)}
			<p class="text-xs text-text-muted mt-3">
				{issue.resolution_history_has_more
					? `Showing the latest ${events.length} recorded events. Earlier events are not shown.`
					: "Older status changes may not have been recorded."}
			</p>
		</section>
	);
}
