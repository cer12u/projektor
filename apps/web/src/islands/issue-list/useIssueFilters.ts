import { type StateUpdater, useState } from "preact/hooks";
import { currentProject, selectProject, useCurrentProject } from "../../lib/project-context";
import { readUrlProjectId } from "../../utils/resolve-project-id";
import type { SortKey } from "../board-utils";
import type { SavedViewFilters } from "../saved-views";
import type { DateField } from "./FiltersPopover";
import { parseDateField, parseListParam, useFilterUrlSync } from "./useFilterUrlSync";

function readInitialFilters() {
	const params = new URLSearchParams(typeof window === "undefined" ? "" : window.location.search);
	return {
		statuses: parseListParam(params.get("status")),
		priorities: parseListParam(params.get("priority")),
		epic: params.get("epic") ?? "",
		sprintId: params.get("sprintId") ?? "",
		hideEpics: params.get("hideEpics") === "1",
		dateField: parseDateField(params.get("dateField")),
		dateFrom: params.get("dateFrom") ?? "",
		dateTo: params.get("dateTo") ?? "",
	};
}

/** Owns all issue-list filter/sort state, plus URL <-> state sync (PROJ-60/211/212). */
export function useIssueFilters(workspaceSlug?: string) {
	const scope = useCurrentProject(
		workspaceSlug,
		readUrlProjectId() ?? (currentProject.value ? null : "")
	);
	const filterProject = scope.project?.key ?? "";
	function setFilterProject(value: StateUpdater<string>) {
		const key = typeof value === "function" ? value(filterProject) : value;
		const project = key ? scope.projects.find((p) => p.key === key) : null;
		// A deleted project in a saved view must never broaden into All silently.
		if (project === undefined) return;
		selectProject(project);
	}
	// PROJ-862: lazy initialisers read the URL on the first render, so the first
	// issues request already carries the filters.
	const [initial] = useState(readInitialFilters);
	const [filterStatuses, setFilterStatuses] = useState<string[]>(initial.statuses);
	const [filterPriorities, setFilterPriorities] = useState<string[]>(initial.priorities);
	const [filterType, setFilterType] = useState("");
	const [filterEpicId, setFilterEpicId] = useState(initial.epic);
	const [hideEpics, setHideEpics] = useState(initial.hideEpics);
	const [filterDateField, setFilterDateField] = useState<DateField>(initial.dateField);
	const [filterDateFrom, setFilterDateFrom] = useState(initial.dateFrom);
	const [filterDateTo, setFilterDateTo] = useState(initial.dateTo);
	const [filterSprintId, setFilterSprintId] = useState(initial.sprintId);
	const [sortBy, setSortBy] = useState<SortKey>("created_at");
	const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

	useFilterUrlSync({
		filterStatuses,
		setFilterStatuses,
		filterPriorities,
		setFilterPriorities,
		filterEpicId,
		setFilterEpicId,
		filterSprintId,
		setFilterSprintId,
		hideEpics,
		setHideEpics,
		filterDateField,
		setFilterDateField,
		filterDateFrom,
		setFilterDateFrom,
		filterDateTo,
		setFilterDateTo,
	});

	function handleHeaderClick(key: SortKey) {
		if (sortBy === key) {
			setSortDir((d) => (d === "asc" ? "desc" : "asc"));
		} else {
			setSortBy(key);
			setSortDir("asc");
		}
	}

	const filtersBundle: SavedViewFilters = {
		statuses: filterStatuses,
		priorities: filterPriorities,
		project: filterProject,
		type: filterType,
		epicId: filterEpicId,
		sprintId: filterSprintId,
		hideEpics,
		dateField: filterDateField,
		dateFrom: filterDateFrom,
		dateTo: filterDateTo,
	};

	function applyFilters(filters: SavedViewFilters) {
		setFilterStatuses(filters.statuses);
		setFilterPriorities(filters.priorities);
		setFilterProject(filters.project);
		setFilterType(filters.type);
		setFilterEpicId(filters.epicId);
		setFilterSprintId(filters.sprintId);
		setHideEpics(filters.hideEpics);
		setFilterDateField(parseDateField(filters.dateField));
		setFilterDateFrom(filters.dateFrom);
		setFilterDateTo(filters.dateTo);
	}

	return {
		projectScopeReady: scope.ready && !scope.error,
		projectScopeError: scope.error,
		filterStatuses,
		setFilterStatuses,
		filterPriorities,
		setFilterPriorities,
		filterProject,
		setFilterProject,
		filterType,
		setFilterType,
		filterEpicId,
		setFilterEpicId,
		hideEpics,
		setHideEpics,
		filterDateField,
		setFilterDateField,
		filterDateFrom,
		setFilterDateFrom,
		filterDateTo,
		setFilterDateTo,
		filterSprintId,
		setFilterSprintId,
		sortBy,
		setSortBy,
		sortDir,
		setSortDir,
		handleHeaderClick,
		filtersBundle,
		applyFilters,
	};
}
