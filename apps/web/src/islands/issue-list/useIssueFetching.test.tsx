import { act, render, waitFor } from "@testing-library/preact";
import { describe, expect, it, vi } from "vitest";
import { getBoardColumnIssues, type Issue, sortIssues } from "../board-utils";
import type { FilterQueryFilters } from "../IssueList-helpers";
import type { ViewMode } from "./types-view";
import { useIssueFetching } from "./useIssueFetching";

const PROJECTS = [
	{ id: "p1", key: "ALPHA", name: "Alpha", description: null },
	{ id: "p2", key: "BETA", name: "Beta", description: null },
];
const FILTERS: FilterQueryFilters = {
	filterStatuses: [], filterPriorities: [], filterProject: "ALPHA", filterType: "",
	filterEpicId: "", filterSprintId: "", hideEpics: false, filterDateField: "",
	filterDateFrom: "", filterDateTo: "",
};
const ISSUES: Issue[] = Array.from({ length: 36 }, (_, i) => ({
	id: `i${i}`, number: i + 1, title: `Fixture issue ${i}`, priority: i === 34 ? "urgent" : "low",
	assignee_id: null, assignee_name: null, parent_id: null,
	project_id: "p1", project_key: "ALPHA", project_name: "Alpha",
	type_key: null, type_name: null, status_id: "s1", status_key: "todo", status_name: "Todo",
	status_category: i === 34 ? "in_progress" : i === 35 ? "done" : "todo",
	sprint_id: null, updated_at: 1000, created_at: 1000,
}));
const BETA = { ...ISSUES[0], id: "beta-issue", project_id: "p2", project_key: "BETA" };
let result: ReturnType<typeof useIssueFetching>;
function Probe({ project = "ALPHA", view = "list", ready = true }: { project?: string; view?: ViewMode; ready?: boolean }) {
	result = useIssueFetching(undefined, view, { ...FILTERS, filterProject: project }, PROJECTS, [], ready);
	return null;
}
const response = (items: Issue[], nextCursor: string | null = null, total = items.length) => ({
	ok: true, json: async () => ({ items, nextCursor, total }),
});

describe("issue pagination scope and cancellation", () => {
	it.each(["board", "backlog"])("loads a short first page plus cursor page in %s", async (view) => {
		const urls: URL[] = [];
		vi.stubGlobal("fetch", vi.fn(async (input: string) => {
			const url = new URL(input, location.origin);
			urls.push(url);
			return url.searchParams.has("cursor") ? response(ISSUES.slice(30)) : response(ISSUES.slice(0, 30), "tail", 36);
		}));
		render(<Probe view={view as ViewMode} />);
		await waitFor(() => expect(result.issues.length).toBe(36));
		expect(urls.length).toBe(2);
		expect(urls[0].searchParams.get("limit")).toBe("100");
		expect(urls[1].searchParams.get("cursor")).toBe("tail");
		expect(urls.every((url) => url.searchParams.get("project") === "p1")).toBe(true);
		expect(getBoardColumnIssues(result.issues, "in_progress").length).toBe(1);
		expect(getBoardColumnIssues(result.issues, "done").length).toBe(1);
		expect(sortIssues(result.issues, "priority", "asc")[0].id).toBe("i34");
		expect(result.total).toBe(36);
		expect(result.nextCursor).toBeNull();
	});

	it("discards an old load-more response after switching projects", async () => {
		let finish: (value: ReturnType<typeof response>) => void = () => {};
		vi.stubGlobal("fetch", vi.fn(async (input: string) => {
			const params = new URL(input, location.origin).searchParams;
			if (params.get("project") === "p2") return response([BETA]);
			if (params.has("cursor")) return new Promise((resolve) => { finish = resolve; });
			return response(ISSUES.slice(0, 30), "alpha-tail", 36);
		}));
		const view = render(<Probe />);
		await waitFor(() => expect(result.nextCursor).toBe("alpha-tail"));
		let pending: Promise<void> = Promise.resolve();
		act(() => { pending = result.loadMore(); });
		view.rerender(<Probe project="BETA" />);
		await waitFor(() => expect(result.issues.map((i) => i.id)).toEqual(["beta-issue"]));
		await act(async () => { finish(response(ISSUES.slice(30), "stale-cursor")); await pending; });
		expect(result.issues.map((i) => i.id)).toEqual(["beta-issue"]);
		expect(result.nextCursor).toBeNull();
		expect(result.total).toBe(1);
	});

	it("hides stale rows and never sends an old cursor while the new first page is pending", async () => {
		let finish: (value: ReturnType<typeof response>) => void = () => {};
		const urls: URL[] = [];
		vi.stubGlobal("fetch", vi.fn(async (input: string) => {
			const url = new URL(input, location.origin);
			urls.push(url);
			if (url.searchParams.get("project") === "p2") return new Promise((resolve) => { finish = resolve; });
			return response(ISSUES.slice(0, 30), "alpha-tail", 36);
		}));
		const view = render(<Probe />);
		await waitFor(() => expect(result.nextCursor).toBe("alpha-tail"));
		view.rerender(<Probe project="BETA" />);
		await waitFor(() => expect(urls.length).toBe(2));
		expect(result.issues.length).toBe(0);
		expect(result.nextCursor).toBeNull();
		await act(async () => { await result.loadMore(); });
		expect(urls.length).toBe(2);
		finish(response([BETA]));
		await waitFor(() => expect(result.issues.map((i) => i.id)).toEqual(["beta-issue"]));
	});

	it("invalidates an old response while a new project is unresolved", async () => {
		let finish: (value: ReturnType<typeof response>) => void = () => {};
		let requested = false;
		vi.stubGlobal("fetch", vi.fn(() => {
			requested = true;
			return new Promise((resolve) => { finish = resolve; });
		}));
		const view = render(<Probe />);
		await waitFor(() => expect(requested).toBe(true));
		view.rerender(<Probe ready={false} />);
		await act(async () => { finish(response(ISSUES)); });
		expect(result.issues.length).toBe(0);
		expect(result.nextCursor).toBeNull();
	});
});


it("rejects retained pagination and refresh callbacks invoked after a scope switch", async () => {
	const urls: URL[] = [];
	vi.stubGlobal("fetch", vi.fn(async (input: string) => {
		const url = new URL(input, location.origin);
		urls.push(url);
		return url.searchParams.get("project") === "p2"
			? response([BETA])
			: response(ISSUES.slice(0, 30), "alpha-tail", 36);
	}));
	const view = render(<Probe />);
	await waitFor(() => expect(result.nextCursor).toBe("alpha-tail"));
	const oldLoadMore = result.loadMore;
	const oldRefresh = result.fetchIssues;
	view.rerender(<Probe project="BETA" />);
	await waitFor(() => expect(result.issues.map((issue) => issue.id)).toEqual(["beta-issue"]));
	await act(async () => {
		await oldLoadMore();
		await oldRefresh();
	});
	expect(urls.length).toBe(2);
	expect(result.issues.map((issue) => issue.id)).toEqual(["beta-issue"]);
	expect(result.nextCursor).toBeNull();
});
