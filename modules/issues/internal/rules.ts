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

/** Whitespace-separated literal substrings; punctuation cannot become FTS syntax. */
export function searchTerms(text: string): readonly string[] {
  return text.match(/\S+/gu)?.filter((term) => /[\p{L}\p{N}]/u.test(term)) ?? [];
}
export function searchExpression(terms: readonly string[]): string {
  return terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" AND ");
}
export function searchPattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
}
