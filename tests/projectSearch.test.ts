import { describe, expect, test } from "bun:test";
import {
  fuzzySubsequence,
  matchProjectSearchFile,
  matchesGlob,
  parseProjectSearchGlobs,
  projectSearchFileMatchesFilters,
  type ProjectSearchFileInput,
  type ProjectSearchOptions,
} from "../src/search/projectSearch";

function file(text: string, relativePath = "main.typ"): ProjectSearchFileInput {
  return {
    path: `C:/project/${relativePath}`,
    relativePath,
    revision: "revision-1",
    textRevision: "text-1",
    text,
  };
}

function options(overrides: Partial<ProjectSearchOptions> = {}): ProjectSearchOptions {
  return {
    query: "cafe",
    mode: "literal",
    caseSensitive: false,
    wholeWord: false,
    matchDiacritics: true,
    includeIgnored: false,
    mainDocumentOnly: true,
    includeGlobs: [],
    excludeGlobs: [],
    ...overrides,
  };
}

describe("project search matching", () => {
  test("reuses editor literal matching for case, whole words, and diacritics", () => {
    const text = "Café\ncafe\ncafeine\n";
    const insensitive = matchProjectSearchFile(file(text), options({
      wholeWord: true,
      matchDiacritics: false,
    }));
    expect(insensitive.contentMatchCount).toBe(2);
    expect(insensitive.contentMatches.map(match => match.lineNumber)).toEqual([1, 2]);

    const sensitive = matchProjectSearchFile(file(text), options({
      wholeWord: true,
      matchDiacritics: false,
      caseSensitive: true,
    }));
    expect(sensitive.contentMatchCount).toBe(1);
    expect(sensitive.contentMatches[0]?.lineNumber).toBe(2);
  });

  test("matches regex captures and reports invalid expressions", () => {
    const repeated = matchProjectSearchFile(
      file("foo foo\nbar baz\n"),
      options({ query: "\\b(\\w+)\\s+\\1\\b", mode: "regex" }),
    );
    expect(repeated.contentMatchCount).toBe(1);
    expect(repeated.contentMatches[0]?.lineNumber).toBe(1);
    expect(repeated.error).toBeNull();

    const invalid = matchProjectSearchFile(
      file("anything"),
      options({ query: "(", mode: "regex" }),
    );
    expect(invalid.contentMatchCount).toBe(0);
    expect(invalid.error).not.toBeNull();
  });

  test("ranks fuzzy path and line subsequences and keeps path matches separate", () => {
    const result = matchProjectSearchFile(
      file("alpha\nbeta gamma\ngamma beta\n", "chapters/gamma-notes.typ"),
      options({ query: "gama", mode: "fuzzy" }),
    );
    expect(result.pathMatch).not.toBeNull();
    expect(result.pathMatch?.ranges.length).toBeGreaterThan(0);
    expect(result.contentMatchCount).toBe(2);
    expect(result.contentMatches.every(match => match.ranges.length > 0)).toBe(true);
  });

  test("stops at the result cap and marks the result truncated", () => {
    const result = matchProjectSearchFile(file("a a a a\n"), options({ query: "a" }), 2);
    expect(result.contentMatchCount).toBe(2);
    expect(result.truncated).toBe(true);
  });

  test("preserves UTF-16 offsets with a leading BOM", () => {
    const result = matchProjectSearchFile(file("\uFEFFhello\n"), options({ query: "hello" }));
    expect(result.contentMatches[0]?.from).toBe(1);
    expect(result.contentMatches[0]?.to).toBe(6);
  });

  test("parses and applies include and exclude globs", () => {
    expect(parseProjectSearchGlobs(" chapters/**, *.typ\n*.bib, ")).toEqual([
      "chapters/**",
      "*.typ",
      "*.bib",
    ]);
    expect(matchesGlob("chapters/01-intro.typ", "chapters/**")).toBe(true);
    expect(matchesGlob("chapters/nested/01-intro.typ", "chapters/**")).toBe(true);
    expect(matchesGlob("notes/01-intro.typ", "*.typ")).toBe(true);
    expect(matchesGlob("notes/01-intro.bib", "*.typ")).toBe(false);
    expect(projectSearchFileMatchesFilters("chapters/01.typ", ["chapters/**"], ["**/draft-*"])).toBe(true);
    expect(projectSearchFileMatchesFilters("chapters/draft-01.typ", ["chapters/**"], ["**/draft-*"])).toBe(false);
    expect(projectSearchFileMatchesFilters("notes/01.typ", ["chapters/**"], [])).toBe(false);
  });

  test("returns matched character ranges for fuzzy subsequences", () => {
    const match = fuzzySubsequence("gamma", "gma");
    expect(match).not.toBeNull();
    expect(match?.ranges).toEqual([
      { from: 0, to: 1 },
      { from: 2, to: 3 },
      { from: 4, to: 5 },
    ]);
    expect(fuzzySubsequence("gamma", "xyz")).toBeNull();
  });
});
