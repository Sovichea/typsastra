import { describe, expect, test } from "bun:test";
import { findPreviewTextMatchInSourceLine } from "../src/preview/sourceHighlight";

describe("preview source highlighting", () => {
  test("maps preview text clicks back into a source line", () => {
    expect(findPreviewTextMatchInSourceLine("A source sentence", "source sentence", 4)).toEqual({ sourceOffset: 6 });
  });

  test("matches normalized preview whitespace", () => {
    expect(findPreviewTextMatchInSourceLine("A source sentence", "A   source sentence", 5)).toEqual({ sourceOffset: 3 });
  });

  test("returns offsets in the original source line after collapsed whitespace", () => {
    expect(findPreviewTextMatchInSourceLine("A   source sentence", "A source sentence", 5)).toEqual({ sourceOffset: 7 });
  });

  test("normalizes the clicked preview offset before matching", () => {
    expect(findPreviewTextMatchInSourceLine("A source sentence", "A\nsource sentence", 9)).toEqual({ sourceOffset: 9 });
  });

  test("maps Khmer clicks after a rendered space using the full text offset", () => {
    expect(findPreviewTextMatchInSourceLine("សួស្តី ពិភពលោក", "សួស្តី ពិភពលោក", 8)).toEqual({ sourceOffset: 8 });
  });

  test("uses the source-position hint to disambiguate repeated text", () => {
    expect(findPreviewTextMatchInSourceLine("កូន ខ្មែរ កូន ខ្មែរ", "កូន ខ្មែរ", 5, 10)).toEqual({ sourceOffset: 15 });
  });
});
