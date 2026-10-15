import { useEffect, useMemo, useState } from "preact/hooks";
import { projectReady, projectsList } from "../../lib/project-context";
import { apiFetch } from "../../utils/api-client";
import type { Issue, TaskStatus } from "../board-utils";
import type { SprintDetail } from "./SprintBannerSection";
import type { ProjectMeta } from "./types";

/**
 * Owns the active project's sprints and the active sprint's detail (for the
 * sprint banner + selector), separated from the other lookups so each hook
 * stays a manageable size.
 */
function useSprintLookups(
	workspaceSlug: string | undefined,
	filterProject: string,
	filterSprintId: string,
	projects: ProjectMeta[],
	scopeReady: boolean
) {
	const [sprints, setSprints] = useState<Array<{ id: string; name: string; status: string }>>([]);
	const [sprintDetail, setSprintDetail] = useState<SprintDetail | null>(null);

	// Fetch project's sprints when project filter is active, or when a sprintId is set
	// (so the sprint selector appears even when navigating directly to a ?sprintId= URL).
	useEffect(() => {
		let cancelled = false;
		setSprints([]);
		if (!scopeReady) return;
		const fallbackProjectId = !filterProject && sprintDetail ? sprintDetail.projectId : null;
		if (!filterProject && !fallbackProjectId) return;
		(async () => {
			try {
				let projectId: string;
				if (fallbackProjectId) {
					projectId = fallbackProjectId;
				} else {
					const proj = projects.find((p) => p.key === filterProject);
					if (!proj) return;
					projectId = proj.id;
				}
				const data = await apiFetch<{ items: Array<{ id: string; name: string; status: string }> }>(
					`/api/sprints?projectId=${encodeURIComponent(projectId)}`,
					{ workspaceSlug }
				);
				if (!cancelled) setSprints(Array.isArray(data?.items) ? data.items : []);
			} catch {
				// non-fatal
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [filterProject, sprintDetail, workspaceSlug, projects, scopeReady]);

	// Fetch sprint details when a sprintId filter is active, for the sprint banner.
	useEffect(() => {
		let cancelled = false;
		setSprintDetail(null);
		if (!filterSprintId) return;
		(async () => {
			try {
				const data = await apiFetch<SprintDetail>(`/api/sprints/${filterSprintId}`, {
					workspaceSlug,
				});
				if (!cancelled) setSprintDetail(data);
			} catch {
				// non-fatal
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [filterSprintId, workspaceSlug]);

	return { sprints, setSprints, sprintDetail, setSprintDetail };
}

/**
 * Owns the lookup lists behind the issue list: statuses, projects, task types,
 * the epic dropdown, the active project's sprints, and the active sprint's detail.
 */
export function useIssueLookups(
	workspaceSlug: string | undefined,
	filterProject: string,
	filterSprintId: string,
	scopeReady = true
) {
	const [statuses, setStatuses] = useState<TaskStatus[]>([]);
	const sharedProjects = projectsList.value;
	const projects = useMemo(
		() => sharedProjects.map((p) => ({ ...p, description: p.description ?? null })),
		[sharedProjects]
	);
	const [taskTypes, setTaskTypes] = useState<Array<{ id: string; key: string; name: string }>>([]);
	// PROJ-862: whether each lookup has settled (success or failure), so the issue fetch
	// can wait for exactly the lookups its filters need instead of firing unfiltered.
	const projectsLoaded = projectReady.value;
	const [taskTypesLoaded, setTaskTypesLoaded] = useState(false);
	// Epics for the epic filter dropdown — fetched independently of the paginated
	// list (PROJ-211) so the dropdown is complete and survives "Hide epics", which
	// now excludes epic-typed issues from the list server-side.
	const [epics, setEpics] = useState<Issue[]>([]);
	const { sprints, setSprints, sprintDetail, setSprintDetail } = useSprintLookups(
		workspaceSlug,
		filterProject,
		filterSprintId,
		projects,
		scopeReady
	);

	useEffect(() => {
		let cancelled = false;
		(async () => {
			try {
				const data = await apiFetch<TaskStatus[]>("/api/task-statuses", { workspaceSlug });
				if (!cancelled && Array.isArray(data)) setStatuses(data);
			} catch {
				// non-fatal — status filter will derive from issue data
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [workspaceSlug]);

	// Fetch task types for the create modal type selector (PROJ-157)
	useEffect(() => {
		let cancelled = false;
		(async () => {
			try {
				const data = await apiFetch<Array<{ id: string; key: string; name: string }>>(
					"/api/task-types",
					{
						workspaceSlug,
					}
				);
				if (!cancelled && Array.isArray(data)) setTaskTypes(data);
			} catch {
				// non-fatal
			} finally {
				if (!cancelled) setTaskTypesLoaded(true);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [workspaceSlug]);

	// Fetch epics for the epic filter dropdown, independent of the paginated list
	// (PROJ-211). Scoped to the active project filter when set. Keyed on the
	// derived ids, not the lookup-array identities — a fresh projects/taskTypes
	// array that resolves to the same ids must not refire this fetch.
	const epicTypeId = taskTypes.find((t) => t.key === "epic")?.id;
	const epicProjectId = filterProject
		? projects.find((p) => p.key === filterProject)?.id
		: undefined;
	// PROJ-862: with a project in the URL, wait for it to resolve — otherwise this
	// fetches every epic in the workspace first and then again for the project.
	const epicsReady = scopeReady && projectsLoaded && (!filterProject || !!epicProjectId);
	useEffect(() => {
		let cancelled = false;
		setEpics([]);
		if (!epicTypeId || !epicsReady) return;
		(async () => {
			try {
				const qs = new URLSearchParams({ typeId: epicTypeId, limit: "100" });
				if (epicProjectId) qs.set("project", epicProjectId);
				const data = await apiFetch<{ items: Issue[] }>(`/api/issues?${qs.toString()}`, {
					workspaceSlug,
				});
				if (!cancelled) setEpics(Array.isArray(data.items) ? data.items : []);
			} catch {
				// non-fatal — epic dropdown just won't populate
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [workspaceSlug, epicTypeId, epicProjectId, epicsReady]);

	return {
		statuses,
		projects,
		projectsLoaded,
		taskTypes,
		taskTypesLoaded,
		epics,
		sprints,
		sprintDetail,
		setSprintDetail,
		setSprints,
	};
}
