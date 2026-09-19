import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parseLowMemorySyncQuery } from "../src/preview/lowMemorySyncIndexBuilder";

describe("low-memory sync index builder", () => {
  test("uses Tinymist LSP export-query option names", () => {
    const source = readFileSync("src/preview/lowMemorySyncIndexBuilder.ts", "utf8");
    expect(source).toContain('format: "json"');
    expect(source).toContain('selector: "metadata"');
    expect(source).toContain('field: "value"');
    expect(source).not.toContain('"query.selector"');
  });

  test("converts Tinymist location JSON dimensions into PDF-point anchors", () => {
    expect(parseLowMemorySyncQuery(JSON.stringify([
      { typsastra_sync: true, file: 2, line: 5232, pos: { page: 247, x: "81.4pt", y: "392.7pt" } },
      { typsastra_sync: true, file: 2, line: 5233, pos: { page: 247, x: "invalid", y: "392.7pt" } },
    ]))).toEqual([
      { fileId: 2, line: 5232, pageNo: 247, x: 81.4, y: 392.7 },
    ]);
  });
});
