import { describe, expect, test } from "bun:test";
import { EditorState } from "@codemirror/state";
import { typstFunctionFoldService } from "../src/editor/folding";

describe("Typst folding", () => {
  test("folds an attached multiline content block with its function call", () => {
    const source = `#text(lang: "bm")[#set page(
  margin: (x: 24mm, y: 22mm),
  header: context [#title #h(1fr) #counter(page).display()],
)
Content
]`;
    const state = EditorState.create({ doc: source });
    const firstLine = state.doc.line(1);

    expect(typstFunctionFoldService(state, firstLine.from, firstLine.to)).toEqual({
      from: firstLine.to,
      to: source.length,
    });
  });

  test("folds a multiline function call in a set rule", () => {
    const source = `#text(lang: "bm")[
  #set page(
    margin: (x: 24mm, y: 22mm),
    header: context [#title #h(1fr) #counter(page).display()],
  )
]`;
    const state = EditorState.create({ doc: source });
    const setLine = state.doc.line(2);
    const closingParenthesis = source.lastIndexOf(")");

    expect(typstFunctionFoldService(state, setLine.from, setLine.to)).toEqual({
      from: setLine.to,
      to: closingParenthesis + 1,
    });
  });

  test("scans a large document without copying it once per line", () => {
    const source = Array.from(
      { length: 20_000 },
      (_, index) => `Line ${index} lorem ipsum dolor sit amet.`,
    ).join("\n");
    const state = EditorState.create({ doc: source });
    const startedAt = performance.now();

    for (let lineNumber = 1; lineNumber <= state.doc.lines; lineNumber++) {
      const line = state.doc.line(lineNumber);
      typstFunctionFoldService(state, line.from, line.to);
    }

    expect(performance.now() - startedAt).toBeLessThan(1_000);
  });
});
