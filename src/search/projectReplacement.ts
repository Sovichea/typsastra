import { graphemeBoundaries } from "../editor/grapheme";
import { filePathKey } from "../platform/paths";
import type { ProjectSearchOptions } from "./projectSearch";

export type ProjectReplacementMatch = {
  from: number;
  to: number;
};

export type ProjectReplacementFileRequest = {
  path: string;
  relativePath: string;
  textRevision: string;
  matches: ProjectReplacementMatch[];
};

export type ProjectReplacementRequest = {
  options: ProjectSearchOptions;
  replacement: string;
  files: ProjectReplacementFileRequest[];
};

export type ProjectReplacementResult = {
  ok: boolean;
  message?: string;
  files?: number;
  matches?: number;
};

export type ProjectReplacementBatchFile = {
  path: string;
  before: string;
  after: string;
};

export type ProjectReplacementBatch = {
  files: ProjectReplacementBatchFile[];
  query: string;
  replacement: string;
};

export function projectReplacementMatchKey(path: string, from: number, to: number): string {
  return `${filePathKey(path)}\u0000${from}\u0000${to}`;
}

export function isGraphemeSafeReplacementRange(
  lineText: string,
  from: number,
  to: number,
): boolean {
  if (from < 0 || to < from || to > lineText.length) return false;
  const boundaries = graphemeBoundaries(lineText);
  const startsAtBoundary = from === 0 || boundaries.some(boundary => boundary.from === from);
  const endsAtBoundary = to === lineText.length || boundaries.some(boundary => boundary.to === to);
  return startsAtBoundary && endsAtBoundary;
}

function unquoteRegexReplacement(value: string): string {
  return value.replace(/\\([nrt\\])/g, (_match, character: string) =>
    character === "n" ? "\n" : character === "r" ? "\r" : character === "t" ? "\t" : "\\"
  );
}

function expandReplacement(replacement: string, match: RegExpExecArray): string {
  return replacement.replace(/\$([$&]|\d+)/g, (whole, index: string) => {
    if (index === "&") return match[0];
    if (index === "$") return "$";
    for (let length = index.length; length > 0; length -= 1) {
      const group = Number(index.slice(0, length));
      if (group > 0 && group < match.length) return match[group] + index.slice(length);
    }
    return whole;
  });
}

export function previewSearchReplacement(
  options: Pick<ProjectSearchOptions, "mode" | "query" | "caseSensitive">,
  replacement: string,
  matchedText: string,
): string {
  if (options.mode !== "regex") return replacement;
  try {
    const match = new RegExp(
      `^(?:${options.query})$`,
      options.caseSensitive ? "u" : "iu",
    ).exec(matchedText);
    return match ? expandReplacement(unquoteRegexReplacement(replacement), match) : replacement;
  } catch {
    return replacement;
  }
}

export function applyTextEdits(
  text: string,
  edits: readonly { from: number; to: number; insert: string }[],
): string {
  const sorted = [...edits].sort((left, right) => left.from - right.from || left.to - right.to);
  let cursor = 0;
  let result = "";
  for (const edit of sorted) {
    if (edit.from < cursor || edit.to < edit.from) {
      throw new Error("Replacement ranges overlap or are out of order.");
    }
    result += text.slice(cursor, edit.from);
    result += edit.insert;
    cursor = edit.to;
  }
  return result + text.slice(cursor);
}
