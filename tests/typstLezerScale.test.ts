import { describe, expect, test } from "bun:test";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import type { Tree } from "@lezer/common";
import { typstLanguage } from "../src/editor/typstLanguage";
import {
  buildTypstScaleDocument,
  TYPST_SCALE_LINE_COUNT,
} from "../scripts/typst-lezer-fixture";

function errorCount(tree: Tree): number {
  const cursor = tree.cursor();
  let errors = 0;
  do {
    if (cursor.type.isError) errors += 1;
  } while (cursor.next());
  return errors;
}

describe("Typst Lezer 20k-line scale", () => {
  test("fully parses a representative 20,000-line Typst document and incrementally reparses a middle edit", () => {
    const doc = buildTypstScaleDocument();
    const state = EditorState.create({ doc, extensions: [typstLanguage] });

    expect(state.doc.lines).toBe(TYPST_SCALE_LINE_COUNT);

    const coldStart = performance.now();
    const coldTree = ensureSyntaxTree(state, state.doc.length, 30_000);
    const coldMs = performance.now() - coldStart;

    expect(coldTree).not.toBeNull();
    expect(coldTree?.length).toBe(state.doc.length);
    expect(errorCount(coldTree!)).toBe(0);

    const line = state.doc.line(10_000);
    const editStart = performance.now();
    const edited = state.update({
      changes: { from: line.to, insert: " updated" },
    }).state;
    const editedTree = ensureSyntaxTree(edited, edited.doc.length, 30_000);
    const incrementalMs = performance.now() - editStart;

    expect(editedTree).not.toBeNull();
    expect(editedTree?.length).toBe(edited.doc.length);
    expect(errorCount(editedTree!)).toBe(0);

    console.info(JSON.stringify({
      benchmark: "typst-lezer-20k",
      lines: state.doc.lines,
      chars: state.doc.length,
      coldMs: Number(coldMs.toFixed(2)),
      incrementalMs: Number(incrementalMs.toFixed(2)),
    }));
  });
});
