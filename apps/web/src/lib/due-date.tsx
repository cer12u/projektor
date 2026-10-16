import type { Issue } from "../islands/board-utils";

export function localToday(): string {
  const date = new Date();
  const year = date.getFullYear();
  return `${year}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function isOverdue(issue: Pick<Issue, "due_date" | "status_category">): boolean {
  return !!issue.due_date && issue.due_date < localToday() &&
    issue.status_category !== "done" && issue.status_category !== "cancelled";
}

export function DueDate({ issue }: { issue: Pick<Issue, "due_date" | "status_category"> }) {
  if (!issue.due_date) return null;
  const [year, month, day] = issue.due_date.split("-").map(Number);
  return <span class={isOverdue(issue) ? "text-danger-text" : "text-text-muted"}>
    {new Date(year, month - 1, day).toLocaleDateString()}
  </span>;
}
