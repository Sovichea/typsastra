import { describe, expect, test } from "bun:test";
import { EditorState } from "@codemirror/state";
import { typstLanguage } from "../src/editor/typstLanguage";
import { findLetBindingDeclarations, hasOtherWorkspaceReferences } from "../src/editor/unusedBindings";

describe("unused Typst bindings", () => {
  test("finds local function and variable declarations without keyword-prefix false matches", () => {
    const source = [
      "// #let ignored() = 0",
      "#let set-chapter(kicker) = kicker",
      "#let true-value = 1",
      "#let plain = 2",
      '#let text = "#let hidden() = 3"',
    ].join("\n");
    const state = EditorState.create({ doc: source, extensions: [typstLanguage] });

    expect(findLetBindingDeclarations(state).map(({ name, kind }) => ({ name, kind }))).toEqual([
      { name: "set-chapter", kind: "function" },
      { name: "true-value", kind: "variable" },
      { name: "plain", kind: "variable" },
      { name: "text", kind: "variable" },
    ]);
  });

  test("only reports unused when Tinymist confirms the declaration and finds no other workspace references", () => {
    const declaration = { line: 4, character: 8 };
    const ownReference = { uri: "file:///C:/project/main.typ", range: { start: declaration } };
    expect(hasOtherWorkspaceReferences([ownReference], "file:///C:/project/main.typ", declaration)).toBe(false);
    expect(hasOtherWorkspaceReferences([
      ownReference,
      { uri: "file:///C:/project/chapter.typ", range: { start: { line: 9, character: 12 } } },
    ], "file:///C:/project/main.typ", declaration)).toBe(true);
    expect(hasOtherWorkspaceReferences([], "file:///C:/project/main.typ", declaration)).toBeNull();
  });
});
