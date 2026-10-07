import { describe, expect, test } from "bun:test";
import { EditorState } from "@codemirror/state";
import { standaloneLocalDependencies } from "../src/preview/standalonePreview";
import { isStandaloneDocument, setStandaloneDocumentEffect, standaloneDocumentField } from "../src/editor/standaloneDocument";

describe("standalone single-file preview", () => {
  test("reports local imports and includes but allows package imports", () => {
    expect(standaloneLocalDependencies('#import "template.typ": *')).toEqual(["template.typ"]);
    expect(standaloneLocalDependencies('#include "chapter.typ"')).toEqual(["chapter.typ"]);
    expect(standaloneLocalDependencies('#import("lib.typ")')).toEqual(["lib.typ"]);
    expect(standaloneLocalDependencies('#import "@preview/tablex:0.0.8": *')).toEqual([]);
    expect(standaloneLocalDependencies("= A plain document\nNo dependencies.")).toEqual([]);
    expect(standaloneLocalDependencies('#import "a.typ"\n#import "a.typ"')).toEqual(["a.typ"]);
  });
});

describe("standalone document flag", () => {
  test("tracks standalone mode and defaults to false", () => {
    let state = EditorState.create({ doc: "", extensions: [standaloneDocumentField] });
    expect(isStandaloneDocument(state)).toBe(false);
    state = state.update({ effects: setStandaloneDocumentEffect.of(true) }).state;
    expect(isStandaloneDocument(state)).toBe(true);
    state = state.update({ effects: setStandaloneDocumentEffect.of(false) }).state;
    expect(isStandaloneDocument(state)).toBe(false);
  });
});
