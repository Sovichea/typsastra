import { findEditorSearchMatches } from "../editor/searchMatcher";

export const PROJECT_SEARCH_DEBOUNCE_MS = 200;
export const PROJECT_SEARCH_MAX_RESULTS = 20_000;
export const PROJECT_SEARCH_REGEX_TIMEOUT_MS = 1_000;

export type ProjectSearchMode = "literal" | "regex" | "fuzzy";

export type ProjectSearchOptions = {
  query: string;
  mode: ProjectSearchMode;
  caseSensitive: boolean;
  wholeWord: boolean;
  matchDiacritics: boolean;
  includeIgnored: boolean;
  mainDocumentOnly: boolean;
  includeGlobs: string[];
  excludeGlobs: string[];
};

export type ProjectSearchFileInput = {
  path: string;
  relativePath: string;
  revision: string;
  textRevision: string;
  text: string;
};

export type ProjectSearchRange = {
  from: number;
  to: number;
};

export type ProjectSearchLineMatch = {
  lineNumber: number;
  lineText: string;
  lineFrom: number;
  from: number;
  to: number;
  ranges: ProjectSearchRange[];
  score: number;
};

export type ProjectSearchFileResult = {
  path: string;
  relativePath: string;
  revision: string;
  textRevision: string;
  contentMatches: ProjectSearchLineMatch[];
  contentMatchCount: number;
  pathMatch: { score: number; ranges: ProjectSearchRange[] } | null;
  truncated: boolean;
  error: string | null;
};

export type ProjectSearchWorkerRequest = {
  type: "search";
  requestId: number;
  options: ProjectSearchOptions;
  files: readonly ProjectSearchFileInput[];
  limit: number;
};

export type ProjectSearchWorkerResponse =
  | { type: "file-start"; requestId: number; index: number; relativePath: string }
  | { type: "file-result"; requestId: number; result: ProjectSearchFileResult }
  | { type: "done"; requestId: number; truncated: boolean }
  | { type: "error"; requestId: number; message: string };

export function matchProjectSearchFile(
  file: ProjectSearchFileInput,
  options: ProjectSearchOptions,
  limit = PROJECT_SEARCH_MAX_RESULTS,
): ProjectSearchFileResult {
  if (options.mode === "fuzzy") return matchFuzzyFile(file, options, limit);
  const result = findEditorSearchMatches(file.text, {
    search: options.query,
    caseSensitive: options.caseSensitive,
    literal: options.mode === "literal",
    regexp: options.mode === "regex",
    wholeWord: options.wholeWord,
    matchDiacritics: options.mode === "regex" ? true : options.matchDiacritics,
  }, Math.max(0, limit));
  const byLine = new Map<number, ProjectSearchLineMatch>();
  for (const match of result.matches) {
    const lineRange = match.lineRanges[0];
    if (!lineRange) continue;
    let line = byLine.get(match.lineNumber);
    if (!line) {
      line = {
        lineNumber: match.lineNumber,
        lineText: match.lineText,
        lineFrom: match.lineFrom,
        from: match.lineFrom + lineRange.from,
        to: match.lineFrom + lineRange.to,
        ranges: [],
        score: 0,
      };
      byLine.set(match.lineNumber, line);
    }
    line.ranges.push(lineRange);
  }
  const contentMatches = [...byLine.values()];
  return {
    path: file.path,
    relativePath: file.relativePath,
    revision: file.revision,
    textRevision: file.textRevision,
    contentMatches,
    contentMatchCount: result.matches.length,
    pathMatch: null,
    truncated: result.truncated,
    error: result.error,
  };
}

function matchFuzzyFile(
  file: ProjectSearchFileInput,
  options: ProjectSearchOptions,
  limit: number,
): ProjectSearchFileResult {
  const contentMatches: ProjectSearchLineMatch[] = [];
  const pathMatch = fuzzySubsequence(file.relativePath, options.query, options.caseSensitive);
  let contentMatchCount = 0;
  let truncated = false;
  let lineNumber = 1;
  let lineFrom = 0;
  let lineStart = 0;
  for (let index = 0; index <= file.text.length; index += 1) {
    const character = file.text[index];
    const lineBreak = character === "\n" || character === "\r";
    if (index < file.text.length && !lineBreak) continue;
    const lineEnd = lineBreak ? index : file.text.length;
    const lineText = file.text.slice(lineStart, lineEnd);
    const match = fuzzySubsequence(lineText, options.query, options.caseSensitive);
    if (match) {
      if (contentMatchCount >= limit) {
        truncated = true;
        break;
      }
      const first = match.ranges[0]!;
      const last = match.ranges[match.ranges.length - 1]!;
      contentMatches.push({
        lineNumber,
        lineText,
        lineFrom,
        from: lineFrom + first.from,
        to: lineFrom + last.to,
        ranges: match.ranges,
        score: match.score,
      });
      contentMatchCount += 1;
    }
    if (index < file.text.length && file.text[index] === "\r" && file.text[index + 1] === "\n") {
      index += 1;
    }
    lineNumber += 1;
    lineFrom = index + 1;
    lineStart = index + 1;
  }
  contentMatches.sort((left, right) => right.score - left.score || left.lineNumber - right.lineNumber);
  return {
    path: file.path,
    relativePath: file.relativePath,
    revision: file.revision,
    textRevision: file.textRevision,
    contentMatches,
    contentMatchCount,
    pathMatch,
    truncated,
    error: null,
  };
}

export function fuzzySubsequence(
  text: string,
  query: string,
  caseSensitive = false,
): { score: number; ranges: ProjectSearchRange[] } | null {
  if (!query) return null;
  const haystack = caseSensitive ? text : text.toLowerCase();
  const needle = caseSensitive ? query : query.toLowerCase();
  if (haystack.length !== text.length || needle.length !== query.length) return null;
  const ranges: ProjectSearchRange[] = [];
  let score = 0;
  let last = -2;
  for (let needleIndex = 0; needleIndex < needle.length; needleIndex += 1) {
    const character = needle[needleIndex]!;
    let found = -1;
    for (let index = Math.max(0, last + 1); index < haystack.length; index += 1) {
      if (haystack[index] === character) {
        found = index;
        break;
      }
    }
    if (found < 0) return null;
    const consecutive = found === last + 1;
    score += consecutive ? 8 : 1;
    if (found === 0 || /[\\/_.\-\s]/u.test(haystack[found - 1]!)) score += 6;
    score += Math.max(0, 12 - found) * 0.1;
    const previous = ranges[ranges.length - 1];
    if (consecutive && previous && previous.to === found) previous.to = found + 1;
    else ranges.push({ from: found, to: found + 1 });
    last = found;
  }
  return { score, ranges };
}

export function parseProjectSearchGlobs(value: string): string[] {
  return value
    .split(/[\n,]+/u)
    .map(part => part.trim())
    .filter(Boolean);
}

export function projectSearchFileMatchesFilters(
  relativePath: string,
  includeGlobs: readonly string[],
  excludeGlobs: readonly string[],
): boolean {
  const normalized = normalizeRelativePath(relativePath);
  if (includeGlobs.length > 0 && !includeGlobs.some(glob => matchesGlob(normalized, glob))) return false;
  return !excludeGlobs.some(glob => matchesGlob(normalized, glob));
}

export function matchesGlob(relativePath: string, glob: string): boolean {
  const normalizedGlob = normalizeRelativePath(glob);
  if (!normalizedGlob) return false;
  const target = normalizedGlob.includes("/")
    ? normalizeRelativePath(relativePath)
    : normalizeRelativePath(relativePath).split("/").pop() ?? "";
  return globRegExp(normalizedGlob).test(target);
}

function globRegExp(glob: string): RegExp {
  let expression = "^";
  for (let index = 0; index < glob.length; index += 1) {
    const character = glob[index]!;
    if (character === "*") {
      if (glob[index + 1] === "*") {
        index += 1;
        if (glob[index + 1] === "/") {
          index += 1;
          expression += "(?:.*/)?";
        } else {
          expression += ".*";
        }
      } else {
        expression += "[^/]*";
      }
    } else if (character === "?") {
      expression += "[^/]";
    } else {
      expression += character.replace(/[\\^$.*+?()[\]{}|]/gu, "\\$&");
    }
  }
  return new RegExp(`${expression}$`, "u");
}

function normalizeRelativePath(value: string): string {
  return value.replace(/\\/gu, "/").replace(/^\.\//u, "").replace(/\/+/gu, "/");
}
