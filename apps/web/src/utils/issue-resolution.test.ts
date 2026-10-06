import { describe, expect, it } from "vitest";
import {
	formatIssueTimestamp,
	isIssueCompleted,
	type IssueResolutionEvent,
	issueTimestampDate,
	latestCompletionTime,
	newestResolutionEvents,
} from "./issue-resolution";

function event(
	id: string,
	occurred_at: number,
	kind: IssueResolutionEvent["kind"]
): IssueResolutionEvent {
	return {
		id,
		issue_id: "i1",
		occurred_at,
		kind,
		actor_id: null,
		from_status: "todo",
		to_status: "done",
	};
}

describe("issue resolution timestamps", () => {
	it("recognizes legacy done without joined status metadata", () => {
		expect(isIssueCompleted({ status: "done", status_key: null, status_category: null })).toBe(true);
		expect(isIssueCompleted({ status: "todo", status_key: null, status_category: null })).toBe(false);
	});

	it("uses Tokyo's calendar day and 24-hour time across midnight", () => {
		expect(formatIssueTimestamp(Date.parse("2026-10-06T14:59:00Z") / 1000)).toBe(
			"2026-10-06 23:59 Asia/Tokyo"
		);
		expect(formatIssueTimestamp(Date.parse("2026-10-06T15:00:00Z") / 1000)).toBe(
			"2026-10-07 00:00 Asia/Tokyo"
		);
	});

	it("uses the requested timezone explicitly", () => {
		expect(formatIssueTimestamp(Date.parse("2026-10-06T15:05:00Z") / 1000, "UTC")).toBe(
			"2026-10-06 15:05 UTC"
		);
	});

	it("keeps missing or invalid legacy timestamps unknown rather than showing 1970", () => {
		for (const value of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY, 1e20]) {
			expect(issueTimestampDate(value)).toBeNull();
			expect(formatIssueTimestamp(value)).toBe("Unknown (not recorded)");
		}
	});

	it("preserves zero as a real epoch timestamp", () => {
		expect(formatIssueTimestamp(0)).toBe("1970-01-01 09:00 Asia/Tokyo");
		expect(issueTimestampDate(0)?.toISOString()).toBe("1970-01-01T00:00:00.000Z");
	});
});

describe("durable resolution history", () => {
	it("sorts events newest-first without mutating the API response", () => {
		const history = [
			event("first", 100, "completed"),
			event("last", 300, "cancelled"),
			event("middle", 200, "reopened"),
		];
		expect(newestResolutionEvents(history).map((entry) => entry.id)).toEqual([
			"last",
			"middle",
			"first",
		]);
		expect(history.map((entry) => entry.id)).toEqual(["first", "last", "middle"]);
	});

	it("retains completion after reopening or cancellation without conflating event kinds", () => {
		const history = [
			event("done", 100, "completed"),
			event("open", 200, "reopened"),
			event("cancel", 300, "cancelled"),
		];
		expect(latestCompletionTime(null, history)).toBe(100);
	});

	it("uses the durable sequence to order changes occurring in the same second", () => {
		const history = [
			{ ...event("first", 100, "completed"), sequence: 1 },
			{ ...event("third", 100, "completed"), sequence: 3 },
			{ ...event("second", 100, "reopened"), sequence: 2 },
		];
		expect(newestResolutionEvents(history).map((entry) => entry.id)).toEqual([
			"third",
			"second",
			"first",
		]);
	});

	it("selects the latest repeated completion and supports legacy completed_at", () => {
		const history = [event("again", 300, "completed"), event("first", 100, "completed")];
		expect(latestCompletionTime(null, history)).toBe(300);
		expect(latestCompletionTime(400, history)).toBe(400);
		expect(latestCompletionTime(100, [])).toBe(100);
		expect(latestCompletionTime(0, [])).toBe(0);
		expect(latestCompletionTime(null, [event("epoch", 0, "completed")])).toBe(0);
		expect(latestCompletionTime(null, [])).toBeNull();
	});

	it("prefers the valid full-ledger completion over potentially truncated history", () => {
		const history = [event("recent", 300, "completed")];
		expect(latestCompletionTime(400, history, 100)).toBe(100);
		expect(latestCompletionTime(null, [], 0)).toBe(0);
		expect(latestCompletionTime(null, history, null)).toBe(300);
		expect(latestCompletionTime(null, history, Number.NaN)).toBe(300);
	});
});
