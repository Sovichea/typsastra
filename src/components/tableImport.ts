import type { StoredTable, StoredTableCell } from "../workspace/workspaceStateStore";

/** Tabs win over commas when both appear on the first line. */
export function detectDelimiter(text: string): string {
  const firstLine = text.split(/\r?\n/u, 1)[0] ?? "";
  return firstLine.includes("\t") ? "\t" : ",";
}

/** Parses CSV/TSV, honouring quoted fields (RFC 4180-style quoting). */
export function parseDelimitedText(text: string, delimiter?: string): string[][] {
  const separator = delimiter ?? detectDelimiter(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += character;
      }
      continue;
    }
    if (character === '"') {
      quoted = true;
    } else if (character === separator) {
      row.push(field);
      field = "";
    } else if (character === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (character !== "\r") {
      field += character;
    }
  }
  row.push(field);
  rows.push(row);
  while (rows.length > 1 && rows[rows.length - 1].every(value => value === "")) rows.pop();
  return rows;
}

/** Swaps rows and columns, padding short rows first. */
export function transposeRows(rows: string[][]): string[][] {
  const width = Math.max(0, ...rows.map(row => row.length));
  return Array.from({ length: width }, (_value, column) =>
    rows.map(row => row[column] ?? ""));
}

function cell(text: string): StoredTableCell {
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
  };
}

/** Builds a header-row table from parsed delimited rows. */
export function tableFromRows(rows: string[][], id: string, name: string): StoredTable {
  const data = rows.length > 0 ? rows : [[""]];
  const columns = Math.max(1, ...data.map(row => row.length));
  const grid = data.map(row =>
    Array.from({ length: columns }, (_value, column) => cell(row[column] ?? "")));
  return {
    id,
    name,
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
    rowSizes: Array.from({ length: grid.length }, () => ""),
    gutter: 0,
    label: "",
    alt: "",
    footerRow: false,
    footerRepeat: true,
    breakable: false,
    rules: [],
    rows: grid,
  };
}
