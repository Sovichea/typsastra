import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { EditorState } from "@codemirror/state";
import { typstImportPathRange } from "../src/editor/extensions";

const extensions = readFileSync(new URL("../src/editor/extensions.ts", import.meta.url), "utf8");

describe("Ctrl-hover Typst links", () => {
  test("covers the complete include path across hyphens and dots", () => {
    const source = '#include "foo-bar-2.typ"';
    const state = EditorState.create({ doc: source });
    const position = source.indexOf("bar") + 1;

    const range = typstImportPathRange(state, position);
    expect(range).not.toBeNull();
    expect(state.sliceDoc(range!.from, range!.to)).toBe("foo-bar-2.typ");
  });

  test("covers a complete nested import path", () => {
    const source = '#import "templates/chapter-one.typ": chapter';
    const state = EditorState.create({ doc: source });
    const position = source.indexOf("chapter-one") + 4;

    const range = typstImportPathRange(state, position);
    expect(range).not.toBeNull();
    expect(state.sliceDoc(range!.from, range!.to)).toBe("templates/chapter-one.typ");
  });

  test("does not treat an unrelated quoted string as an import path", () => {
    const source = '#let name = "foo-bar-2.typ"';
    const state = EditorState.create({ doc: source });

    expect(typstImportPathRange(state, source.indexOf("bar"))).toBeNull();
  });

  test.each([
    ['#bibliography("references/research refs.bib")', "references/research refs.bib"],
    ['#figure(image("figures/ការស្រាវជ្រាវ.png"))', "figures/ការស្រាវជ្រាវ.png"]
  ])("covers navigable research asset paths in %s", (source, expected) => {
    const state = EditorState.create({ doc: source });
    const position = source.indexOf(expected) + Math.floor(expected.length / 2);
    const range = typstImportPathRange(state, position);
    expect(range).not.toBeNull();
    expect(state.sliceDoc(range!.from, range!.to)).toBe(expected);
  });

  test("resolves local Typst paths before asking the LSP", () => {
    const handler = extensions.slice(
      extensions.indexOf("mousedown: (event, view) =>"),
      extensions.indexOf("foldService.of")
    );
    const pathNavigation = handler.indexOf("onNavigateToTypstPath");
    const symbolNavigation = handler.indexOf("onNavigateToTypstSymbol");
    const definitionLookup = handler.indexOf("getDefinition");
    expect(pathNavigation).toBeGreaterThan(-1);
    expect(symbolNavigation).toBeGreaterThan(-1);
    expect(definitionLookup).toBeGreaterThan(-1);
    expect(pathNavigation).toBeLessThan(definitionLookup);
    expect(symbolNavigation).toBeLessThan(definitionLookup);
  });
});
