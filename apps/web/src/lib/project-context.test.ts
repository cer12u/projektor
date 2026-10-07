import { beforeEach, describe, expect, it, vi } from "vitest";
import { __resetApiFetchStateForTests } from "../utils/api-client";
import {
	__resetProjectStoreForTests, currentProject, ensureProjectResolved,
	projectError, projectReady, projectsList, selectProject,
} from "./project-context";

const PROJECTS = [
	{ id: "p1", key: "ALPHA", name: "Alpha", slug: "alpha" },
	{ id: "p2", key: "BETA", name: "Beta", slug: "beta" },
];

beforeEach(() => {
	__resetProjectStoreForTests();
	history.replaceState(null, "", "/issues");
});

describe("shared project resolution races", () => {
	it("does not let an old project request override an explicit All selection", async () => {
		let finish: (value: unknown) => void = () => {};
		vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: () => new Promise((resolve) => { finish = resolve; }) })));
		const pending = ensureProjectResolved(undefined, "p1");
		await Promise.resolve();
		selectProject(null);
		finish(PROJECTS);
		await pending;
		expect(currentProject.value).toBeNull();
		expect(projectReady.value).toBe(true);
		expect(new URLSearchParams(location.search).get("project")).toBe("");
	});

	it("lets the latest URL win while sharing a pending project request", async () => {
		let finish: (value: unknown) => void = () => {};
		vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: () => new Promise((resolve) => { finish = resolve; }) })));
		history.replaceState(null, "", "/issues?projectId=p1");
		const first = ensureProjectResolved(undefined);
		await Promise.resolve();
		history.replaceState(null, "", "/issues?projectId=p2");
		const last = ensureProjectResolved(undefined);
		finish(PROJECTS);
		await Promise.all([first, last]);
		expect(currentProject.value?.id).toBe("p2");
		expect(projectError.value).toBeNull();
	});

	it("discards an old workspace result and never reuses its project list", async () => {
		let finishOld: (value: unknown) => void = () => {};
		vi.stubGlobal("fetch", vi.fn(async (_url: string, options: RequestInit) => ({
			ok: true,
			json: () => (options.headers as Record<string, string>)["X-Workspace-Slug"] === "old"
				? new Promise((resolve) => { finishOld = resolve; })
				: Promise.resolve([PROJECTS[1]]),
		})));
		const old = ensureProjectResolved("old", "p1");
		await Promise.resolve();
		await ensureProjectResolved("new", "p2");
		finishOld([PROJECTS[0]]);
		await old;
		expect(currentProject.value?.id).toBe("p2");
		expect(projectsList.value).toEqual([PROJECTS[1]]);
		await ensureProjectResolved("new", null);
		expect(currentProject.value?.id).toBe("p2");
	});

	it("resolves mixed legacy/canonical overview parameters consistently", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => PROJECTS })));
		history.replaceState(null, "", "/projects/view?projectId=p2&id=p1");
		await ensureProjectResolved(undefined);
		expect(currentProject.value?.id).toBe("p2");
		expect(new URLSearchParams(location.search).has("id")).toBe(false);
	});
});

describe("project-store isolation", () => {
	it("drops pending and cached identity when starting a new tab", async () => {
		let finishOld: (value: unknown) => void = () => {};
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce({
				ok: true,
				json: () =>
					new Promise((resolve) => {
						finishOld = resolve;
					}),
			})
			.mockResolvedValue({ ok: true, json: async () => [PROJECTS[1]] });
		vi.stubGlobal("fetch", fetchMock);
		const old = ensureProjectResolved(undefined, "p1");
		await Promise.resolve();
		__resetProjectStoreForTests();
		expect(projectReady.value).toBe(false);
		expect(currentProject.value).toBeNull();
		expect(projectsList.value).toEqual([]);
		// apiFetch's independent in-flight map resets at the same tab boundary.
		__resetApiFetchStateForTests();
		await ensureProjectResolved(undefined, "p2");
		finishOld([PROJECTS[0]]);
		await old;
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(currentProject.value?.id).toBe("p2");
		expect(projectsList.value).toEqual([PROJECTS[1]]);
		expect(new URLSearchParams(window.location.search).get("projectId")).toBe("p2");
	});
});
