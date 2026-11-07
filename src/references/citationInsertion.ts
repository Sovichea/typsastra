import type { TypstSourceContext } from "../editor/typstLanguage";

export type CitationInsertResult =
  | { ok: true }
  | { ok: false; message: string };

const SAFE_REFERENCE_KEY = /^[\p{L}\p{N}_:-]+$/u;

/**
 * Picks insertion syntax that is valid in the surrounding Typst mode.
 *
 * `#cite(...)` is valid in markup and math, while code requires the bare
 * `cite(...)` expression. Unusual BibTeX keys are passed through `label(...)`
 * so punctuation cannot break the citation syntax.
 */
export function citationSnippet(key: string, context: TypstSourceContext): string {
  if (SAFE_REFERENCE_KEY.test(key)) {
    if (context.mode === "markup") return `@${key}`;
    if (context.mode === "math") return `#cite(<${key}>)`;
    return `cite(<${key}>)`;
  }
  const label = `label(${JSON.stringify(key)})`;
  return context.mode === "code" ? `cite(${label})` : `#cite(${label})`;
}

export function citationKeyIsReferenceSafe(key: string): boolean {
  return SAFE_REFERENCE_KEY.test(key);
}
