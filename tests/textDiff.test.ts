import { describe, expect, test } from "bun:test";
import {
  createUnifiedTextDiff,
  diffLineSegments,
  splitDiffHunk,
} from "../src/recovery/textDiff";

describe("unified recovery diff", () => {
  test("renders a git-style hunk around a changed line", () => {
    const diff = createUnifiedTextDiff(
      "a\nb\nc\nd\ne",
      "a\nb\nC\nd\ne",
      { context: 1 },
    );

    expect(diff.hunks).toHaveLength(1);
    expect(diff.hunks[0].header).toBe("@@ -2,3 +2,3 @@");
    expect(diff.hunks[0].lines.map(line => [line.type, line.text])).toEqual([
      ["context", "b"],
      ["remove", "c"],
      ["add", "C"],
      ["context", "d"],
    ]);
  });

  test("omits unchanged regions far from a change", () => {
    const oldText = ["a", "b", "c", "d", "e", "f", "g", "h", "i"].join("\n");
    const newText = ["a", "b", "c", "d", "E", "f", "g", "h", "i"].join("\n");
    const diff = createUnifiedTextDiff(oldText, newText, { context: 1 });

    expect(diff.hunks).toHaveLength(1);
    expect(diff.hunks[0].lines.map(line => line.text)).toEqual(["d", "e", "E", "f"]);
    expect(diff.shownLines).toBe(4);
    expect(diff.totalLines).toBe(4);
  });

  test("recognizes line-ending-only changes without rendering the file", () => {
    const diff = createUnifiedTextDiff("a\r\nb", "a\nb");
    expect(diff.hunks).toEqual([]);
    expect(diff.lineEndingOnly).toBe(true);
    expect(diff.shownLines).toBe(0);
  });

  test("pairs changed lines for a split view with both line numbers", () => {
    const diff = createUnifiedTextDiff("a\nb\nc", "a\nB\nc", { context: 1 });
    const rows = splitDiffHunk(diff.hunks[0]);

    expect(rows.map(row => [row.old.text, row.new.text])).toEqual([
      ["a", "a"],
      ["b", "B"],
      ["c", "c"],
    ]);
    expect(rows.map(row => [row.old.line, row.new.line])).toEqual([
      [1, 1],
      [2, 2],
      [3, 3],
    ]);
  });

  test("highlights changed words within a paired line", () => {
    const segments = diffLineSegments("The quick brown fox", "The slow brown fox");
    expect(segments.old.map(segment => segment.text).join("")).toBe("The quick brown fox");
    expect(segments.new.map(segment => segment.text).join("")).toBe("The slow brown fox");
    expect(segments.old.filter(segment => segment.changed).map(segment => segment.text))
      .toEqual(["quick"]);
    expect(segments.new.filter(segment => segment.changed).map(segment => segment.text))
      .toEqual(["slow"]);
  });

  test("truncates very large diff output at hunk boundaries", () => {
    const oldText = Array.from({ length: 30 }, (_, index) => `old ${index}`).join("\n");
    const newText = Array.from({ length: 30 }, (_, index) => `new ${index}`).join("\n");
    const diff = createUnifiedTextDiff(oldText, newText, { context: 3, maxLines: 10 });

    expect(diff.truncated).toBe(true);
    expect(diff.shownLines).toBe(10);
    expect(diff.hunks).toHaveLength(1);
    expect(diff.hunks[0].lines).toHaveLength(10);
    expect(diff.totalLines).toBeGreaterThan(10);
  });
});
