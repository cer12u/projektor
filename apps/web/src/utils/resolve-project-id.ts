import { apiFetch } from "./api-client";

export interface ProjectIdCandidate {
	id: string;
}

export interface ResolveProjectIdResult<T extends ProjectIdCandidate> {
	project: T | null;
	projects: T[];
	error: string | null;
}

// `id` is a legacy project alias only on project-level pages. On detail
// pages it belongs to the issue/wiki entity and must never be overwritten.
function acceptsLegacyProjectId(): boolean {
	return /^\/(?:projects\/view|issues|wiki|sprints|epics|metrics|feedback)?\/?$/.test(
		window.location.pathname
	);
}

export function readUrlProjectId(): string | null {
	if (typeof window === "undefined") return null;
	const params = new URLSearchParams(window.location.search);
	let slug = window.location.pathname.match(/^\/projects\/view\/([^/]+)\/?$/)?.[1];
	if (slug) {
		try {
			slug = decodeURIComponent(slug);
		} catch {
			// A malformed shared URL resolves to not-found instead of crashing render.
		}
	}
	// An empty ?project= is an explicit All selection; null means no URL hint
	// and allows same-project ClientRouter links to inherit the shared store.
	return (
		params.get("projectId") ??
		slug ??
		params.get("project") ??
		(acceptsLegacyProjectId() ? params.get("id") : null)
	);
}

export function persistProjectId(id: string | null): void {
	if (typeof window === "undefined") return;
	const url = new URL(window.location.href);
	url.searchParams.delete("project");
	if (acceptsLegacyProjectId()) url.searchParams.delete("id");
	if (id) {
		url.searchParams.set("projectId", id);
	} else {
		url.searchParams.delete("projectId");
		url.searchParams.set("project", "");
	}
	if (url.href !== window.location.href) {
		// Keep Astro's navigation state and any anchor when canonicalizing.
		history.replaceState(history.state, "", url);
	}
}

export async function fetchProjects<T extends ProjectIdCandidate>(
	workspaceSlug: string | undefined
): Promise<T[]> {
	const list = await apiFetch<T[]>("/api/projects", { workspaceSlug });
	return Array.isArray(list) ? list : [];
}

export function matchProjectId<T extends ProjectIdCandidate>(
	projects: readonly T[],
	urlHint: string | null,
	matches: (project: T, hint: string) => boolean = (p, hint) => p.id === hint
): { project: T | null; error: string | null } {
	if (urlHint) {
		const matched = projects.find((p) => matches(p, urlHint)) ?? null;
		if (matched) {
			persistProjectId(matched.id);
			return { project: matched, error: null };
		}
		return { project: null, error: "Project not found" };
	}

	const resolved = urlHint === "" ? null : projects[0] || null;
	if (resolved || urlHint === "") persistProjectId(resolved?.id ?? null);
	return { project: resolved, error: null };
}

export async function resolveProjectId<T extends ProjectIdCandidate>(
	workspaceSlug: string | undefined,
	urlHint: string | null = readUrlProjectId(),
	matches?: (project: T, hint: string) => boolean
): Promise<ResolveProjectIdResult<T>> {
	let projects: T[];
	try {
		projects = await fetchProjects<T>(workspaceSlug);
	} catch {
		return { project: null, projects: [], error: "Failed to load projects" };
	}

	const { project, error } = matchProjectId(projects, urlHint, matches);
	return { project, projects, error };
}
