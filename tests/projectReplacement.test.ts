import { describe, expect, test } from "bun:test";
import { findEditorSearchMatches } from "../src/editor/searchMatcher";
import { normalizeEditorText } from "../src/editor/editorFileContentController";
import {
  applyTextEdits,
  isGraphemeSafeReplacementRange,
  previewSearchReplacement,
} from "../src/search/projectReplacement";

describe("project replacement", () => {
  test("applies multiple edits without shifting ranges", () => {
    expect(applyTextEdits("one two one", [
      { from: 0, to: 3, insert: "three" },
      { from: 8, to: 11, insert: "three" },
    ])).toBe("three two three");
  });

  test("rejects overlapping edits", () => {
    expect(() => applyTextEdits("abc", [
      { from: 0, to: 2, insert: "x" },
      { from: 1, to: 3, insert: "y" },
    ])).toThrow("overlap");
  });

  test("detects ranges that split a grapheme cluster", () => {
    expect(isGraphemeSafeReplacementRange("e\u0301x", 0, 2)).toBe(true);
    expect(isGraphemeSafeReplacementRange("e\u0301x", 1, 2)).toBe(false);
    expect(isGraphemeSafeReplacementRange("e\u0301x", 2, 3)).toBe(true);
  });

  test("expands regex capture replacements", () => {
    const result = findEditorSearchMatches("first 12 second 34", {
      search: "(\\w+) (\\d+)",
      regexp: true,
      replace: "$2 $1",
    });
    expect(result.matches.map(match => match.replacement))
      .toEqual(["12 first", "34 second"]);
    expect(previewSearchReplacement(
      { mode: "regex", query: "(\\w+) (\\d+)", caseSensitive: true },
      "$2 $1",
      "first 12",
    )).toBe("12 first");
  });

  test("search offsets target normalized editor text for CRLF sources", () => {
    const raw = "first\r\nsecond\r\n";
    const normalized = normalizeEditorText(raw);
    const result = findEditorSearchMatches(raw, {
      search: "second",
      literal: true,
      replace: "third",
    });
    const match = result.matches[0]!;
    expect(normalized.slice(match.from, match.to)).toBe("second");
    expect(applyTextEdits(normalized, [{
      from: match.from,
      to: match.to,
      insert: match.replacement!,
    }])).toBe("first\nthird\n");
  });
});
