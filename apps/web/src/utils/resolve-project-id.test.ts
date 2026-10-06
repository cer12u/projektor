import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { persistProjectId, readUrlProjectId, resolveProjectId } from "./resolve-project-id";

const PROJECTS = [
	{ id: "p1", key: "PROJ", name: "Projektor" },
	{ id: "p2", key: "OTHER", name: "Other" },
];

function mockProjects(list: readonly unknown[] = PROJECTS) {
	vi.stubGlobal(
		"fetch",
		vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(list) })
	);
}

beforeEach(() => {
	history.replaceState(null, "", "/");
	localStorage.clear();
});

afterEach(() => {
	history.replaceState(null, "", "/");
	localStorage.clear();
});

describe("readUrlProjectId", () => {
	it("reads ?projectId= first, then ?id=", () => {
		history.replaceState(null, "", "?id=fromId");
		expect(readUrlProjectId()).toBe("fromId");
		history.replaceState(null, "", "?projectId=fromProjectId&id=fromId");
		expect(readUrlProjectId()).toBe("fromProjectId");
	});

	it("returns null when neither param is present", () => {
		expect(readUrlProjectId()).toBeNull();
	});
});

describe("resolveProjectId", () => {
	it("resolves a valid URL hint and persists it only to the URL", async () => {
		mockProjects();
		const res = await resolveProjectId(undefined, "p2");
		expect(res.project).toEqual(PROJECTS[1]);
		expect(res.error).toBeNull();
		expect(localStorage.getItem("projektor-last-project-id")).toBeNull();
		expect(new URLSearchParams(window.location.search).get("projectId")).toBe("p2");
	});

	it("returns an error (not a silent null) for an unknown URL hint", async () => {
		mockProjects();
		const res = await resolveProjectId(undefined, "does-not-exist");
		expect(res.project).toBeNull();
		expect(res.error).toBe("Project not found");
		expect(localStorage.getItem("projektor-last-project-id")).toBeNull();
	});

	it("ignores an old stored project id when there is no URL hint", async () => {
		localStorage.setItem("projektor-last-project-id", "p2");
		mockProjects();
		const res = await resolveProjectId(undefined, null);
		expect(res.project).toEqual(PROJECTS[0]);
		expect(res.error).toBeNull();
	});

	it("falls through a stale stored id to the first project, rather than erroring", async () => {
		localStorage.setItem("projektor-last-project-id", "stale-id");
		mockProjects();
		const res = await resolveProjectId(undefined, null);
		expect(res.project).toEqual(PROJECTS[0]);
		expect(res.error).toBeNull();
		expect(localStorage.getItem("projektor-last-project-id")).toBe("stale-id");
	});

	it("falls back to the first project when there is no stored id", async () => {
		mockProjects();
		const res = await resolveProjectId(undefined, null);
		expect(res.project).toEqual(PROJECTS[0]);
	});

	it("resolves to null without an error when the workspace has no projects", async () => {
		mockProjects([]);
		const res = await resolveProjectId(undefined, null);
		expect(res.project).toBeNull();
		expect(res.error).toBeNull();
	});

	it("surfaces a fetch failure as an error", async () => {
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
		const res = await resolveProjectId(undefined, null);
		expect(res.project).toBeNull();
		expect(res.error).toBe("Failed to load projects");
	});

	it("accepts a custom matcher, e.g. to resolve a hint by key as well as id", async () => {
		mockProjects();
		const res = await resolveProjectId(
			undefined,
			"OTHER",
			(p: (typeof PROJECTS)[number], hint) => p.id === hint || p.key === hint
		);
		expect(res.project).toEqual(PROJECTS[1]);
	});
});


describe("project identity URL boundaries", () => {
	it("recognizes legacy project keys, pretty slugs, and explicit All", () => {
		history.replaceState(null, "", "/issues?project=OTHER");
		expect(readUrlProjectId()).toBe("OTHER");
		history.replaceState(null, "", "/projects/view/other-project");
		expect(readUrlProjectId()).toBe("other-project");
		history.replaceState(null, "", "/issues?project=");
		expect(readUrlProjectId()).toBe("");
	});

	it("canonicalizes legacy aliases while preserving filters, hash and router state", () => {
		const routerState = { index: 3 };
		history.replaceState(routerState, "", "/issues?id=p1&project=PROJ&status=todo#results");
		persistProjectId("p2");
		expect(window.location.search).toBe("?status=todo&projectId=p2");
		expect(window.location.hash).toBe("#results");
		expect(history.state).toEqual(routerState);
		persistProjectId(null);
		expect(window.location.search).toBe("?status=todo&project=");
	});

	it("does not interpret or remove an issue detail id as a project id", () => {
		history.replaceState(null, "", "/issues/view?id=issue-1");
		expect(readUrlProjectId()).toBeNull();
		persistProjectId("p2");
		expect(new URLSearchParams(window.location.search).get("id")).toBe("issue-1");
	});

	it("resolves explicit All without consulting stored project ids", async () => {
		localStorage.setItem("projektor-last-project-id", "p2");
		mockProjects();
		const res = await resolveProjectId(undefined, "");
		expect(res.project).toBeNull();
		expect(res.error).toBeNull();
		expect(new URLSearchParams(window.location.search).get("project")).toBe("");
	});
});


it("does not throw when a pretty project slug contains malformed escapes", () => {
	history.replaceState(null, "", "/projects/view/%ZZ");
	expect(readUrlProjectId()).toBe("%ZZ");
});
