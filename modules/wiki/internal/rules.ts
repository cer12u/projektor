/** Literal whitespace-separated substrings, never user-supplied FTS syntax. */
export function searchTerms(text: string): readonly string[] {
  return text.match(/\S+/gu)?.filter((term) => /[\p{L}\p{N}]/u.test(term)) ?? [];
}
export function searchExpression(terms: readonly string[]): string {
  return terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" AND ");
}
export function searchPattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
}
