import { describe, expect, test } from "bun:test";
import { exportTableTypst, importTableTypst } from "../src/components/tableExchange";
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
    style: "report",
    caption: "Quarterly results",
    captionPosition: "bottom",
    captionAlign: "center",
    columnSizes: Array.from({ length: columns }, () => ""),
    rowSizes: Array.from({ length: rows.length }, () => ""),
    gutter: 2,
    label: "tab:results",
    alt: "Results",
    footerRow: false,
    footerRepeat: true,
    breakable: false,
    dataFile: "",
    rules: [],
    rows,
  };
}

describe("table exchange", () => {
  test("round-trips a tool export losslessly", () => {
    const model = table([
      [cell("Name"), cell("Value")],
      [cell("Alpha", { emphasis: "bold", fill: "#eef3f9" }), cell("a*b")],
    ], 2);
    model.name = "Revenue Report";

    const result = importTableTypst(exportTableTypst(model));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.source).toBe("tool");
    expect(result.table.name).toBe("Revenue Report");
    expect(result.table.style).toBe("report");
    expect(result.table.label).toBe("tab:results");
    expect(result.table.rows[1][0].emphasis).toBe("bold");
    expect(result.table.rows[1][0].fill).toBe("#eef3f9");
    expect(result.table.rows[1][1].text).toBe("a*b");
  });

  test("imports a simple hand-written table", () => {
    const code = [
      "#table(",
      "  columns: 2,",
      "  table.header([Name], [Score]),",
      "  [Ada], [95],",
      "  [Linus], [88],",
      ")",
    ].join("\n");

    const result = importTableTypst(code);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.source).toBe("handwritten");
    expect(result.table.headerRow).toBe(true);
    expect(result.table.columns).toBe(2);
    expect(result.table.rows).toHaveLength(3);
    expect(result.table.rows[2][1].text).toBe("88");
    expect(result.table.rows[2][1].raw).toBe(true);
  });

  test("rejects tables it cannot reproduce", () => {
    const cases = [
      "#table(columns: 2, table.cell(colspan: 2)[A])",
      '#table(columns: 2, ..csv("x.csv").map(row => row))',
      "#table([a], [b], [c], [d])",
      "#table(columns: 2, [a], [b], [c])",
    ];
    for (const code of cases) {
      expect(importTableTypst(code).ok).toBe(false);
    }
  });
});
