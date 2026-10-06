import { batch, signal } from "@preact/signals";
import { useEffect } from "preact/hooks";
import {
	fetchProjects,
	matchProjectId,
	persistProjectId,
	type ProjectIdCandidate,
	readUrlProjectId,
} from "../utils/resolve-project-id";

export interface ProjectSummary extends ProjectIdCandidate {
	key: string;
	name: string;
	slug: string | null;
	description?: string | null;
}

export const currentProject = signal<ProjectSummary | null>(null);
export const projectsList = signal<ProjectSummary[]>([]);
export const projectError = signal<string | null>(null);
export const projectReady = signal(false);

let resolutionSequence = 0;
let activeWorkspace: string | undefined;
let hasWorkspace = false;

let projectsPromise: Promise<ProjectSummary[]> | null = null;

function loadProjects(workspaceSlug: string | undefined): Promise<ProjectSummary[]> {
	if (projectsList.value.length > 0) return Promise.resolve(projectsList.value);
	if (!projectsPromise) {
		const request: Promise<ProjectSummary[]> = fetchProjects<ProjectSummary>(workspaceSlug).catch(
			() => {
				if (projectsPromise === request) projectsPromise = null;
				throw new Error("Failed to load projects");
			}
		);
		projectsPromise = request;
	}
	return projectsPromise;
}

function matchesProject(project: ProjectSummary, hint: string): boolean {
	return project.id === hint || project.key === hint || project.slug === hint;
}

/** Explicit selection shares the same identity with every island. */
export function selectProject(project: ProjectSummary | null): void {
	resolutionSequence++;
	persistProjectId(project?.id ?? null);
	batch(() => {
		currentProject.value = project;
		projectError.value = null;
		projectReady.value = true;
	});
}

export async function ensureProjectResolved(
	workspaceSlug: string | undefined,
	urlHint: string | null = readUrlProjectId(),
	matches: (project: ProjectSummary, hint: string) => boolean = matchesProject
): Promise<void> {
	if (!hasWorkspace || activeWorkspace !== workspaceSlug) {
		resetProjectStore();
		activeWorkspace = workspaceSlug;
		hasWorkspace = true;
	}
	const sequence = ++resolutionSequence;
	const pathname = typeof window === "undefined" ? null : window.location.pathname;
	const initialHint = readUrlProjectId();
	const superseded = () =>
		sequence !== resolutionSequence ||
		(pathname !== null &&
			(pathname !== window.location.pathname || initialHint !== readUrlProjectId()));
	if (
		projectReady.value &&
		!projectError.value &&
		(urlHint === null ||
			(urlHint === ""
				? !currentProject.value
				: currentProject.value && matches(currentProject.value, urlHint)))
	) {
		// A plain in-project tab inherits the store, then becomes reload/share safe.
		persistProjectId(currentProject.value?.id ?? null);
		return;
	}

	// A cold Issues entry is workspace-wide. Other project-only pages retain
	// their first-project fallback. Explicit All is distinct from an absent hint.
	const hint =
		urlHint === null &&
		typeof window !== "undefined" &&
		/^\/issues\/?$/.test(window.location.pathname)
			? ""
			: urlHint;
	batch(() => {
		projectReady.value = false;
		projectError.value = null;
	});
	try {
		const projects = await loadProjects(workspaceSlug);
		// A later selection/navigation owns the address bar and the store.
		if (superseded()) return;
		const { project, error } = matchProjectId(projects, hint, matches);
		batch(() => {
			projectsList.value = projects;
			currentProject.value = project;
			projectError.value = error;
			projectReady.value = true;
		});
	} catch {
		if (superseded()) return;
		batch(() => {
			currentProject.value = null;
			projectError.value = "Failed to load projects";
			projectReady.value = true;
		});
	}
}

function resetProjectStore(): void {
	hasWorkspace = false;
	activeWorkspace = undefined;
	resolutionSequence++;
	currentProject.value = null;
	projectsList.value = [];
	projectError.value = null;
	projectReady.value = false;
	projectsPromise = null;
}

export const __resetProjectStoreForTests = resetProjectStore;

export function useCurrentProject(
	workspaceSlug: string | undefined,
	urlHint: string | null = readUrlProjectId(),
	matches: (project: ProjectSummary, hint: string) => boolean = matchesProject
) {
	useEffect(() => {
		ensureProjectResolved(workspaceSlug, urlHint, matches);
	}, [workspaceSlug, urlHint]);

	useEffect(() => {
		const onNavigate = () => ensureProjectResolved(workspaceSlug);
		window.addEventListener("popstate", onNavigate);
		document.addEventListener("astro:page-load", onNavigate);
		return () => {
			window.removeEventListener("popstate", onNavigate);
			document.removeEventListener("astro:page-load", onNavigate);
		};
	}, [workspaceSlug]);

	const project = currentProject.value;
	// Never issue a request for yesterday's selection while a new URL resolves.
	const matchesHint =
		urlHint === null || (urlHint === "" ? !project : project && matches(project, urlHint));
	return {
		project,
		projects: projectsList.value,
		error: projectError.value,
		ready:
			hasWorkspace &&
			activeWorkspace === workspaceSlug &&
			projectReady.value &&
			(!!projectError.value || !!matchesHint),
	};
}
