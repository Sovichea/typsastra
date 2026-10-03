import { describe, expect, test } from "bun:test";
import { getIndentation, indentUnit, syntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { typstLanguage } from "../src/editor/typstLanguage";

type ParsedToken = {
  name: string;
  text: string;
};

function parseTokens(doc: string): ParsedToken[] {
  const state = EditorState.create({ doc, extensions: [typstLanguage] });
  const cursor = syntaxTree(state).cursor();
  const tokens: ParsedToken[] = [];

  do {
    if (cursor.name !== "Document") {
      tokens.push({ name: cursor.name, text: doc.slice(cursor.from, cursor.to) });
    }
  } while (cursor.next());

  return tokens;
}

function tokenName(tokens: ParsedToken[], text: string): string | undefined {
  return tokens.find(token => token.text === text)?.name;
}

function indentationAt(doc: string, position: number): number | null {
  const state = EditorState.create({
    doc,
    extensions: [typstLanguage, indentUnit.of("  ")]
  });
  return getIndentation(state, position);
}

describe("Typst stream language", () => {
  test("counts a closure body inside a function call as one indentation level", () => {
    const doc = "#let x = items.map(it => {\n\n})";
    const blankLine = doc.indexOf("\n") + 1;
    const closingLine = doc.lastIndexOf("})");

    expect(indentationAt(doc, blankLine)).toBe(2);
    expect(indentationAt(doc, closingLine)).toBe(0);
  });

  test("preserves ordinary nested call indentation", () => {
    const doc = "#figure(\n  image(\n\n  )\n)";
    const blankLine = doc.indexOf("\n\n") + 1;

    expect(indentationAt(doc, blankLine)).toBe(4);
  });

  test("tags only line-leading whitespace as fixed-width indentation", () => {
    const tokens = parseTokens("  #image(\n    width: 100%,\n  )\nPlain prose keeps spaces");

    expect(tokens.filter(token => token.name === "indentation").map(token => token.text))
      .toEqual(["  ", "    ", "  "]);
    expect(tokenName(tokens, " ")).toBeUndefined();
  });

  test("applies heading, strong, and emphasis tags to their content", () => {
    const tokens = parseTokens("= Heading *bold* _italic_");

    expect(tokenName(tokens, "Heading")).toContain("heading");
    expect(tokenName(tokens, "bold")).toContain("strong");
    expect(tokenName(tokens, "italic")).toContain("emphasis");
  });

  test("keeps an attached heading label out of the heading style", () => {
    const tokens = parseTokens("= Heading <intro>");

    expect(tokenName(tokens, "= ")).toBe("heading");
    expect(tokenName(tokens, "Heading")).toContain("heading");
    expect(tokenName(tokens, "<intro>")).toBe("label");
  });

  test("continues a hash expression across operators and returns to prose", () => {
    const tokens = parseTokens("#x + y and prose");

    expect(tokenName(tokens, "#")).toBe("hashVariable");
    expect(tokenName(tokens, "+")).toBe("operator");
    expect(tokenName(tokens, "x")).toBe("referenceVariable");
    expect(tokenName(tokens, "y")).toBe("referenceVariable");
    expect(tokenName(tokens, "and")).toBe("content");
    expect(tokenName(tokens, "prose")).toBe("content");
  });

  test("distinguishes math variables, numbers, and embedded code", () => {
    const tokens = parseTokens("$ x^2 + #value $");

    expect(tokenName(tokens, "x")).toBeUndefined();
    expect(tokenName(tokens, "2")).toBe("number");
    expect(tokenName(tokens, "value")).toBe("referenceVariable");
  });

  test("colors a hash like the expression it introduces", () => {
    const tokens = parseTokens('#emph[hi]\n#emoji.face\n#"hello".len()\n#let x = 1');
    const hashTokens = tokens.filter(token => token.text === "#").map(token => token.name);

    expect(hashTokens).toEqual(["hashFunction", "hashVariable", "hashString", "hashKeyword"]);
    expect(tokenName(tokens, "emph")).toBe("function");
    expect(tokenName(tokens, "emoji")).toBe("referenceVariable");
    expect(tokenName(tokens, "face")).toBe("referenceVariable");
    expect(tokenName(tokens, '"hello"')).toBe("string");
    expect(tokenName(tokens, "len")).toBe("function");
    expect(tokenName(tokens, "x")).toBeUndefined();
  });

  test("returns to markup between context expressions on the same line", () => {
    const tokens = parseTokens("#context counter(page).display() #context counter(page).display()");
    const hashTokens = tokens.filter(token => token.text === "#").map(token => token.name);
    const contextTokens = tokens.filter(token => token.text === "context").map(token => token.name);

    expect(hashTokens).toEqual(["hashKeyword", "hashKeyword"]);
    expect(contextTokens).toEqual(["keyword", "keyword"]);
  });

  test("tokenizes plain, unit, percentage, and scientific numbers consistently", () => {
    const tokens = parseTokens("#let x = 1\n#let y = 1em\n#let z = 50%\n#let n = 1e5\n#let m = 1.2e-3");

    expect(tokenName(tokens, "1")).toBe("number");
    expect(tokenName(tokens, "1em")).toBe("number");
    expect(tokenName(tokens, "50%")).toBe("number");
    expect(tokenName(tokens, "1e5")).toBe("number");
    expect(tokenName(tokens, "1.2e-3")).toBe("number");
  });

  test("separates a variable receiver from a called method", () => {
    const tokens = parseTokens("#values.at(0)");

    expect(tokenName(tokens, "#")).toBe("hashVariable");
    expect(tokenName(tokens, "values")).toBe("referenceVariable");
    expect(tokenName(tokens, "at")).toBe("function");
  });

  test("highlights a fenced raw-block language on the opening line", () => {
    const tokens = parseTokens("```typ\n#let x = 1\n```");

    expect(tokenName(tokens, "typ")).toBe("string");
    expect(tokenName(tokens, "#let x = 1")).toBe("monospace");
  });

  test("does not leak strong styling past an embedded code expression", () => {
    const doc = `#let quotation = {
  ([*#render(t.total-duration)*], [*#render(lead-time-str)*])
  if timeline.len() > 0 {
    import "@preview/timeliney:0.4.0"
  }
}`;
    const tokens = parseTokens(doc);

    expect(tokenName(tokens, "if")).toBe("keyword");
    expect(tokenName(tokens, "import")).toBe("keyword");
    expect(tokenName(tokens, "timeline") ?? "").not.toContain("strong");
  });

  test("keeps the enclosing statement in code mode after a nested set rule", () => {
    const doc = [
      "#let card = v(1cm) + block(",
      "  align(left)[",
      '    #set text(font: "something")',
      "  ]",
      ") + if answer == [] {",
      "  v(3cm)",
      "} else {",
      "  v(0.2cm) + block()[Something.]",
      "}",
    ].join("\n");
    const tokens = parseTokens(doc);

    // The set rule ends inside the content block; the rest of the `let`
    // statement is still code rather than markup.
    expect(tokens.filter(token => token.text === "+").map(token => token.name))
      .toEqual(["operator", "operator", "operator"]);
    expect(tokenName(tokens, "if")).toBe("keyword");
    expect(tokenName(tokens, "else")).toBe("keyword");
    expect(tokenName(tokens, "v")).toBe("function");
    expect(tokenName(tokens, "3cm")).toBe("number");
  });

  test("keeps sibling set rules from ending the enclosing expression", () => {
    const tokens = parseTokens([
      "#let f = block[",
      "  #set text(size: 8pt)",
      "  #set par(justify: true)",
      "] + 1",
    ].join("\n"));

    expect(tokenName(tokens, "+")).toBe("operator");
    expect(tokenName(tokens, "1")).toBe("number");
  });

  test("returns to markup when a nested expression's own brackets have closed", () => {
    const tokens = parseTokens("#a[#b[#c[text]]]\nplain prose\n#emph[y] tail");

    expect(tokenName(tokens, "plain")).toBe("content");
    expect(tokenName(tokens, "prose")).toBe("content");
    expect(tokenName(tokens, "emph")).toBe("function");
    expect(tokenName(tokens, "tail")).toBe("content");
  });
});
