import { describe, expect, test } from "bun:test";
import { parseDocumentOutline } from "../src/outline/documentOutline";

describe("document outline", () => {
  const parse = (source: string) => parseDocumentOutline(
    "C:/workspace/main.typ",
    source,
    "C:/workspace",
    async () => null
  );

  test("builds a nested heading tree with source positions", async () => {
    const source = "= Introduction <intro>\nText\n== Details\n=== Deep dive\n= Conclusion\n";
    const outline = await parse(source);

    expect(outline.map(heading => heading.title)).toEqual(["Introduction", "Conclusion"]);
    expect(outline[0].children[0].title).toBe("Details");
    expect(outline[0].children[0].children[0].title).toBe("Deep dive");
    expect(outline[0].textFrom).toBe(2);
    expect(outline[0].children[0].line).toBe(3);
  });

  test("ignores headings inside comments and fenced raw blocks", async () => {
    const source = [
      "// = Comment heading",
      "/*",
      "= Block comment heading",
      "*/",
      "```typ",
      "= Raw heading",
      "```",
      "= Real heading"
    ].join("\n");

    expect((await parse(source)).map(heading => heading.title)).toEqual(["Real heading"]);
  });

  test("keeps duplicate headings independently addressable", async () => {
    const outline = await parse("= Same\n= Same\n");

    expect(outline).toHaveLength(2);
    expect(outline[0].id).not.toBe(outline[1].id);
    expect(outline[1].from).toBe(7);
  });
});
