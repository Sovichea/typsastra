import { describe, expect, test } from "bun:test";
import { EditorState } from "@codemirror/state";
import { typstLanguage } from "../src/editor/typstLanguage";
import { applyPathFix, findTypstPathWarnings, rootRelativePath } from "../src/editor/pathWarnings";

function warningsFor(
  doc: string,
  documentPath = "chapters/section/main.typ",
  workspaceRoot = "/book",
) {
  const state = EditorState.create({ doc, extensions: [typstLanguage] });
  const absoluteDocumentPath = documentPath.startsWith(workspaceRoot)
    ? documentPath
    : `${workspaceRoot}/${documentPath}`;
  return findTypstPathWarnings(state, { workspaceRoot, documentPath: absoluteDocumentPath });
}

describe("root-relative path warnings", () => {
  test("converts image paths that climb out of the document folder", () => {
    const warnings = warningsFor('#image("../../images/img.jpeg")');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      path: "../../images/img.jpeg",
      rootPath: "/images/img.jpeg",
      from: '#image("'.length,
      to: '#image("../../images/img.jpeg'.length,
      widgetAt: '#image("../../images/img.jpeg"'.length,
    });
  });

  test("covers include, import, and bibliography directives", () => {
    const doc = [
      '#include "../chapters/intro.typ"',
      '#import "../lib.typ": helper',
      '#bibliography("../refs.bib", style: "../styles/ieee.csl")',
      '#bibliography(("../more.bib", "../extra.bib"))',
    ].join("\n");
    expect(warningsFor(doc, "chapters/main.typ").map(warning => warning.rootPath)).toEqual([
      "/chapters/intro.typ",
      "/lib.typ",
      "/refs.bib",
      "/styles/ieee.csl",
      "/more.bib",
      "/extra.bib",
    ]);
  });

  test("covers every built-in data and asset path function", () => {
    const doc = [
      '#csv("../data/a.csv")',
      '#json("../data/a.json")',
      '#yaml("../data/a.yaml")',
      '#toml("../data/a.toml")',
      '#cbor("../data/a.cbor")',
      '#xml("../data/a.xml")',
      '#read("../data/a.txt")',
      '#plugin("../bin/a.wasm")',
      '#pdf.embed("../docs/a.pdf")',
    ].join("\n");
    expect(warningsFor(doc, "chapters/main.typ").map(warning => warning.rootPath)).toEqual([
      "/data/a.csv",
      "/data/a.json",
      "/data/a.yaml",
      "/data/a.toml",
      "/data/a.cbor",
      "/data/a.xml",
      "/data/a.txt",
      "/bin/a.wasm",
      "/docs/a.pdf",
    ]);
  });

  test("ignores root-relative, package, URL, and non-climbing paths", () => {
    const doc = [
      '#image("/images/a.png")',
      '#import "@preview/pkg:0.1.0": thing',
      '#image("images/a.png")',
      '#image("./images/a.png")',
      '#include "https://example.com/a.typ"',
    ].join("\n");
    expect(warningsFor(doc)).toEqual([]);
  });

  test("ignores comments, raw blocks, and paths that escape the project", () => {
    const doc = [
      '// #image("../comment.png")',
      '/* #include "../block.typ" */',
      '```typ',
      '#image("../raw.png")',
      '```',
      '#image("../images/real.png")',
    ].join("\n");
    expect(warningsFor(doc, "chapters/main.typ").map(warning => warning.rootPath))
      .toEqual(["/images/real.png"]);
    expect(warningsFor('#image("../../outside.png")', "main.typ")).toEqual([]);
  });

  test("normalizes dot segments before building the root path", () => {
    expect(rootRelativePath("chapters/main.typ", "./images/../a.png")).toBe("/chapters/a.png");
    expect(rootRelativePath("main.typ", "../a.png")).toBeNull();
    expect(rootRelativePath("chapters/section/main.typ", "../../images/a.png"))
      .toBe("/images/a.png");
  });

  test("applies the root path replacement", () => {
    const warning = warningsFor('#image("../../images/img.jpeg")')[0];
    const dispatched: Array<Record<string, unknown>> = [];
    let focused = false;
    applyPathFix({
      dispatch: (spec: Record<string, unknown>) => dispatched.push(spec),
      focus: () => { focused = true; },
    } as never, warning);
    expect(dispatched[0].changes).toEqual({
      from: '#image("'.length,
      to: '#image("../../images/img.jpeg'.length,
      insert: "/images/img.jpeg",
    });
    expect(dispatched[0].selection).toEqual({
      anchor: '#image("'.length + "/images/img.jpeg".length,
    });
    expect(focused).toBe(true);
  });
});
