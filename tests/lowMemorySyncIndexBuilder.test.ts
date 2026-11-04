import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parseLowMemorySyncQuery } from "../src/preview/lowMemorySyncIndexBuilder";
import { LowMemorySyncIndexRuntime, type LowMemorySyncIndex } from "../src/preview/lowMemorySyncIndex";

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

  test("preserves cell and caption source ranges", () => {
    expect(parseLowMemorySyncQuery(JSON.stringify([
      {
        typsastra_sync: true,
        file: 0,
        line: 12,
        line_end: 14,
        pos: { page: 3, x: "72pt", y: "96pt" },
      },
    ]))).toEqual([
      { fileId: 0, line: 12, lineEnd: 14, pageNo: 3, x: 72, y: 96 },
    ]);
  });

  test("forward sync prefers the containing cell range", () => {
    const index: LowMemorySyncIndex = {
      version: 5,
      rootFile: "C:/Work/main.typ",
      generationId: "generation",
      pdfHash: "hash",
      files: ["C:/Work/main.typ"],
      anchors: [
        { fileId: 0, line: 1, pageNo: 1, x: 10, y: 10 },
        { fileId: 0, line: 2, lineEnd: 4, pageNo: 1, x: 20, y: 30 },
      ],
    };
    const runtime = new LowMemorySyncIndexRuntime(index);
    expect(runtime.findSource("C:/Work/main.typ", 3)?.x).toBe(20);
    expect(runtime.findSource("C:/Work/main.typ", 4)?.x).toBe(20);
  });

  test("forward sync prefers the narrowest containing range", () => {
    const index: LowMemorySyncIndex = {
      version: 5,
      rootFile: "C:/Work/main.typ",
      generationId: "generation",
      pdfHash: "hash",
      files: ["C:/Work/main.typ"],
      anchors: [
        { fileId: 0, line: 2, lineEnd: 10, pageNo: 1, x: 20, y: 30 },
        { fileId: 0, line: 4, lineEnd: 5, pageNo: 2, x: 40, y: 50 },
      ],
    };
    const runtime = new LowMemorySyncIndexRuntime(index);
    expect(runtime.findSource("C:/Work/main.typ", 4)?.x).toBe(40);
    expect(runtime.findSource("C:/Work/main.typ", 8)?.x).toBe(20);
  });
});
