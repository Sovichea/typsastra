import { describe, expect, test } from "bun:test";
import {
  filterSurroundWithOptions,
  mergeDiscoveredSurroundWithOptions,
  SURROUND_WITH_OPTIONS,
  surroundEditorRange,
} from "../src/editor/surroundWith";
import type { EditorView } from "@codemirror/view";

describe("Surround With options", () => {
  test("contains only explicit bracket wrappers", () => {
    expect(SURROUND_WITH_OPTIONS.length).toBeGreaterThan(4);
    for (const option of SURROUND_WITH_OPTIONS) {
      expect(option.prefix.endsWith("[")).toBe(true);
      expect(option.suffix).toBe("]");
      expect(option.label.endsWith("[…]")).toBe(true);
    }
  });

  test("finds functions by name and purpose", () => {
    expect(filterSurroundWithOptions("emph").map(option => option.id)).toContain("emph");
    expect(filterSurroundWithOptions("caption").map(option => option.id)).toContain("figure");
    expect(filterSurroundWithOptions("caption").map(option => option.id)).toContain("figure-caption");
    expect(filterSurroundWithOptions("strk").map(option => option.id)).toContain("strike");
    expect(filterSurroundWithOptions("align center")[0]?.id).toBe("align-center");
    expect(filterSurroundWithOptions("par justify")[0]?.id).toBe("par-justify");
  });

  test("offers common argument presets for content wrappers", () => {
    const center = SURROUND_WITH_OPTIONS.find(option => option.id === "align-center");
    const justify = SURROUND_WITH_OPTIONS.find(option => option.id === "par-justify");
    const figure = SURROUND_WITH_OPTIONS.find(option => option.id === "figure-caption");

    expect(center?.prefix).toBe("#align(center)[");
    expect(justify?.prefix).toBe("#par(justify: true)[");
    expect(figure?.prefix).toBe("#figure(caption: [Caption])[");
  });

  test("ranks exact and prefix function names above metadata and loose fuzzy matches", () => {
    const parResults = filterSurroundWithOptions("par");
    expect(parResults[0]?.id).toBe("par");
    expect(parResults.map(option => option.id)).not.toContain("strong");

    const highResults = filterSurroundWithOptions("high");
    expect(highResults[0]?.id).toBe("highlight");
  });

  test("merges bracket-capable Tinymist metadata without ordinary functions", () => {
    const options = mergeDiscoveredSurroundWithOptions([
      { label: "par.bracket", detail: "Paragraph content" },
      { label: "custom-wrapper.bracket", detail: "Custom content wrapper" },
      { label: "image", detail: "Image function" },
      { label: "rgb.paren", detail: "Color function" },
    ]);
    expect(options.map(option => option.id)).toContain("par");
    expect(options.map(option => option.id)).toContain("custom-wrapper");
    expect(options.map(option => option.id)).not.toContain("image");
    expect(options.map(option => option.id)).not.toContain("rgb");
    expect(options.find(option => option.id === "custom-wrapper")?.description)
      .toBe("Custom content wrapper");
  });

  test("does not include ordinary non-content functions", () => {
    const ids = SURROUND_WITH_OPTIONS.map(option => option.id);
    expect(ids).not.toContain("image");
    expect(ids).not.toContain("rgb");
    expect(ids).not.toContain("pagebreak");
  });

  test("wraps the selected source and preserves the inner selection", () => {
    const transactions: unknown[] = [];
    let focused = false;
    const source = "Before important text after";
    const editor = {
      state: {
        doc: { length: source.length },
        sliceDoc: (from: number, to: number) => source.slice(from, to),
      },
      dispatch: (transaction: unknown) => transactions.push(transaction),
      focus: () => { focused = true; },
    } as unknown as EditorView;
    const option = SURROUND_WITH_OPTIONS.find(candidate => candidate.id === "emph")!;

    expect(surroundEditorRange(editor, 7, 21, option)).toBe(true);
    expect(transactions).toEqual([{
      changes: { from: 7, to: 21, insert: "#emph[important text]" },
      selection: { anchor: 13, head: 27 },
      scrollIntoView: true,
      userEvent: "input.surround",
    }]);
    expect(focused).toBe(true);
  });
});
