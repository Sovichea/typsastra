import type {
  StoredTable,
  StoredTableCell,
  StoredTableCellBorders,
} from "../workspace/workspaceStateStore";

export const TABLE_DIRECTIVE_PREFIX = "//@table:";
export const TABLE_MANAGED_START = "//@generated-table-start";
export const TABLE_MANAGED_END = "//@generated-table-end";

export function escapeTableText(text: string): string {
  return text.replace(/([\\[\]#$*_`@])/gu, "\\$1");
}

const CELL_BORDER_SIDES: Array<keyof StoredTableCellBorders> = ["top", "right", "bottom", "left"];

function formatPoints(value: number): string {
  return Number.isInteger(value) ? String(value) : String(value).replace(/0+$/u, "").replace(/\.$/u, "");
}

export function typstStroke(width: number, color: string): string {
  return `${formatPoints(width)}pt + rgb("${color}")`;
}

function sideSource(table: StoredTable, cell: StoredTableCell, side: keyof StoredTableCellBorders): string {
  const override = cell.borders?.[side];
  if (override) return override.enabled ? typstStroke(override.width, override.color) : "none";
  return table.stroke === "solid" ? typstStroke(table.strokeWidth, table.strokeColor) : "none";
}

function cellSource(table: StoredTable, cell: StoredTableCell): string {
  const text = escapeTableText(cell.text);
  const content = cell.align ? `#align(${cell.align})[${text}]` : `[${text}]`;
  const argumentsList: string[] = [];
  if (cell.colspan > 1) argumentsList.push(`colspan: ${cell.colspan}`);
  if (cell.rowspan > 1) argumentsList.push(`rowspan: ${cell.rowspan}`);
  if (cell.borders) {
    const dict = CELL_BORDER_SIDES
      .map(side => `${side}: ${sideSource(table, cell, side)}`)
      .join(", ");
    argumentsList.push(`stroke: (${dict})`);
  }
  return argumentsList.length > 0
    ? `table.cell(${argumentsList.join(", ")})${content}`
    : content;
}

/** Generates the managed Typst `table` call for a project table. */
export function generateTableTypst(table: StoredTable): string {
  const lines: string[] = [
    "#table(",
    `  columns: ${table.columns},`,
    `  stroke: ${table.stroke === "none" ? "none" : typstStroke(table.strokeWidth, table.strokeColor)},`,
  ];
  table.rows.forEach((row, rowIndex) => {
    const isHeaderRow = table.headerRow && rowIndex === 0;
    const cells = row
      .map((cell, columnIndex) => ({ cell, columnIndex }))
      .filter(({ cell }) => !cell.covered)
      .map(({ cell, columnIndex }) => {
        const source = cellSource(table, cell);
        return table.headerColumn && !isHeaderRow && columnIndex === 0
          ? `table.header(${source})`
          : source;
      });
    if (cells.length === 0) return;
    const body = cells.join(", ");
    lines.push(isHeaderRow ? `  table.header(${body}),` : `  ${body},`);
  });
  lines.push(")");
  return lines.join("\n");
}

/**
 * The directive block confirmed from autocomplete: the anchor comment, the
 * generated code, and explicit markers so the tool can rewrite it in place.
 */
export function tableDirectiveBlock(table: StoredTable): string {
  return [
    `${TABLE_DIRECTIVE_PREFIX}${table.id}`,
    TABLE_MANAGED_START,
    generateTableTypst(table),
    TABLE_MANAGED_END,
  ].join("\n");
}

export type TableDirectiveBlockRange = {
  tableId: string;
  /** Start of the anchor directive line. */
  from: number;
  /** End of the managed end marker line (exclusive). */
  to: number;
  /** Content range between the markers, excluding the marker lines. */
  contentFrom: number;
  contentTo: number;
};

/** Finds `//@table:<id>` anchors followed by a managed generated block. */
export function findTableDirectiveBlocks(text: string): TableDirectiveBlockRange[] {
  const blocks: TableDirectiveBlockRange[] = [];
  const lines = text.split("\n");
  const lineStarts: number[] = [];
  let offset = 0;
  for (const line of lines) {
    lineStarts.push(offset);
    offset += line.length + 1;
  }
  const endOfLine = (index: number) => lineStarts[index] + lines[index].length;
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^\/\/@table:([A-Za-z0-9_]+)\s*$/u.exec(lines[index].trim());
    if (!match || (lines[index + 1] ?? "").trim() !== TABLE_MANAGED_START) continue;
    let endIndex = -1;
    for (let cursor = index + 2; cursor < lines.length; cursor += 1) {
      if (lines[cursor].trim() === TABLE_MANAGED_END) {
        endIndex = cursor;
        break;
      }
    }
    if (endIndex === -1) continue;
    const contentFrom = lineStarts[index + 2] ?? text.length;
    blocks.push({
      tableId: match[1],
      from: lineStarts[index],
      to: endOfLine(endIndex),
      contentFrom,
      contentTo: endIndex > index + 2 ? endOfLine(endIndex - 1) : contentFrom,
    });
    index = endIndex;
  }
  return blocks;
}
