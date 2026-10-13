import type { IssueState } from "../public";

const transitions: Readonly<Record<IssueState, readonly IssueState[]>> = {
  todo: ["in_progress", "cancelled"],
  in_progress: ["todo", "done", "cancelled"],
  done: ["in_progress"],
  cancelled: ["todo"],
};

export function canTransition(from: IssueState, to: IssueState): boolean {
  return transitions[from].includes(to);
}

/** Only literal Unicode word tokens reach FTS5 syntax. */
export function searchExpression(text: string): string | null {
  const terms = text.match(/[\p{L}\p{N}]+/gu)?.slice(0, 12);
  return terms?.length ? terms.map((term) => `"${term}"`).join(" AND ") : null;
}
