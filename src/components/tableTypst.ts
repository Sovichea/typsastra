import type {
  StoredTable,
  StoredTableCell,
  StoredTableCellBorders,
} from "../workspace/workspaceStateStore";

export const TABLE_DIRECTIVE_PREFIX = "//@table:";
export const TABLE_MANAGED_START = "//@generated-table-start";
export const TABLE_MANAGED_END = "//@generated-table-end";

/**
 * Escapes Typst markup in a cell while preserving inline math (`$...$`) and
 * raw spans (`` `...` ``), so authors can write equations and raw code.
 */
export function escapeTableText(text: string): string {
  let result = "";
  let index = 0;
  while (index < text.length) {
    const character = text[index];
    if (character === "\\") {
      result += "\\\\";
      index += 1;
      continue;
    }
    if (character === "$" || character === "`") {
      const end = text.indexOf(character, index + 1);
      if (end !== -1) {
        result += text.slice(index, end + 1);
        index = end + 1;
        continue;
      }
      result += `\\${character}`;
      index += 1;
      continue;
    }
    if ("[]#$*_@".includes(character)) {
      result += `\\${character}`;
      index += 1;
      continue;
    }
    result += character;
    index += 1;
  }
  return result;
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

function defaultStroke(table: StoredTable): string {
  return table.stroke === "solid" ? typstStroke(table.strokeWidth, table.strokeColor) : "none";
}

type CellSlot = { row: number; column: number };
type SideOverrides = Partial<Record<keyof StoredTableCellBorders, string>>;
type CellGroup<Value> = { slots: CellSlot[]; value: Value };

function collectSlots(table: StoredTable): CellSlot[] {
  const slots: CellSlot[] = [];
  table.rows.forEach((row, rowIndex) => {
    row.forEach((cell, columnIndex) => {
      if (!cell.covered) slots.push({ row: rowIndex, column: columnIndex });
    });
  });
  return slots;
}

function cellOverrides(table: StoredTable, cell: StoredTableCell): SideOverrides {
  const overrides: SideOverrides = {};
  if (!cell.borders) return overrides;
  const fallback = defaultStroke(table);
  CELL_BORDER_SIDES.forEach(side => {
    if (!cell.borders?.[side]) return;
    const value = sideSource(table, cell, side);
    if (value !== fallback) overrides[side] = value;
  });
  return overrides;
}

function overrideKey(overrides: SideOverrides): string {
  return CELL_BORDER_SIDES
    .filter(side => overrides[side] !== undefined)
    .map(side => `${side}=${overrides[side]}`)
    .join(";");
}

function alignmentValue(cell: StoredTableCell): string | null {
  const parts: string[] = [];
  if (cell.align) parts.push(cell.align);
  if (cell.verticalAlign) {
    parts.push(cell.verticalAlign === "center" ? "horizon" : cell.verticalAlign);
  }
  return parts.length > 0 ? parts.join(" + ") : null;
}

function groupCells<Value>(
  table: StoredTable,
  valueOf: (cell: StoredTableCell) => Value | null,
  keyOf: (value: Value) => string,
): Array<CellGroup<Value>> {
  const groups = new Map<string, CellGroup<Value>>();
  collectSlots(table).forEach(slot => {
    const cell = table.rows[slot.row][slot.column];
    const value = valueOf(cell);
    if (value === null) return;
    const key = keyOf(value);
    const group = groups.get(key);
    if (group) group.slots.push(slot);
    else groups.set(key, { slots: [slot], value });
  });
  return [...groups.values()];
}

/**
 * Translates a set of coordinates into the shortest condition the generated
 * stroke/align functions can test. Whole rows collapse to `y == n`, while
 * scattered cells become `(x == a or x == b) and y == n`.
 */
function coordinatePredicate(table: StoredTable, slots: CellSlot[]): string {
  const originColumns = new Map<number, Set<number>>();
  collectSlots(table).forEach(slot => {
    const columns = originColumns.get(slot.row) ?? new Set<number>();
    columns.add(slot.column);
    originColumns.set(slot.row, columns);
  });
  const byRow = new Map<number, number[]>();
  slots.forEach(slot => {
    const columns = byRow.get(slot.row) ?? [];
    columns.push(slot.column);
    byRow.set(slot.row, columns);
  });
  const terms: string[] = [];
  for (const [row, columns] of [...byRow.entries()].sort((a, b) => a[0] - b[0])) {
    const sorted = [...columns].sort((a, b) => a - b);
    const allColumns = originColumns.get(row) ?? new Set<number>();
    const coversRow = sorted.length === allColumns.size && sorted.every(column => allColumns.has(column));
    if (coversRow) {
      terms.push(`y == ${row}`);
      continue;
    }
    const horizontal = sorted.length === 1
      ? `x == ${sorted[0]}`
      : `(${sorted.map(column => `x == ${column}`).join(" or ")})`;
    terms.push(`(${horizontal} and y == ${row})`);
  }
  return terms.join(" or ");
}

function conditionalArgument(
  lines: string[],
  parameter: string,
  branches: Array<{ predicate: string; value: string }>,
  fallback: string,
): void {
  branches.forEach((branch, index) => {
    const opener = index === 0 ? `  ${parameter}: (x, y) => if` : "  } else if";
    lines.push(`${opener} ${branch.predicate} {`);
    lines.push(`    ${branch.value}`);
  });
  lines.push(`  } else {`);
  lines.push(`    ${fallback}`);
  lines.push("  },");
}

function strokeArgument(table: StoredTable, groups: Array<CellGroup<SideOverrides>>): string {
  const fallback = defaultStroke(table);
  if (groups.length === 0) return `  stroke: ${fallback},`;
  const lines: string[] = [];
  conditionalArgument(
    lines,
    "stroke",
    groups.map(group => {
      const sides = CELL_BORDER_SIDES
        .filter(side => group.value[side] !== undefined)
        .map(side => `${side}: ${group.value[side]}`);
      if (sides.length < CELL_BORDER_SIDES.length) sides.push(`rest: ${fallback}`);
      return { predicate: coordinatePredicate(table, group.slots), value: `(${sides.join(", ")})` };
    }),
    fallback,
  );
  return lines.join("\n");
}

function alignArgument(table: StoredTable, groups: Array<CellGroup<string>>): string {
  const lines: string[] = [];
  conditionalArgument(
    lines,
    "align",
    groups.map(group => ({ predicate: coordinatePredicate(table, group.slots), value: group.value })),
    "auto",
  );
  return lines.join("\n");
}

function cellSource(cell: StoredTableCell): string {
  const text = escapeTableText(cell.text);
  const argumentsList: string[] = [];
  if (cell.colspan > 1) argumentsList.push(`colspan: ${cell.colspan}`);
  if (cell.rowspan > 1) argumentsList.push(`rowspan: ${cell.rowspan}`);
  return argumentsList.length > 0
    ? `table.cell(${argumentsList.join(", ")})[${text}]`
    : `[${text}]`;
}

/** Generates the managed Typst `table` call for a project table. */
export function generateTableTypst(table: StoredTable): string {
  const strokeGroups = groupCells(table, cell => {
    const overrides = cellOverrides(table, cell);
    return overrideKey(overrides) === "" ? null : overrides;
  }, overrideKey);
  const alignGroups = groupCells(table, cell => alignmentValue(cell), value => value);
  const lines: string[] = [
    "#table(",
    `  columns: ${table.columns},`,
    strokeArgument(table, strokeGroups),
  ];
  if (alignGroups.length > 0) lines.push(alignArgument(table, alignGroups));
  table.rows.forEach((row, rowIndex) => {
    const isHeaderRow = table.headerRow && rowIndex === 0;
    const cells = row
      .map((cell, columnIndex) => ({ cell, columnIndex }))
      .filter(({ cell }) => !cell.covered)
      .map(({ cell, columnIndex }) => {
        const source = cellSource(cell);
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
