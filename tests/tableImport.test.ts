import { describe, expect, test } from "bun:test";
import {
  detectDelimiter,
  parseDelimitedText,
  tableFromRows,
  transposeRows,
} from "../src/components/tableImport";

describe("table import", () => {
  test("detects comma versus tab delimiters", () => {
    expect(detectDelimiter("a,b\n1,2")).toBe(",");
    expect(detectDelimiter("a\tb\n1\t2")).toBe("\t");
  });

  test("parses quoted fields and pads ragged rows", () => {
    const rows = parseDelimitedText('Name,Note\n"Doe, Jane","say ""hi"""\nSolo\n');
    expect(rows).toEqual([
      ["Name", "Note"],
      ["Doe, Jane", 'say "hi"'],
      ["Solo"],
    ]);

    const table = tableFromRows(rows, "table_9", "Imported");
    expect(table.columns).toBe(2);
    expect(table.rows).toHaveLength(3);
    expect(table.rows[2][1].text).toBe("");
    expect(table.headerRow).toBe(true);
    expect(table.rowSizes).toHaveLength(3);
  });

  test("transposes rows and columns", () => {
    expect(transposeRows([["a", "b", "c"], ["1", "2", "3"]])).toEqual([
      ["a", "1"],
      ["b", "2"],
      ["c", "3"],
    ]);
  });

  test("drops a trailing blank line", () => {
    expect(parseDelimitedText("a,b\n1,2\n")).toEqual([["a", "b"], ["1", "2"]]);
  });
});
