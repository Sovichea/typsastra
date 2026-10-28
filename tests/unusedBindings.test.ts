import { describe, expect, test } from "bun:test";
import { EditorState } from "@codemirror/state";
import { typstLanguage } from "../src/editor/typstLanguage";
import {
  buildUnusedBindingPresentation,
  findLetBindingDeclarations,
  hasOtherWorkspaceReferences,
  identifierOccurrenceCount,
  UnusedBindingMarker,
} from "../src/editor/unusedBindings";

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

  test("counts complete hyphenated identifiers before requesting workspace references", () => {
    expect(identifierOccurrenceCount("#let set-chapter(x) = x\n#set-chapter(1)", "set-chapter")).toBe(2);
    expect(identifierOccurrenceCount("#let chapter(x) = x\n#chapter-extra(1)", "chapter")).toBe(1);
  });

  test("builds warning gutter and overview-ruler markers for unused bindings", async () => {
    const declarations = [
      { name: "set-chapter", from: 10, to: 21, line: 0, character: 5, kind: "function" as const },
      { name: "unused-value", from: 40, to: 52, line: 1, character: 5, kind: "variable" as const },
    ];
    const presentation = buildUnusedBindingPresentation(
      declarations,
      new Set(declarations),
      100,
    );
    const markers: Array<{ from: number; marker: unknown }> = [];
    presentation.markers.between(0, 100, (from, _to, marker) => {
      markers.push({ from, marker });
    });

    expect(markers.map(entry => entry.from)).toEqual([10, 40]);
    expect(markers.every(entry => entry.marker instanceof UnusedBindingMarker)).toBe(true);
    expect(presentation.decorations.size).toBe(2);

    const editor = await Bun.file(
      new URL("../src/editor/editorController.ts", import.meta.url),
    ).text();
    const initialization = await Bun.file(
      new URL("../src/editor/editorInitializationController.ts", import.meta.url),
    ).text();
    const warnings = await Bun.file(
      new URL("../src/editor/imageWarnings.ts", import.meta.url),
    ).text();
    expect(editor).toContain("unusedBindingMarkerField");
    expect(editor).toContain('severity: "warning"');
    expect(initialization).toContain("setUnusedBindingPresentationEffect");
    expect(warnings).toContain("UnusedBindingMarker");
  });
});
