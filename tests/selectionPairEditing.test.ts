import { describe, expect, test } from "bun:test";
import { EditorSelection, EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import {
  pairedSelectionContent,
  replaceSelectedDelimiters,
  type EditorOpeningDelimiter,
} from "../src/editor/selectionPairEditing";

function replace(
  doc: string,
  anchor: number,
  head: number,
  opening: EditorOpeningDelimiter,
): EditorState {
  let state = EditorState.create({
    doc,
    selection: EditorSelection.range(anchor, head),
  });
  const view = {
    get state() { return state; },
    dispatch(transaction: ReturnType<EditorState["update"]>) { state = transaction.state; },
  } as unknown as EditorView;
  expect(replaceSelectedDelimiters(view, opening)).toBe(true);
  return state;
}

describe("selection pair editing", () => {
  test("recognizes every supported outer delimiter pair", () => {
    for (const selected of ['"Hello"', "[Hello]", "(Hello)", "{Hello}"]) {
      expect(pairedSelectionContent(selected)).toBe("Hello");
    }
    expect(pairedSelectionContent("Hello")).toBeNull();
    expect(pairedSelectionContent("[Hello)")).toBeNull();
  });

  test("wraps bare selected text and selects the complete result", () => {
    const state = replace("Hello world", 0, 5, "[");
    expect(state.doc.toString()).toBe("[Hello] world");
    expect(state.sliceDoc(state.selection.main.from, state.selection.main.to)).toBe("[Hello]");
  });

  test("toggles selected Typst strong, emphasis, and raw-text wrappers", () => {
    const cases: Array<[EditorOpeningDelimiter, string]> = [
      ["*", "*Hello* world"],
      ["_", "_Hello_ world"],
      ["`", "`Hello` world"],
    ];
    for (const [opening, wrapped] of cases) {
      const first = replace("Hello world", 0, 5, opening);
      expect(first.doc.toString()).toBe(wrapped);
      expect(first.sliceDoc(first.selection.main.from, first.selection.main.to)).toBe(wrapped.slice(0, wrapped.indexOf(" world")));

      const second = replace(wrapped, 0, wrapped.indexOf(" world"), opening);
      expect(second.doc.toString()).toBe("Hello world");
      expect(second.sliceDoc(second.selection.main.from, second.selection.main.to)).toBe("Hello");
    }
  });

  test("removes an existing pair when the same opening delimiter is typed", () => {
    const state = replace("[Hello] world", 0, 7, "[");
    expect(state.doc.toString()).toBe("Hello world");
    expect(state.sliceDoc(state.selection.main.from, state.selection.main.to)).toBe("Hello");
  });

  test("replaces an existing pair when a different opening delimiter is typed", () => {
    const cases: Array<[EditorOpeningDelimiter, string]> = [
      ['"', '"Hello"'],
      ["(", "(Hello)"],
      ["[", "[Hello]"],
      ["{", "{Hello}"],
    ];
    for (const source of ['"Hello"', "[Hello]", "(Hello)", "{Hello}"]) {
      for (const [opening, expected] of cases) {
        if (source.startsWith(opening)) continue;
        const state = replace(source, 0, source.length, opening);
        expect(state.doc.toString()).toBe(expected);
        expect(state.sliceDoc(state.selection.main.from, state.selection.main.to)).toBe(expected);
      }
    }
  });

  test("preserves a backward selection", () => {
    const state = replace('"Hello" world', 7, 0, "{");
    expect(state.doc.toString()).toBe("{Hello} world");
    expect(state.selection.main.anchor).toBe(7);
    expect(state.selection.main.head).toBe(0);
    expect(state.sliceDoc(state.selection.main.from, state.selection.main.to)).toBe("{Hello}");
  });
});
