import DOMPurify from "dompurify";
import { marked } from "marked";
export function safeMarkdown(source: string): string {
  return DOMPurify.sanitize(marked.parse(source, { async: false }) as string, {
    USE_PROFILES: { html: true },
  });
}
