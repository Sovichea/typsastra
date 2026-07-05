import { describe, expect, test } from "bun:test";
import { Text } from "@codemirror/state";
import { codePointDeletionRange, graphemeBoundaries, nextGraphemeBoundary, previousGraphemeBoundary, snapPositionToGraphemeBoundary } from "../src/editor/grapheme";

describe("editor grapheme navigation", () => {
  test("keeps Khmer coeng clusters together", () => {
    const text = "ខ្មែរ";
    const boundaries = graphemeBoundaries(text);
    expect(boundaries.map(boundary => text.slice(boundary.from, boundary.to))).toEqual(["ខ្មែ", "រ"]);
  });

  test("moves out of the current Khmer cluster instead of staying inside it", () => {
    const doc = Text.of(["ខ្មែរ"]);
    expect(nextGraphemeBoundary(doc, 1)).toBe(4);
    expect(previousGraphemeBoundary(doc, 2)).toBe(0);
  });

  test("snaps cursor placement out of a Khmer cluster", () => {
    const doc = Text.of(["ខ្មែរ"]);
    expect(snapPositionToGraphemeBoundary(doc, 1)).toBe(0);
    expect(snapPositionToGraphemeBoundary(doc, 3)).toBe(4);
  });

  test("delete ranges are one Unicode code point, not one grapheme cluster", () => {
    const doc = Text.of(["ខ្មែរ"]);
    expect(codePointDeletionRange(doc, 4, "backward")).toEqual({ from: 3, to: 4 });
    expect(codePointDeletionRange(doc, 0, "forward")).toEqual({ from: 0, to: 1 });
  });
});
