import { describe, expect, test } from "bun:test";
import { EditorSelection, EditorState, Text } from "@codemirror/state";
import { closeBrackets } from "@codemirror/autocomplete";
import type { EditorView } from "@codemirror/view";
import { codePointDeletionRange, completeTrailingGraphemeBoundary, deletionRangesForSelection, deletePreviousGraphemeOrPair, graphemeBoundaries, graphemeSelectionBoundaryFilter, khmerGraphemeBoundaryAtOffset, khmerWordBoundaryAtOffset, moveSelectionByGrapheme, nextGraphemeBoundary, previousGraphemeBoundary, snapPositionToGraphemeBoundary, snapSelectionToGraphemeBoundaries } from "../src/editor/grapheme";
import { getTemporaryKhmerBoundary, khmerCompositionBoundaryState } from "../src/editor/editingPolicies/khmer/composition";

describe("editor grapheme navigation", () => {
  test("backspace removes both sides of an adjacent quotation pair", () => {
    let state = EditorState.create({
      doc: '""',
      selection: EditorSelection.cursor(1),
      extensions: [closeBrackets()]
    });
    const view = {
      get state() { return state; },
      dispatch(transaction: ReturnType<EditorState["update"]>) { state = transaction.state; }
    } as unknown as EditorView;

    expect(deletePreviousGraphemeOrPair(view)).toBe(true);
    expect(state.doc.toString()).toBe("");
    expect(state.selection.main.head).toBe(0);
  });

  test("keeps Khmer coeng clusters together", () => {
    const text = "ខ្មែរ";
    const boundaries = graphemeBoundaries(text);
    expect(boundaries.map(boundary => text.slice(boundary.from, boundary.to))).toEqual(["ខ្មែ", "រ"]);
  });

  test("does not merge a completed Khmer coeng cluster into the next cluster", () => {
    const text = "\u179F\u1798\u17D2\u1794\u178F\u17D2\u178F\u17B7";
    const boundaries = graphemeBoundaries(text);
    expect(boundaries.map(boundary => text.slice(boundary.from, boundary.to))).toEqual([
      "\u179F",
      "\u1798\u17D2\u1794",
      "\u178F\u17D2\u178F\u17B7"
    ]);
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

  test("snaps CodeMirror selections before they can commit inside a cluster", () => {
    const doc = Text.of(["ខ្មែរ"]);
    const selection = snapSelectionToGraphemeBoundaries(doc, EditorSelection.create([EditorSelection.cursor(2)]));
    expect(selection.main.head).toBe(0);
  });

  test("selects complete Khmer clusters from platform-independent pointer offsets", () => {
    for (const cluster of ["ន៍", "ន់", "នាំ"]) {
      expect(khmerGraphemeBoundaryAtOffset(cluster, 0, 1)).toEqual({ from: 0, to: cluster.length });
      expect(khmerGraphemeBoundaryAtOffset(cluster, 1, -1)).toEqual({ from: 0, to: cluster.length });
      expect(khmerGraphemeBoundaryAtOffset(cluster, cluster.length, -1)).toEqual({ from: 0, to: cluster.length });
    }
    const adjacent = "កន់";
    expect(khmerGraphemeBoundaryAtOffset(adjacent, 1, -1)).toEqual({ from: 0, to: 1 });
    expect(khmerGraphemeBoundaryAtOffset(adjacent, 1, 1)).toEqual({ from: 1, to: adjacent.length });
    expect(khmerGraphemeBoundaryAtOffset("Latin", 0, 1)).toBeNull();
  });

  test("prefers a spelling diagnostic to a single Khmer cluster on double-click", () => {
    const text = "កខ្មែរ គ";
    const issue = { from: 0, to: "កខ្មែរ".length };
    expect(khmerWordBoundaryAtOffset(text, 2, 1, issue)).toEqual(issue);
    expect(khmerWordBoundaryAtOffset(text, text.length - 1, 1, issue)).toEqual({ from: text.length - 1, to: text.length });
    expect(khmerWordBoundaryAtOffset("abc", 1, 1, issue)).toBeNull();
  });

  test("uses provider spans for known Khmer words and never guesses a whole run", () => {
    const text = "ខ្មែរ គ";
    expect(khmerWordBoundaryAtOffset(text, 0, 1, { from: 0, to: text.indexOf(" ") }))
      .toEqual({ from: 0, to: "ខ្មែរ".length });
    expect(khmerWordBoundaryAtOffset(text, 1, 1, { from: 1, to: 3 })).toEqual({ from: 0, to: 4 });
    expect(khmerWordBoundaryAtOffset("កខគឃ", 0, 1)).toEqual({ from: 0, to: 1 });
  });

  test("uses the pointer side when placing a caret in a line-leading COENG cluster", () => {
    const state = EditorState.create({
      doc: "\u17B1\u17D2\u1799 text",
      extensions: [graphemeSelectionBoundaryFilter]
    });
    const pointer = state.update({ selection: { anchor: 2 }, userEvent: "select.pointer" }).state;
    expect(pointer.selection.main.head).toBe(0);
    const pointerAtStart = state.update({
      selection: EditorSelection.create([EditorSelection.cursor(2, -1)]),
      userEvent: "select.pointer"
    }).state;
    expect(pointerAtStart.selection.main.head).toBe(0);
    const pointerAtEnd = state.update({
      selection: EditorSelection.create([EditorSelection.cursor(2, 1)]),
      userEvent: "select.pointer"
    }).state;
    expect(pointerAtEnd.selection.main.head).toBe(3);
    const keyboard = state.update({ selection: { anchor: 2 }, userEvent: "select" }).state;
    expect(keyboard.selection.main.head).toBe(3);
  });

  test("uses the pointer side to reach either edge of a shaped Khmer cluster", () => {
    const doc = Text.of(["A\u1781\u17D2\u1798\u17C2B"]);
    const atStart = snapSelectionToGraphemeBoundaries(
      doc,
      EditorSelection.create([EditorSelection.cursor(3, -1)]),
      null,
      true
    );
    expect(atStart.main.head).toBe(1);
    const atEnd = snapSelectionToGraphemeBoundaries(
      doc,
      EditorSelection.create([EditorSelection.cursor(3, 1)]),
      null,
      true
    );
    expect(atEnd.main.head).toBe(5);
  });

  test("advances a visual line end out of the final Khmer grapheme", () => {
    const text = "text \u178E\u17C8";
    expect(completeTrailingGraphemeBoundary(text, text.length - 1)).toBe(text.length);
    expect(completeTrailingGraphemeBoundary(text, 0)).toBe(0);
    expect(completeTrailingGraphemeBoundary(text, 4)).toBe(4);
  });

  test("expands Khmer word selection at line start to the full cluster", () => {
    for (const word of ["ឲ្យ", "ឱ្យ"]) {
      const doc = Text.of([`${word} text`]);
      const forward = snapSelectionToGraphemeBoundaries(
        doc,
        EditorSelection.single(0, 1)
      ).main;
      expect({ from: forward.from, to: forward.to }).toEqual({ from: 0, to: word.length });

      const backward = snapSelectionToGraphemeBoundaries(
        doc,
        EditorSelection.single(1, 0)
      ).main;
      expect({ from: backward.from, to: backward.to }).toEqual({ from: 0, to: word.length });
    }
  });

  test("preserves CodeMirror's visual goal column while snapping a grapheme", () => {
    const doc = Text.of(["ឱ្យ text"]);
    const selection = EditorSelection.create([
      EditorSelection.cursor(1, 0, undefined, 84),
    ]);
    const snapped = snapSelectionToGraphemeBoundaries(doc, selection).main;
    expect(snapped.head).toBe(0);
    expect(snapped.goalColumn).toBe(84);
  });

  test("backspace deletes one Unicode code point except Khmer subscript pairs", () => {
    const doc = Text.of(["ខ្មែរ"]);
    expect(codePointDeletionRange(doc, 4, "backward")).toEqual({ from: 3, to: 4 });
    expect(codePointDeletionRange(doc, 3, "backward")).toEqual({ from: 1, to: 3 });
  });

  test("backspace deletes Khmer coeng plus consonant together inside longer words", () => {
    const doc = Text.of(["\u179F\u1798\u17D2\u1794\u178F\u17D2\u178F\u17B7"]);
    expect(codePointDeletionRange(doc, 4, "backward")).toEqual({ from: 2, to: 4 });
    expect(codePointDeletionRange(doc, 7, "backward")).toEqual({ from: 5, to: 7 });
  });

  test("forward delete removes a complete Khmer grapheme cluster", () => {
    const doc = Text.of(["\u179F\u1798\u17D2\u1794\u178F\u17D2\u178F\u17B7"]);
    expect(codePointDeletionRange(doc, 0, "forward")).toEqual({ from: 0, to: 1 });
    expect(codePointDeletionRange(doc, 1, "forward")).toEqual({ from: 1, to: 4 });
    expect(codePointDeletionRange(doc, 4, "forward")).toEqual({ from: 4, to: 8 });
  });

  test("computes and merges deletion ranges for multiple cursors", () => {
    const doc = Text.of(["\u1798\u17D2\u1794 \u178F\u17D2\u178F\u17B7"]);
    const backward = deletionRangesForSelection(
      doc,
      EditorSelection.create([EditorSelection.cursor(3), EditorSelection.cursor(8)]),
      "backward"
    );
    expect(backward).toEqual([{ from: 1, to: 3 }, { from: 7, to: 8 }]);

    const forward = deletionRangesForSelection(
      doc,
      EditorSelection.create([EditorSelection.cursor(0), EditorSelection.cursor(4)]),
      "forward"
    );
    expect(forward).toEqual([{ from: 0, to: 3 }, { from: 4, to: 8 }]);
  });

  test("never splits a non-BMP Unicode code point", () => {
    const doc = Text.of(["😀"]);
    expect(codePointDeletionRange(doc, 2, "backward")).toEqual({ from: 0, to: 2 });
    expect(codePointDeletionRange(doc, 0, "forward")).toEqual({ from: 0, to: 2 });
  });

  test("preserves a temporary boundary after a newly inserted Khmer coeng", () => {
    let state = EditorState.create({
      doc: "\u1780\u1781",
      selection: { anchor: 1 },
      extensions: [khmerCompositionBoundaryState, graphemeSelectionBoundaryFilter]
    });
    state = state.update({
      changes: { from: 1, insert: "\u17D2" },
      selection: { anchor: 2 },
      userEvent: "input.type"
    }).state;

    state = state.update({ selection: { anchor: 2 } }).state;
    expect(state.selection.main.head).toBe(2);
    expect(codePointDeletionRange(state.doc, 2, "backward", 2)).toEqual({ from: 1, to: 2 });
    expect(codePointDeletionRange(state.doc, 2, "forward", 2)).toEqual({ from: 2, to: 3 });

    const completed = state.update({
      changes: { from: 2, insert: "\u1798" },
      selection: { anchor: 3 },
      userEvent: "input.type"
    }).state;
    expect(graphemeBoundaries(completed.doc.sliceString(0)).map(range => completed.doc.sliceString(range.from, range.to))).toEqual([
      "\u1780\u17D2\u1798",
      "\u1781"
    ]);
    expect(getTemporaryKhmerBoundary(completed)).toBeNull();

    state = state.update({ selection: { anchor: 0 } }).state;
    state = state.update({ selection: { anchor: 2 } }).state;
    expect(state.selection.main.head).toBe(2);

    state = state.update({
      changes: { from: 0, insert: "A" },
      selection: { anchor: 1 },
      userEvent: "input.type"
    }).state;
    expect(getTemporaryKhmerBoundary(state)).toBe(3);
    state = state.update({ selection: { anchor: 3 } }).state;
    expect(state.selection.main.head).toBe(3);
  });

  test("extends keyboard selection by Khmer grapheme boundaries", () => {
    const doc = Text.of(["\u179F\u1798\u17D2\u1794\u178F\u17D2\u178F\u17B7"]);
    const first = moveSelectionByGrapheme(
      doc,
      EditorSelection.create([EditorSelection.cursor(0)]),
      "forward",
      true
    );
    expect(first.main.anchor).toBe(0);
    expect(first.main.head).toBe(1);

    const second = moveSelectionByGrapheme(doc, first, "forward", true);
    expect(second.main.anchor).toBe(0);
    expect(second.main.head).toBe(4);

    const third = moveSelectionByGrapheme(doc, second, "forward", true);
    expect(third.main.anchor).toBe(0);
    expect(third.main.head).toBe(8);
  });
});
