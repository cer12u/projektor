import { render, screen, within } from "@testing-library/preact";
import { describe, expect, it } from "vitest";
import type { IssueResolutionEvent } from "../utils/issue-resolution";
import { SidebarPanel } from "./IssueDetailParts";
import { IssueResolutionHistory, IssueTimestamp } from "./IssueResolutionHistory";
import type { IssueData } from "./issue-detail-helpers";

const BEFORE_MIDNIGHT = Date.parse("2026-10-06T14:59:00Z") / 1000;
const AFTER_MIDNIGHT = Date.parse("2026-10-06T15:05:00Z") / 1000;
const ISSUE: IssueData = {
	id: "i1",
	number: 1,
	title: "Completed task",
	body: null,
	priority: "none",
	assignee_id: null,
	assignee_name: null,
	parent_id: null,
	project_key: "PROJ",
	project_name: "Project",
	type_id: null,
	type_key: null,
	type_name: null,
	status_id: "done",
	status_key: "done",
	status_name: "Done",
	status_category: "done",
	created_at: BEFORE_MIDNIGHT,
	updated_at: AFTER_MIDNIGHT,
	completed_at: AFTER_MIDNIGHT,
	completed_at_source: "observed",
	resolution_history: [],
	customFields: [],
};

const COMPLETED: IssueResolutionEvent = {
	id: "completed",
	issue_id: ISSUE.id,
	occurred_at: BEFORE_MIDNIGHT,
	kind: "completed",
	actor_id: null,
	from_status: "in_progress",
	to_status: "done",
};

function renderSidebar(issue: IssueData) {
	return render(
		<SidebarPanel
			issue={issue}
			issueId={issue.id}
			statuses={[]}
			taskTypes={[]}
			members={[]}
			updatingStatus={false}
			updatingPriority={false}
			updatingAssignee={false}
			updatingType={false}
			typeChangeError={null}
			changeStatus={() => {}}
			changePriority={() => {}}
			changeAssignee={() => {}}
			changeType={() => {}}
			fetchIssue={async () => {}}
		/>
	);
}

describe("IssueTimestamp", () => {
	it("renders Tokyo date/time with a machine-readable UTC timestamp", () => {
		const { container } = render(<IssueTimestamp value={AFTER_MIDNIGHT} />);
		expect(screen.getByText("2026-10-07 00:05 Asia/Tokyo")).toBeTruthy();
		expect(container.querySelector("time")?.getAttribute("datetime")).toBe(
			"2026-10-06T15:05:00.000Z"
		);
	});

	it("does not emit a made-up datetime attribute for a missing timestamp", () => {
		const { container } = render(<IssueTimestamp value={null} />);
		expect(screen.getByText("Unknown (not recorded)")).toBeTruthy();
		expect(container.querySelector("time")).toBeNull();
	});
});

describe("IssueResolutionHistory", () => {
	it("renders all lifecycle events newest-first and retains completion after reopen", () => {
		render(
			<IssueResolutionHistory
				issue={{
					...ISSUE,
					status_key: "cancelled",
					status_category: "cancelled",
					completed_at: null,
					resolution_history: [
						COMPLETED,
						{
							...COMPLETED,
							id: "cancelled",
							kind: "cancelled",
							occurred_at: AFTER_MIDNIGHT + 60,
							from_status: "todo",
							to_status: "cancelled",
						},
						{
							...COMPLETED,
							id: "reopened",
							kind: "reopened",
							occurred_at: AFTER_MIDNIGHT,
							from_status: "done",
							to_status: "todo",
						},
					],
				}}
			/>
		);
		const list = screen.getByRole("list", { name: "Resolution events, newest first" });
		const rows = within(list).getAllByRole("listitem");
		expect(rows.map((row) => row.textContent)).toEqual([
			"Cancelled2026-10-07 00:06 Asia/Tokyotodo → cancelled",
			"Reopened2026-10-07 00:05 Asia/Tokyodone → todo",
			"Completed2026-10-06 23:59 Asia/Tokyoin_progress → done",
		]);
		expect(screen.getByText("Last completed:").parentElement?.textContent).toBe(
			"Last completed: 2026-10-06 23:59 Asia/Tokyo"
		);
	});

	it("keeps legacy completion unknown instead of substituting created/updated timestamps", () => {
		render(<IssueResolutionHistory issue={{ ...ISSUE, completed_at: null }} />);
		expect(screen.getByText("Unknown (not recorded)")).toBeTruthy();
		expect(screen.getByText("No recorded resolution events.")).toBeTruthy();
		expect(screen.queryByText("2026-10-07 00:05 Asia/Tokyo")).toBeNull();
	});

	it("shows unknown completion for legacy done without joined status metadata", () => {
		render(
			<IssueResolutionHistory
				issue={{
					...ISSUE,
					status: "done",
					status_key: null,
					status_category: null,
					completed_at: null,
				}}
			/>
		);
		expect(screen.getByText("Last completed:").parentElement?.textContent).toBe(
			"Last completed: Unknown (not recorded)"
		);
	});

	it("does not invent completion for an open issue without records", () => {
		render(
			<IssueResolutionHistory
				issue={{
					...ISSUE,
					completed_at: null,
					status_key: "todo",
					status_category: "todo",
					resolution_history: undefined,
				}}
			/>
		);
		expect(screen.queryByText("Last completed:")).toBeNull();
		expect(screen.getByText("No recorded resolution events.")).toBeTruthy();
	});

	it("labels an unverified legacy completion instead of presenting it as an observed time", () => {
		render(
			<IssueResolutionHistory issue={{ ...ISSUE, completed_at_source: "legacy_unverified" }} />
		);
		expect(screen.getByText("2026-10-07 00:05 Asia/Tokyo")).toBeTruthy();
		expect(screen.getByText("Legacy time (unverified)")).toBeTruthy();
	});

	it("treats completion timestamps lacking source metadata conservatively", () => {
		render(<IssueResolutionHistory issue={{ ...ISSUE, completed_at_source: undefined }} />);
		expect(screen.getByText("Legacy time (unverified)")).toBeTruthy();
	});

	it("recognizes a historical completion event as observed after reopening", () => {
		render(
			<IssueResolutionHistory
				issue={{
					...ISSUE,
					status_key: "todo",
					status_category: "todo",
					completed_at: null,
					completed_at_source: null,
					resolution_history: [COMPLETED],
				}}
			/>
		);
		expect(screen.queryByText("Legacy time (unverified)")).toBeNull();
		expect(screen.getByText("Last completed:").parentElement?.textContent).toBe(
			"Last completed: 2026-10-06 23:59 Asia/Tokyo"
		);
	});

	it("clearly identifies a truncated history", () => {
		render(
			<IssueResolutionHistory
				issue={{ ...ISSUE, resolution_history: [COMPLETED], resolution_history_has_more: true }}
			/>
		);
		expect(
			screen.getByText("Showing the latest 1 recorded events. Earlier events are not shown.")
		).toBeTruthy();
	});

	it("retains the full-ledger completion when the recent history contains only later reopen/cancel events", () => {
		const recentEvents: IssueResolutionEvent[] = Array.from({ length: 20 }, (_, index) => ({
			...COMPLETED,
			id: `recent-${index}`,
			sequence: index + 2,
			kind: index % 2 === 0 ? "cancelled" : "reopened",
			occurred_at: AFTER_MIDNIGHT + index,
			from_status: index % 2 === 0 ? "todo" : "cancelled",
			to_status: index % 2 === 0 ? "cancelled" : "todo",
		}));
		render(
			<IssueResolutionHistory
				issue={{
					...ISSUE,
					status_key: "todo",
					status_category: "todo",
					completed_at: null,
					completed_at_source: null,
					last_completed_at: BEFORE_MIDNIGHT,
					resolution_history: recentEvents,
					resolution_history_has_more: true,
				}}
			/>
		);
		expect(screen.getByText("Last completed:").parentElement?.textContent).toBe(
			"Last completed: 2026-10-06 23:59 Asia/Tokyo"
		);
		expect(screen.queryByText("Legacy time (unverified)")).toBeNull();
		expect(screen.getAllByRole("listitem")).toHaveLength(20);
		expect(
			screen.getByText("Showing the latest 20 recorded events. Earlier events are not shown.")
		).toBeTruthy();
	});

	it("updates the latest completion and history when refreshed issue data arrives", () => {
		const { rerender } = render(
			<IssueResolutionHistory
				issue={{ ...ISSUE, completed_at: BEFORE_MIDNIGHT, resolution_history: [COMPLETED] }}
			/>
		);
		const reopened: IssueResolutionEvent = {
			...COMPLETED,
			id: "reopened",
			kind: "reopened",
			occurred_at: AFTER_MIDNIGHT,
			from_status: "done",
			to_status: "todo",
		};
		const completedAgain = {
			...COMPLETED,
			id: "completed-again",
			occurred_at: AFTER_MIDNIGHT + 60,
		};
		rerender(
			<IssueResolutionHistory
				issue={{
					...ISSUE,
					completed_at: AFTER_MIDNIGHT + 60,
					resolution_history: [COMPLETED, reopened, completedAgain],
				}}
			/>
		);
		expect(screen.getByText("Last completed:").parentElement?.textContent).toBe(
			"Last completed: 2026-10-07 00:06 Asia/Tokyo"
		);
		expect(screen.getAllByRole("listitem")).toHaveLength(3);
	});
});

describe("issue sidebar timestamps", () => {
	it("shows Created, Updated and current Completed with time and timezone", () => {
		renderSidebar(ISSUE);
		expect(screen.getByText("Created").parentElement?.textContent).toBe(
			"Created2026-10-06 23:59 Asia/Tokyo"
		);
		expect(screen.getByText("Updated").parentElement?.textContent).toBe(
			"Updated2026-10-07 00:05 Asia/Tokyo"
		);
		expect(screen.getByText("Completed").parentElement?.textContent).toBe(
			"Completed2026-10-07 00:05 Asia/Tokyo"
		);
	});

	it("keeps current completion unknown for a completed legacy issue", () => {
		renderSidebar({ ...ISSUE, completed_at: null });
		expect(screen.getByText("Completed").parentElement?.textContent).toBe(
			"CompletedUnknown (not recorded)"
		);
	});

	it("labels an unverified current completion in the sidebar", () => {
		renderSidebar({ ...ISSUE, completed_at_source: "legacy_unverified" });
		expect(screen.getByText("Completed").parentElement?.textContent).toBe(
			"Completed2026-10-07 00:05 Asia/TokyoLegacy time (unverified)"
		);
	});

	it("shows current completion for legacy raw done with no joined status metadata", () => {
		renderSidebar({
			...ISSUE,
			status: "done",
			status_key: null,
			status_category: null,
			completed_at: null,
		});
		expect(screen.getByText("Completed").parentElement?.textContent).toBe(
			"CompletedUnknown (not recorded)"
		);
	});

	it("does not present the historical completion as current after reopening", () => {
		renderSidebar({
			...ISSUE,
			status_key: "todo",
			status_category: "todo",
			completed_at: null,
			resolution_history: [COMPLETED],
		});
		expect(screen.queryByText("Completed")).toBeNull();
	});
});
