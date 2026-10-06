import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { __resetProjectStoreForTests } from "../lib/project-context";
import type { Issue } from "./board-utils";
import IssueList from "./IssueList";
import ProjectNav from "./ProjectNav";

const PROJECTS = [
	{ id: "p1", key: "ALPHA", name: "Alpha project", slug: "alpha", description: null },
	{ id: "p2", key: "BETA", name: "Beta project", slug: "beta", description: null },
];
const ISSUES: Issue[] = PROJECTS.map((p, i) => ({
	id: `issue-${i}`, number: i + 1, title: `${p.key} issue`, priority: "low",
	assignee_id: null, assignee_name: null, parent_id: null,
	project_id: p.id, project_key: p.key, project_name: p.name,
	type_key: null, type_name: null, status_id: "todo", status_key: "todo",
	status_name: "Todo", status_category: "todo", sprint_id: null,
	updated_at: 1000, created_at: 1000,
}));

function mockApi(projects: Promise<unknown> = Promise.resolve(PROJECTS)) {
	const requests: URL[] = [];
	vi.stubGlobal("fetch", vi.fn(async (input: string) => {
		const url = new URL(input, window.location.origin);
		if (url.pathname === "/api/projects") return { ok: true, json: () => projects };
		if (url.pathname === "/api/issues") {
			requests.push(url);
			const items = ISSUES.filter((i) => !url.searchParams.has("project") ||
				i.project_id === url.searchParams.get("project"));
			return { ok: true, json: async () => ({ items, total: items.length, nextCursor: null }) };
		}
		return { ok: true, json: async () => url.pathname === "/api/task-statuses" ? [
			{ id: "todo", key: "todo", name: "Todo", category: "todo", color: null },
		] : [] };
	}));
	return requests;
}

function mountIssues() {
	// Separate roots match Astro's independent client:load islands.
	render(<ProjectNav pageLabel="Issues" />);
	render(<IssueList />);
}

async function chooseProject(label: string) {
	fireEvent.click(await screen.findByRole("combobox", { name: "Filter by project" }));
	fireEvent.click(await screen.findByRole("option", { name: label }));
}

async function expectScope(key: "ALPHA" | "BETA" | "") {
	await waitFor(() => {
		const selected = screen.getByRole("combobox", { name: "Filter by project" });
		expect(selected.textContent).toContain(key ? `${key === "ALPHA" ? "Alpha" : "Beta"} project` : "All projects");
		for (const p of PROJECTS) {
			if (!key || key === p.key) expect(screen.getByText(`${p.key} issue`)).toBeTruthy();
			else expect(screen.queryByText(`${p.key} issue`)).toBeNull();
		}
		const heading = screen.queryByRole("heading", { level: 2 });
		expect(heading?.textContent ?? null).toBe(key ? `${key === "ALPHA" ? "Alpha" : "Beta"} project` : null);
	});
}

beforeEach(() => {
	__resetProjectStoreForTests();
	localStorage.clear();
	history.replaceState(null, "", "/issues");
});

describe("shared project navigation and issue filtering", () => {
	it.each(["projectId=p1", "project=ALPHA", "id=p1"])(
		"resolves %s before the first issues request", async (query) => {
			history.replaceState(null, "", `/issues?${query}`);
			const requests = mockApi();
			mountIssues();
			await expectScope("ALPHA");
			expect(requests.length).toBe(1);
			expect(requests[0].searchParams.get("project")).toBe("p1");
			expect(new URLSearchParams(location.search).get("projectId")).toBe("p1");
			expect(new URLSearchParams(location.search).has("project")).toBe(false);
		}
	);

	it("inherits Overview's project on the plain Issues tab, then survives reload", async () => {
		history.replaceState(null, "", "/projects/view/beta");
		const requests = mockApi();
		const overview = render(<ProjectNav />);
		await screen.findByRole("heading", { name: "Beta project" });
		const href = screen.getByRole("link", { name: "Issues" }).getAttribute("href");
		expect(href).toBe("/issues");
		overview.unmount();
		// Simulate ClientRouter's root replacement without resetting module identity.
		history.pushState({ index: 1 }, "", href ?? "/issues");
		mountIssues();
		await expectScope("BETA");
		expect(requests.every((url) => url.searchParams.get("project") === "p2")).toBe(true);
		cleanup();
		__resetProjectStoreForTests();
		mountIssues();
		await expectScope("BETA");
	});

	it("keeps explicit All after a legacy project link, rerender and reload", async () => {
		history.replaceState(null, "", "/issues?project=ALPHA");
		mockApi();
		mountIssues();
		await expectScope("ALPHA");
		await chooseProject("All projects");
		await expectScope("");
		expect(new URLSearchParams(location.search).has("projectId")).toBe(false);
		expect(new URLSearchParams(location.search).get("project")).toBe("");
		expect(document.title).toBe("Issues — Projektor");
		cleanup();
		__resetProjectStoreForTests();
		mountIssues();
		await expectScope("");
	});

	it("offers other projects while filtered, updates every island, and survives reload", async () => {
		history.replaceState(null, "", "/issues?project=ALPHA");
		mockApi();
		mountIssues();
		await expectScope("ALPHA");
		await chooseProject("Beta project");
		await expectScope("BETA");
		expect(new URLSearchParams(location.search).get("projectId")).toBe("p2");
		expect(new URLSearchParams(location.search).has("project")).toBe(false);
		expect(document.title).toBe("Issues — Beta project");
		cleanup();
		__resetProjectStoreForTests();
		mountIssues();
		await expectScope("BETA");
	});

	it("restores scope and other filters on Back/Forward in mounted islands", async () => {
		history.replaceState({ index: 1 }, "", "/issues?projectId=p1");
		const requests = mockApi();
		mountIssues();
		await expectScope("ALPHA");
		history.pushState({ index: 2 }, "", "/issues?projectId=p2&priority=low#results");
		document.dispatchEvent(new Event("astro:page-load"));
		await expectScope("BETA");
		await waitFor(() => expect(requests.at(-1)?.searchParams.get("priorities")).toBe("low"));
		history.back();
		await expectScope("ALPHA");
		await waitFor(() => expect(requests.at(-1)?.searchParams.has("priorities")).toBe(false));
		history.forward();
		await expectScope("BETA");
		await waitFor(() => expect(requests.at(-1)?.searchParams.get("priorities")).toBe("low"));
		expect(location.hash).toBe("#results");
		expect(history.state).toEqual({ index: 2 });
	});

	it("does not use a stale localStorage project on a cold workspace-wide entry", async () => {
		localStorage.setItem("projektor-last-project-id", "p2");
		const requests = mockApi();
		mountIssues();
		await expectScope("");
		expect(requests.every((url) => !url.searchParams.has("project"))).toBe(true);
	});

	it("does not broaden an invalid project URL into all issues", async () => {
		history.replaceState(null, "", "/issues?projectId=missing");
		const requests = mockApi();
		mountIssues();
		await waitFor(() => expect(screen.getAllByText("Project not found").length).toBeGreaterThan(0));
		expect(requests.length).toBe(0);
	});

	it("resolves a slow project even if unrelated filters normalize during the request", async () => {
		history.replaceState(null, "", "/issues?projectId=p1&hideEpics=0&status=todo,,");
		let resolveProjects: (projects: unknown) => void = () => {};
		mockApi(new Promise((resolve) => { resolveProjects = resolve; }));
		mountIssues();
		await waitFor(() => expect(new URLSearchParams(location.search).has("hideEpics")).toBe(false));
		resolveProjects(PROJECTS);
		await expectScope("ALPHA");
	});
});

describe("partial board and list visibility", () => {
	it("labels partial counts until the short first page's cursor finishes", async () => {
		localStorage.setItem("issues-view", "board");
		history.replaceState(null, "", "/issues?projectId=p1");
		const items: Issue[] = Array.from({ length: 36 }, (_, i) => ({
			...ISSUES[0], id: `board-${i}`, number: i + 1, title: `Board fixture ${i}`,
			status_category: i === 34 ? "in_progress" : i === 35 ? "done" : "todo",
		}));
		let finish: (response: unknown) => void = () => {};
		vi.stubGlobal("fetch", vi.fn(async (input: string) => {
			const url = new URL(input, location.origin);
			if (url.pathname === "/api/projects") return { ok: true, json: async () => PROJECTS };
			if (url.pathname !== "/api/issues") return { ok: true, json: async () => [] };
			if (url.searchParams.has("cursor")) return new Promise((resolve) => { finish = resolve; });
			return { ok: true, json: async () => ({ items: items.slice(0, 30), nextCursor: "tail", total: 36 }) };
		}));
		mountIssues();
		await waitFor(() => expect(screen.getByRole("status").textContent).toContain("only 30 loaded issues"));
		finish({ ok: true, json: async () => ({ items: items.slice(30), nextCursor: null, total: null }) });
		await screen.findByText("Board fixture 35");
		await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
		expect(screen.getByText("36 issues")).toBeTruthy();
		expect(screen.getByRole("region", { name: "In Progress column" }).textContent).toContain("Board fixture 34");
		expect(screen.getByRole("region", { name: "Done column" }).textContent).toContain("Board fixture 35");
	});
});

describe("project-scoped lookup loading", () => {
	it.each(["p1", "missing"])("never prefetches global epics while %s resolves", async (id) => {
		history.replaceState(null, "", `/issues?projectId=${id}`);
		let finish: (value: unknown) => void = () => {};
		let typesRequested = false;
		const requests: URL[] = [];
		const projects = new Promise((resolve) => { finish = resolve; });
		vi.stubGlobal("fetch", vi.fn(async (input: string) => {
			const url = new URL(input, location.origin);
			if (url.pathname === "/api/projects") return { ok: true, json: () => projects };
			if (url.pathname === "/api/task-types") {
				typesRequested = true;
				return { ok: true, json: async () => [{ id: "epic", key: "epic", name: "Epic" }] };
			}
			if (url.pathname === "/api/issues") {
				requests.push(url);
				return { ok: true, json: async () => ({ items: [], total: 0, nextCursor: null }) };
			}
			return { ok: true, json: async () => [] };
		}));
		mountIssues();
		await waitFor(() => expect(typesRequested).toBe(true));
		expect(requests.length).toBe(0);
		finish(PROJECTS);
		if (id === "missing") {
			await waitFor(() => expect(screen.getAllByText("Project not found").length).toBeGreaterThan(0));
			expect(requests.length).toBe(0);
		} else {
			await waitFor(() => expect(requests.some((url) => url.searchParams.has("typeId"))).toBe(true));
			expect(requests.every((url) => url.searchParams.get("project") === "p1")).toBe(true);
		}
	});
});
