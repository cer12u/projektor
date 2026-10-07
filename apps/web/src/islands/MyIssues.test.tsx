// MyIssues island — mock-fetch tests.
//
// MyIssues fetches /api/issues?assignee=me (server-resolved to the calling
// user, PROJ-444), follows every cursor, and groups by priority then project. Stub
// global fetch to branch on URL, render, and await the post-load UI
// (view-mode buttons in IssueList's pattern don't apply here — instead wait
// for the "Include done" checkbox which only renders post-load).
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Issue } from "./board-utils";
import MyIssues from "./MyIssues";

const USER_ID = "user-1";

const OPEN_ISSUE_PROJ_A: Issue = {
	id: "i1",
	number: 1,
	title: "Open issue in Alpha",
	priority: "high",
	assignee_id: USER_ID,
	assignee_name: "Test User",
	parent_id: null,
	project_key: "ALPHA",
	project_name: "Alpha Project",
	type_key: null,
	type_name: null,
	status_id: "st-todo",
	status_key: "todo",
	status_name: "Todo",
	status_category: "todo",
	sprint_id: null,
	updated_at: 1000,
	created_at: 1000,
};

const DONE_ISSUE_PROJ_A: Issue = {
	id: "i2",
	number: 2,
	title: "Done issue in Alpha",
	priority: "low",
	assignee_id: USER_ID,
	assignee_name: "Test User",
	parent_id: null,
	project_key: "ALPHA",
	project_name: "Alpha Project",
	type_key: null,
	type_name: null,
	status_id: "st-done",
	status_key: "done",
	status_name: "Done",
	status_category: "done",
	sprint_id: null,
	updated_at: 2000,
	created_at: 1000,
};

const OPEN_ISSUE_PROJ_B: Issue = {
	id: "i3",
	number: 5,
	title: "Open issue in Beta",
	priority: "medium",
	assignee_id: USER_ID,
	assignee_name: "Test User",
	parent_id: null,
	project_key: "BETA",
	project_name: "Beta Project",
	type_key: null,
	type_name: null,
	status_id: "st-todo",
	status_key: "todo",
	status_name: "Todo",
	status_category: "todo",
	sprint_id: null,
	updated_at: 1500,
	created_at: 1000,
};

function setupFetch(
	issues: readonly Issue[] = [OPEN_ISSUE_PROJ_A, DONE_ISSUE_PROJ_A, OPEN_ISSUE_PROJ_B]
) {
	return vi.fn().mockImplementation((url: string) => {
		const u = String(url);
		if (u.includes("/api/issues")) {
			return Promise.resolve({
				ok: true,
				json: () => Promise.resolve({ items: issues, nextCursor: null }),
			});
		}
		return Promise.reject(new Error(`unexpected fetch: ${u}`));
	});
}

async function waitForLoaded() {
	await waitFor(() => screen.getByLabelText(/Include done/i));
}

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

describe("MyIssues — loading and error states", () => {
	it("shows a loading indicator before data resolves", () => {
		vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));
		render(<MyIssues />);
		expect(screen.getByText(/Loading/i)).toBeTruthy();
	});

	it("shows an error message when the issues fetch fails", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockImplementation(() => Promise.reject(new Error("boom")))
		);
		render(<MyIssues />);
		expect(await screen.findByRole("alert")).toBeTruthy();
		expect(screen.getByText(/Failed to load issues/i)).toBeTruthy();
	});
});

describe("MyIssues — cross-project fetch and grouping", () => {
	it("fetches issues scoped to assignee=me (server resolves the calling user)", async () => {
		const mockFetch = setupFetch();
		vi.stubGlobal("fetch", mockFetch);
		render(<MyIssues />);
		await waitForLoaded();

		const calls = (mockFetch.mock.calls as [string, unknown][]).map(([u]) => String(u));
		expect(calls.some((u) => u.includes("/api/issues?assignee=me"))).toBe(true);
	});

	it("groups issues by project under a heading per project", async () => {
		vi.stubGlobal("fetch", setupFetch());
		render(<MyIssues />);
		await waitForLoaded();

		// Titles render twice (desktop table + mobile card, toggled via CSS), so
		// assert on the unique project heading and count of title occurrences.
		expect(await screen.findByText("Alpha Project")).toBeTruthy();
		expect(screen.getByText("Beta Project")).toBeTruthy();
		expect(screen.getAllByText("Open issue in Alpha").length).toBeGreaterThan(0);
		expect(screen.getAllByText("Open issue in Beta").length).toBeGreaterThan(0);
	});

	it("hides done issues by default", async () => {
		vi.stubGlobal("fetch", setupFetch());
		render(<MyIssues />);
		await waitForLoaded();

		await waitFor(() =>
			expect(screen.getAllByText("Open issue in Alpha").length).toBeGreaterThan(0)
		);
		expect(screen.queryAllByText("Done issue in Alpha")).toHaveLength(0);
	});

	it("shows done issues once 'Include done' is checked", async () => {
		vi.stubGlobal("fetch", setupFetch());
		render(<MyIssues />);
		await waitForLoaded();

		fireEvent.click(screen.getByLabelText(/Include done/i));

		await waitFor(() =>
			expect(screen.getAllByText("Done issue in Alpha").length).toBeGreaterThan(0)
		);
	});

	it("shows the issue count reflecting the current filter", async () => {
		vi.stubGlobal("fetch", setupFetch());
		render(<MyIssues />);
		await waitForLoaded();

		await waitFor(() => expect(screen.getByText("2 issues")).toBeTruthy());

		fireEvent.click(screen.getByLabelText(/Include done/i));
		await waitFor(() => expect(screen.getByText("3 issues")).toBeTruthy());
	});
});

describe("MyIssues — empty states", () => {
	it("shows the open-issues empty state when there are no assigned issues", async () => {
		vi.stubGlobal("fetch", setupFetch([]));
		render(<MyIssues />);
		await waitForLoaded();

		expect(await screen.findByText("No issues assigned to you")).toBeTruthy();
		expect(screen.getByText(/Toggle "Include done"/i)).toBeTruthy();
	});

	it("shows the all-projects empty state once 'Include done' is toggled with no issues at all", async () => {
		vi.stubGlobal("fetch", setupFetch([]));
		render(<MyIssues />);
		await waitForLoaded();

		fireEvent.click(screen.getByLabelText(/Include done/i));

		await waitFor(() =>
			expect(screen.getByText("You have no issues across any project.")).toBeTruthy()
		);
	});
});

describe("MyIssues — workspace-slug header contract", () => {
	it("includes X-Workspace-Slug header when workspaceSlug prop is passed", async () => {
		const mockFetch = setupFetch();
		vi.stubGlobal("fetch", mockFetch);
		render(<MyIssues workspaceSlug="my-workspace" />);
		await waitForLoaded();

		const calls = mockFetch.mock.calls as [string, RequestInit][];
		for (const [, init] of calls) {
			const headers = (init?.headers as Record<string, string>) ?? {};
			expect(headers["X-Workspace-Slug"]).toBe("my-workspace");
		}
	});

	it("omits X-Workspace-Slug header when workspaceSlug prop is not passed", async () => {
		const mockFetch = setupFetch();
		vi.stubGlobal("fetch", mockFetch);
		render(<MyIssues />);
		await waitForLoaded();

		const calls = mockFetch.mock.calls as [string, RequestInit][];
		for (const [, init] of calls) {
			const headers = (init?.headers as Record<string, string>) ?? {};
			expect(headers["X-Workspace-Slug"]).toBeUndefined();
		}
	});
});

function pageResponse(items: readonly Issue[], nextCursor: string | null = null, total?: number) {
	return { ok: true, json: () => Promise.resolve({ items, nextCursor, total }) };
}

function makeIssues(count: number, offset = 0): Issue[] {
	return Array.from({ length: count }, (_, index) => ({
		...OPEN_ISSUE_PROJ_A,
		id: `issue-${offset + index + 1}`,
		number: offset + index + 1,
		title: `Assigned issue ${offset + index + 1}`,
	}));
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: Error) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

function desktopTitles(container: Element): (string | null)[] {
	return Array.from(container.querySelectorAll("tbody tr td:nth-child(2) a")).map(
		(link) => link.textContent
	);
}

describe("MyIssues — complete cursor pagination", () => {
	it("loads 30 plus 6 with limit 100, preserving caller and workspace", async () => {
		const issues = makeIssues(36);
		const cursor = "1000:issue/30+tail";
		const mockFetch = vi.fn().mockImplementation((url: string) => {
			const params = new URL(url, "http://localhost").searchParams;
			return Promise.resolve(
				params.has("cursor")
					? pageResponse(issues.slice(30))
					: pageResponse(issues.slice(0, 30), cursor, 36)
			);
		});
		vi.stubGlobal("fetch", mockFetch);
		const { container } = render(<MyIssues workspaceSlug="my-workspace" />);
		await waitForLoaded();

		expect(screen.getByText("36 issues")).toBeTruthy();
		expect(desktopTitles(container)).toHaveLength(36);
		expect(screen.getAllByText("Assigned issue 36")).toHaveLength(2);
		const calls = mockFetch.mock.calls as [string, RequestInit][];
		expect(calls).toHaveLength(2);
		for (const [url, init] of calls) {
			const params = new URL(url, "http://localhost").searchParams;
			expect(params.get("assignee")).toBe("me");
			expect(params.get("limit")).toBe("100");
			expect(params.has("projectId")).toBe(false);
			expect((init.headers as Record<string, string>)["X-Workspace-Slug"]).toBe("my-workspace");
		}
		expect(new URL(calls[1][0], "http://localhost").searchParams.get("cursor")).toBe(cursor);
	});

	it("loads more than 100 assigned issues over all three pages", async () => {
		const issues = makeIssues(205);
		const mockFetch = vi.fn().mockImplementation((url: string) => {
			const cursor = new URL(url, "http://localhost").searchParams.get("cursor");
			if (cursor === null) {
				return Promise.resolve(pageResponse(issues.slice(0, 100), "1000:p1", 205));
			}
			if (cursor === "1000:p1") {
				return Promise.resolve(pageResponse(issues.slice(100, 200), "1000:p2"));
			}
			return Promise.resolve(pageResponse(issues.slice(200)));
		});
		vi.stubGlobal("fetch", mockFetch);
		const { container } = render(<MyIssues />);
		await waitForLoaded();

		expect(screen.getByText("205 issues")).toBeTruthy();
		expect(desktopTitles(container)).toHaveLength(205);
		expect(mockFetch.mock.calls).toHaveLength(3);
	});

	it("keeps loading until the last page and does not display a partial queue", async () => {
		const lastPage = deferred<ReturnType<typeof pageResponse>>();
		const mockFetch = vi
			.fn()
			.mockImplementation((url: string) =>
				url.includes("cursor=")
					? lastPage.promise
					: Promise.resolve(pageResponse([OPEN_ISSUE_PROJ_A], "1000:p1", 2))
			);
		vi.stubGlobal("fetch", mockFetch);
		render(<MyIssues />);
		await waitFor(() => expect(mockFetch.mock.calls).toHaveLength(2));

		expect(screen.getByText("Loading…")).toBeTruthy();
		expect(screen.queryAllByText("Open issue in Alpha")).toHaveLength(0);
		expect(screen.queryByLabelText(/Include done/i)).toBeNull();
		await act(async () => lastPage.resolve(pageResponse([OPEN_ISSUE_PROJ_B])));
		await waitForLoaded();
		expect(screen.getByText("2 issues")).toBeTruthy();
	});

	it("deduplicates overlapping issues by ID across pages", async () => {
		const mockFetch = vi
			.fn()
			.mockImplementation((url: string) =>
				Promise.resolve(
					url.includes("cursor=")
						? pageResponse([OPEN_ISSUE_PROJ_A, OPEN_ISSUE_PROJ_B])
						: pageResponse([OPEN_ISSUE_PROJ_A], "1000:p1", 2)
				)
			);
		vi.stubGlobal("fetch", mockFetch);
		const { container } = render(<MyIssues />);
		await waitForLoaded();

		expect(screen.getByText("2 issues")).toBeTruthy();
		expect(desktopTitles(container)).toHaveLength(2);
		expect(screen.getAllByText("Open issue in Alpha")).toHaveLength(2);
	});

	it("rejects a repeated cursor without presenting partial success", async () => {
		const mockFetch = vi
			.fn()
			.mockImplementation(() =>
				Promise.resolve(pageResponse([OPEN_ISSUE_PROJ_A], "1000:repeated"))
			);
		vi.stubGlobal("fetch", mockFetch);
		render(<MyIssues />);

		const alert = await screen.findByRole("alert");
		expect(alert.textContent).toContain("repeated an issue-page cursor");
		expect(mockFetch.mock.calls).toHaveLength(2);
		expect(screen.queryAllByText("Open issue in Alpha")).toHaveLength(0);
		expect(screen.queryByLabelText(/Include done/i)).toBeNull();
	});

	it("rejects an empty page with a continuing cursor", async () => {
		const mockFetch = vi.fn().mockResolvedValue(pageResponse([], "1000:more", 36));
		vi.stubGlobal("fetch", mockFetch);
		render(<MyIssues />);

		const alert = await screen.findByRole("alert");
		expect(alert.textContent).toContain("empty issue page with another cursor");
		expect(mockFetch.mock.calls).toHaveLength(1);
		expect(screen.queryByText("No issues assigned to you")).toBeNull();
	});

	it("uses the unique issue count when checking the initial total", async () => {
		const mockFetch = vi
			.fn()
			.mockImplementation((url: string) =>
				Promise.resolve(
					url.includes("cursor=")
						? pageResponse([OPEN_ISSUE_PROJ_A, OPEN_ISSUE_PROJ_B])
						: pageResponse([OPEN_ISSUE_PROJ_A], "1000:p1", 3)
				)
			);
		vi.stubGlobal("fetch", mockFetch);
		render(<MyIssues />);

		expect((await screen.findByRole("alert")).textContent).toContain("incomplete list");
		expect(mockFetch.mock.calls).toHaveLength(2);
		expect(screen.queryByLabelText(/Include done/i)).toBeNull();
	});

	it("stops at the page safety limit with an explicit incomplete error", async () => {
		let page = 0;
		const mockFetch = vi.fn().mockImplementation(() => {
			page++;
			return Promise.resolve(pageResponse(makeIssues(1, page), `1000:page-${page}`));
		});
		vi.stubGlobal("fetch", mockFetch);
		render(<MyIssues />);

		const alert = await screen.findByRole("alert");
		expect(alert.textContent).toContain("did not finish after 100 pages");
		expect(alert.textContent).toContain("No partial queue is shown");
		expect(mockFetch.mock.calls).toHaveLength(100);
		expect(screen.queryByLabelText(/Include done/i)).toBeNull();
	});

	it("does not show a partial or empty-success queue when a later page fails", async () => {
		const mockFetch = vi
			.fn()
			.mockImplementation((url: string) =>
				url.includes("cursor=")
					? Promise.reject(new Error("second-page failure"))
					: Promise.resolve(pageResponse([OPEN_ISSUE_PROJ_A], "1000:p1", 2))
			);
		vi.stubGlobal("fetch", mockFetch);
		render(<MyIssues />);

		expect((await screen.findByRole("alert")).textContent).toContain("No partial queue is shown");
		expect(screen.queryAllByText("Open issue in Alpha")).toHaveLength(0);
		expect(screen.queryByText("No issues assigned to you")).toBeNull();
	});

	it("rejects a terminal page that falls short of the server's initial total", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(pageResponse([OPEN_ISSUE_PROJ_A], null, 36)));
		render(<MyIssues />);

		expect((await screen.findByRole("alert")).textContent).toContain("incomplete list");
		expect(screen.queryByLabelText(/Include done/i)).toBeNull();
	});

	it("rejects missing cursor metadata instead of declaring success", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ items: [OPEN_ISSUE_PROJ_A] }),
			})
		);
		render(<MyIssues />);

		expect((await screen.findByRole("alert")).textContent).toContain("invalid issue page");
		expect(screen.queryByLabelText(/Include done/i)).toBeNull();
	});
});

describe("MyIssues — priority queue across projects", () => {
	it("orders global priority bands, then projects, numbers and IDs", async () => {
		const issues: Issue[] = [
			{ ...OPEN_ISSUE_PROJ_A, id: "low", title: "Alpha low", priority: "low" },
			{ ...OPEN_ISSUE_PROJ_B, id: "none", title: "Beta no priority", priority: "none" },
			{ ...OPEN_ISSUE_PROJ_B, id: "high-beta", title: "Beta high", priority: "high" },
			{ ...OPEN_ISSUE_PROJ_A, id: "high-2", number: 2, title: "Alpha high 2" },
			{ ...OPEN_ISSUE_PROJ_A, id: "high-1-b", title: "Alpha high 1 B" },
			{ ...OPEN_ISSUE_PROJ_A, id: "medium", title: "Alpha medium", priority: "medium" },
			{ ...OPEN_ISSUE_PROJ_A, id: "high-1-a", title: "Alpha high 1 A" },
			{ ...OPEN_ISSUE_PROJ_B, id: "urgent", title: "Beta urgent", priority: "urgent" },
		];
		const mockFetch = vi
			.fn()
			.mockImplementation((url: string) =>
				Promise.resolve(
					url.includes("cursor=")
						? pageResponse(issues.slice(4))
						: pageResponse(issues.slice(0, 4), "1000:p1", 8)
				)
			);
		vi.stubGlobal("fetch", mockFetch);
		const { container } = render(<MyIssues />);
		await waitForLoaded();

		expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual([
			"urgent",
			"high",
			"medium",
			"low",
			"No priority",
		]);
		expect(desktopTitles(container)).toEqual([
			"Beta urgent",
			"Alpha high 1 A",
			"Alpha high 1 B",
			"Alpha high 2",
			"Beta high",
			"Alpha medium",
			"Alpha low",
			"Beta no priority",
		]);
		const highBand = screen.getByRole("heading", { name: "high", level: 2 }).parentElement;
		expect(Array.from(highBand?.querySelectorAll("h3") ?? []).map((h) => h.textContent)).toEqual([
			"Alpha Project",
			"Beta Project",
		]);
	});

	it("preserves Include done for completed and cancelled issues on later pages", async () => {
		const done = { ...DONE_ISSUE_PROJ_A, priority: "urgent" };
		const cancelled = {
			...OPEN_ISSUE_PROJ_B,
			id: "cancelled",
			title: "Cancelled Beta",
			priority: "high",
			status_category: "cancelled",
			status_name: "Cancelled",
		};
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockImplementation((url: string) =>
					Promise.resolve(
						url.includes("cursor=")
							? pageResponse([done, cancelled])
							: pageResponse([OPEN_ISSUE_PROJ_A], "1000:p1", 3)
					)
				)
		);
		const { container } = render(<MyIssues />);
		await waitForLoaded();
		expect(screen.getByText("1 issue")).toBeTruthy();
		expect(screen.queryAllByText(done.title)).toHaveLength(0);
		expect(screen.queryAllByText(cancelled.title)).toHaveLength(0);

		fireEvent.click(screen.getByLabelText(/Include done/i));
		await waitFor(() => expect(screen.getByText("3 issues")).toBeTruthy());
		expect(desktopTitles(container)).toEqual([
			done.title,
			OPEN_ISSUE_PROJ_A.title,
			cancelled.title,
		]);

		fireEvent.click(screen.getByLabelText(/Include done/i));
		await waitFor(() => expect(screen.getByText("1 issue")).toBeTruthy());
	});
});

describe("MyIssues — stale request protection", () => {
	it("ignores an old workspace response and does not fetch its next page", async () => {
		const oldPage = deferred<ReturnType<typeof pageResponse>>();
		const mockFetch = vi
			.fn()
			.mockImplementation((_url: string, init: RequestInit) =>
				(init.headers as Record<string, string>)["X-Workspace-Slug"] === "old-workspace"
					? oldPage.promise
					: Promise.resolve(pageResponse([OPEN_ISSUE_PROJ_B]))
			);
		vi.stubGlobal("fetch", mockFetch);
		const { rerender } = render(<MyIssues workspaceSlug="old-workspace" />);
		await waitFor(() => expect(mockFetch.mock.calls).toHaveLength(1));
		rerender(<MyIssues workspaceSlug="new-workspace" />);
		await waitForLoaded();
		expect(screen.getAllByText(OPEN_ISSUE_PROJ_B.title)).toHaveLength(2);

		await act(async () => oldPage.resolve(pageResponse([OPEN_ISSUE_PROJ_A], "1000:old")));
		expect(mockFetch.mock.calls).toHaveLength(2);
		expect(screen.queryAllByText(OPEN_ISSUE_PROJ_A.title)).toHaveLength(0);
		expect(screen.getAllByText(OPEN_ISSUE_PROJ_B.title)).toHaveLength(2);
	});

	it("ignores an old workspace error while the new workspace is still loading", async () => {
		const oldPage = deferred<ReturnType<typeof pageResponse>>();
		const newPage = deferred<ReturnType<typeof pageResponse>>();
		const mockFetch = vi
			.fn()
			.mockImplementation((_url: string, init: RequestInit) =>
				(init.headers as Record<string, string>)["X-Workspace-Slug"] === "old-workspace"
					? oldPage.promise
					: newPage.promise
			);
		vi.stubGlobal("fetch", mockFetch);
		const { rerender } = render(<MyIssues workspaceSlug="old-workspace" />);
		await waitFor(() => expect(mockFetch.mock.calls).toHaveLength(1));
		rerender(<MyIssues workspaceSlug="new-workspace" />);
		await waitFor(() => expect(mockFetch.mock.calls).toHaveLength(2));

		await act(async () => oldPage.reject(new Error("old failure")));
		expect(screen.queryByRole("alert")).toBeNull();
		expect(screen.getByText("Loading…")).toBeTruthy();
		await act(async () => newPage.resolve(pageResponse([OPEN_ISSUE_PROJ_B])));
		await waitForLoaded();
		expect(screen.getAllByText(OPEN_ISSUE_PROJ_B.title)).toHaveLength(2);
	});

	it("hides an already loaded queue immediately when the workspace changes", async () => {
		const newPage = deferred<ReturnType<typeof pageResponse>>();
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockImplementation((_url: string, init: RequestInit) =>
					(init.headers as Record<string, string>)["X-Workspace-Slug"] === "old-workspace"
						? Promise.resolve(pageResponse([OPEN_ISSUE_PROJ_A]))
						: newPage.promise
				)
		);
		const { rerender } = render(<MyIssues workspaceSlug="old-workspace" />);
		await waitForLoaded();
		rerender(<MyIssues workspaceSlug="new-workspace" />);

		expect(screen.queryAllByText(OPEN_ISSUE_PROJ_A.title)).toHaveLength(0);
		expect(screen.getByText("Loading…")).toBeTruthy();
		await act(async () => newPage.resolve(pageResponse([OPEN_ISSUE_PROJ_B])));
		await waitForLoaded();
	});

	it("stops fetching pages after unmount even when the pending response has a cursor", async () => {
		const pending = deferred<ReturnType<typeof pageResponse>>();
		const mockFetch = vi.fn().mockImplementation(() => pending.promise);
		vi.stubGlobal("fetch", mockFetch);
		const { unmount } = render(<MyIssues />);
		await waitFor(() => expect(mockFetch.mock.calls).toHaveLength(1));
		unmount();

		await act(async () => pending.resolve(pageResponse([OPEN_ISSUE_PROJ_A], "1000:more")));
		expect(mockFetch.mock.calls).toHaveLength(1);
		expect(screen.queryByRole("alert")).toBeNull();
	});
});
