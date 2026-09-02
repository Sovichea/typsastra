import { describe, expect, test } from "bun:test";
import { getIndentation, indentUnit, syntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import type { Tree } from "@lezer/common";
import { typstLanguage } from "../src/editor/typstLanguage";

function parse(doc: string): Tree {
  const state = EditorState.create({ doc, extensions: [typstLanguage] });
  return syntaxTree(state);
}

function nodeNames(tree: Tree): string[] {
  const cursor = tree.cursor();
  const names: string[] = [];
  do {
    names.push(cursor.name);
  } while (cursor.next());
  return names;
}

function countErrors(tree: Tree): number {
  const cursor = tree.cursor();
  let errors = 0;
  do {
    if (cursor.type.isError) errors += 1;
  } while (cursor.next());
  return errors;
}

function indentationAt(doc: string, position: number): number | null {
  const state = EditorState.create({
    doc,
    extensions: [typstLanguage, indentUnit.of("  ")],
  });
  return getIndentation(state, position);
}

describe("Typst Lezer language", () => {
  test("parses markup, code, math, raw text, and Unicode prose", () => {
    const doc = [
      "= Heading <intro>",
      "អត្ថបទខ្មែរ with *bold* and _emphasis_.",
      "#let x = (1 + 2) * 3",
      "#text(size: 10pt)[Rendered content]",
      "$ sum_(k=1)^n k + #x $",
      "```typ",
      "#let inside = 1",
      "```",
    ].join("\n");

    const tree = parse(doc);
    const names = nodeNames(tree);

    expect(countErrors(tree)).toBe(0);
    expect(names).toContain("Heading");
    expect(names).toContain("Strong");
    expect(names).toContain("Emph");
    expect(names).toContain("LetBinding");
    expect(names).toContain("Args");
    expect(names).toContain("ContentBlock");
    expect(names).toContain("Equation");
    expect(names).toContain("RawBlock");
    expect(names).toContain("RawLang");
  });

  test("keeps ordinary nested call indentation", () => {
    const doc = "#figure(\n  image(\n\n  )\n)";
    const blankLine = doc.indexOf("\n\n") + 1;

    expect(indentationAt(doc, blankLine)).toBe(4);
  });

  test("parses hash expressions with fields, calls, units, and content blocks", () => {
    const doc = [
      "#values.at(0)",
      "#rect(width: 50%, inset: 1em)[content]",
      "#let n = 1.2e-3",
    ].join("\n");

    const tree = parse(doc);
    const names = nodeNames(tree);

    expect(countErrors(tree)).toBe(0);
    expect(names).toContain("FieldAccess");
    expect(names).toContain("Args");
    expect(names).toContain("Numeric");
    expect(names).toContain("ContentBlock");
  });

  test("parses code blocks and arrow expressions without leaking markup state", () => {
    const doc = "#let mapped = items.map(it => {\n  it + 1\n})\nPlain prose";
    const tree = parse(doc);
    const names = nodeNames(tree);

    expect(countErrors(tree)).toBe(0);
    expect(names).toContain("CodeBlock");
    expect(names).toContain("BinaryExpression");
    expect(names).toContain("Content");
  });

  test("recognizes line structures and references", () => {
    const doc = [
      "- Bullet",
      "+ Enumerated",
      "/ Term: Definition",
      "See https://example.com and @intro <intro>.",
    ].join("\n");
    const names = nodeNames(parse(doc));

    expect(names).toContain("ListItem");
    expect(names).toContain("EnumItem");
    expect(names).toContain("TermItem");
    expect(names).toContain("Link");
    expect(names).toContain("Ref");
    expect(names).toContain("Label");
  });
});
