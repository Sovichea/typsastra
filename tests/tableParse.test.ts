import { describe, expect, test } from "bun:test";
import { extractTableCells } from "../src/components/tableParse";
import { generateTableTypst } from "../src/components/tableTypst";
import type { StoredTable, StoredTableCell } from "../src/workspace/workspaceStateStore";

function cell(text: string, init: Partial<StoredTableCell> = {}): StoredTableCell {
  return {
    text,
    align: null,
    verticalAlign: null,
    emphasis: null,
    colspan: 1,
    rowspan: 1,
    covered: false,
    borders: null,
    fill: null,
    textColor: null,
    rotate: false,
    breakable: null,
    inset: null,
    raw: false,
    ...init,
  };
}

function table(rows: StoredTableCell[][], columns: number): StoredTable {
  return {
    id: "sample",
    name: "Sample",
    columns,
    headerRow: true,
    headerRowCount: 1,
    headerColumn: false,
    headerRepeat: true,
    stroke: "solid",
    strokeWidth: 0.5,
    strokeColor: "#000000",
    style: "default",
    caption: "",
    captionPosition: "bottom",
    captionAlign: "left",
    columnSizes: Array.from({ length: columns }, () => ""),
    rowSizes: Array.from({ length: rows.length }, () => ""),
    gutter: 0,
    label: "",
    alt: "",
    footerRow: false,
    footerRepeat: true,
    breakable: false,
    dataFile: "",
    rules: [],
    rows,
  };
}

describe("table block parsing", () => {
  test("extracts plain cells across headers, rows, and rules", () => {
    const code = [
      "#table(",
      "  columns: 3,",
      '  stroke: 0.5pt + rgb("#000000"),',
      "  table.header([Name], [Score], [Grade]),",
      "  [Ada], [95], [A],",
      "  table.hline(y: 2, stroke: 1pt + rgb(\"#000000\")),",
      "  [Linus], [88], [B+],",
      ")",
    ].join("\n");

    expect(extractTableCells(code)).toEqual([
      "Name", "Score", "Grade",
      "Ada", "95", "A",
      "Linus", "88", "B+",
    ]);
  });

  test("keeps brackets inside math and raw spans", () => {
    const code = "#table(columns: 2, [$p[q]r$], [`x]y`], [plain], [after])";
    expect(extractTableCells(code)).toEqual(["$p[q]r$", "`x]y`", "plain", "after"]);
  });

  test("handles table.cell spans and nested headers", () => {
    const code = [
      "#table(",
      "  columns: 3,",
      "  table.header(table.cell(colspan: 2)[Title], [Qty]),",
      "  table.cell(rowspan: 2)[Merged], [1], [2],",
      "  [3], [4],",
      ")",
    ].join("\n");

    expect(extractTableCells(code)).toEqual(["Title", "Qty", "Merged", "1", "2", "3", "4"]);
  });

  test("rejects a data-driven body", () => {
    const code = '#table(columns: 2, ..csv("data.csv").map(row => row.map(cell => [cell])).flatten())';
    expect(extractTableCells(code)).toBeNull();
  });

  test("round-trips generated cells in order", () => {
    const model = table([
      [cell("Name"), cell("Value")],
      [cell("Alpha"), cell("a*b")],
      [cell("Beta"), cell("$x^2$")],
    ], 2);
    const cells = extractTableCells(generateTableTypst(model));
    // Cells are returned as authored source (escaped text stays escaped).
    expect(cells).toEqual(["Name", "Value", "Alpha", "a\\*b", "Beta", "$x^2$"]);
  });
});
