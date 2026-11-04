import { describe, expect, test } from "bun:test";
import { EditorState } from "@codemirror/state";
import { typstLanguage } from "../src/editor/typstLanguage";
import {
  findTypstDefinitions,
  findTypstImports,
  resolveTypstSymbol,
  typstFunctionCallAt,
} from "../src/editor/typstSymbolNavigation";

function state(source: string): EditorState {
  return EditorState.create({ doc: source, extensions: [typstLanguage] });
}

describe("Typst function-call detection", () => {
  test("detects markup and code function calls", () => {
    const source = '#my-func(2)\n#other-call[content]\n#let helper(x) = x\n#helper(1)';
    const first = typstFunctionCallAt(state(source), source.indexOf("my-func") + 2);
    const second = typstFunctionCallAt(state(source), source.indexOf("other-call") + 3);
    const third = typstFunctionCallAt(state(source), source.lastIndexOf("helper") + 2);
    expect(first?.name).toBe("my-func");
    expect(second?.name).toBe("other-call");
    expect(third?.name).toBe("helper");
  });

  test("ignores strings, comments, prose, and non-call references", () => {
    const source = [
      '#let name = "my-func("',
      "// #my-func(3)",
      "prose my-func( text",
      "obj.method(1)",
      "#my-func",
    ].join("\n");
    for (const needle of ["my-func", "method"]) {
      const index = source.indexOf(needle);
      expect(typstFunctionCallAt(state(source), index + 1)).toBeNull();
    }
  });
});

describe("Typst import parsing", () => {
  test("parses wildcard, explicit, aliased, and multiline imports", () => {
    const source = [
      '#import "disser-template.typ": *',
      '#import "parts/abbreviations.typ": name, other as alias',
      '#import "chapters/one.typ": (',
      "  first,",
      "  second as second-alias,",
      ")",
      '#import "module.typ" as module',
      '// #import "ignored.typ": *',
    ].join("\n");

    expect(findTypstImports(source)).toEqual([
      { path: "disser-template.typ", wildcard: true, items: [] },
      {
        path: "parts/abbreviations.typ",
        wildcard: false,
        items: [
          { name: "name", alias: "name" },
          { name: "other", alias: "alias" },
        ],
      },
      {
        path: "chapters/one.typ",
        wildcard: false,
        items: [
          { name: "first", alias: "first" },
          { name: "second", alias: "second-alias" },
        ],
      },
    ]);
  });

  test("finds function and variable let bindings", () => {
    const definitions = findTypstDefinitions("#let greet(name) = name\n#let answer = 42");
    expect(definitions.map(definition => [definition.name, definition.kind])).toEqual([
      ["greet", "function"],
      ["answer", "variable"],
    ]);
  });

  test("finds definitions beyond the initial parse region", () => {
    const source = `${"#let filler = 1\n".repeat(300)}#let late-fn(x) = x`;
    expect(findTypstDefinitions(source).some(definition => definition.name === "late-fn"))
      .toBe(true);
  });
});

describe("local Typst symbol resolution", () => {
  const mainSource = [
    '#import "helpers.typ": greet as hello',
    '#import "wild.typ": *',
    '#import "/shared/root.typ": *',
    '#import "@preview/example:1.0.0": package-fn',
    '#hello("x")',
    "#extra(1)",
    "#root-fn(1)",
    "#local(1)",
    "#let local(x) = x",
    "#missing()",
  ].join("\n");

  const files = new Map<string, string>([
    ["C:/Work/helpers.typ", "#let greet(name) = name\n"],
    ["C:/Work/wild.typ", '#import "helpers.typ": *\n#let extra(x) = x\n'],
    ["C:/Work/shared/root.typ", "#let root-fn(x) = x\n"],
  ]);

  const readFile = async (path: string): Promise<string | null> => files.get(path) ?? null;

  test("follows explicit imports and aliases", async () => {
    expect(await resolveTypstSymbol("hello", "C:/Work/main.typ", "C:/Work", readFile, {
      preferredOffset: mainSource.indexOf("hello"),
      entrySource: mainSource,
    })).toEqual({
      path: "C:/Work/helpers.typ",
      name: "greet",
      line: 0,
      character: 5,
      kind: "function",
    });
  });

  test("follows wildcard imports and root-relative paths", async () => {
    const offset = mainSource.indexOf("root-fn");
    expect(await resolveTypstSymbol("root-fn", "C:/Work/main.typ", "C:/Work", readFile, {
      preferredOffset: offset,
      entrySource: mainSource,
    })).toEqual({
      path: "C:/Work/shared/root.typ",
      name: "root-fn",
      line: 0,
      character: 5,
      kind: "function",
    });
  });

  test("follows wildcard imports recursively", async () => {
    const offset = mainSource.indexOf("extra");
    expect(await resolveTypstSymbol("extra", "C:/Work/main.typ", "C:/Work", readFile, {
      preferredOffset: offset,
      entrySource: mainSource,
    })).toEqual({
      path: "C:/Work/wild.typ",
      name: "extra",
      line: 1,
      character: 5,
      kind: "function",
    });
  });

  test("falls back to a later local binding and ignores package imports", async () => {
    expect(await resolveTypstSymbol("local", "C:/Work/main.typ", "C:/Work", readFile, {
      preferredOffset: mainSource.indexOf("local"),
      entrySource: mainSource,
    })).toEqual({
      path: "C:/Work/main.typ",
      name: "local",
      line: 8,
      character: 5,
      kind: "function",
    });
    expect(await resolveTypstSymbol("package-fn", "C:/Work/main.typ", "C:/Work", readFile, {
      preferredOffset: mainSource.indexOf("package-fn"),
      entrySource: mainSource,
    })).toBeNull();
  });

  test("stops on import cycles and missing symbols", async () => {
    const cycleFiles = new Map<string, string>([
      ["C:/Work/a.typ", '#import "b.typ": *\n#let a = 1\n'],
      ["C:/Work/b.typ", '#import "a.typ": *\n#let b = 2\n'],
    ]);
    const readCycle = async (path: string): Promise<string | null> => cycleFiles.get(path) ?? null;
    expect(await resolveTypstSymbol("missing", "C:/Work/a.typ", "C:/Work", readCycle))
      .toBeNull();
  });
});
