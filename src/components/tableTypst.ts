import type {
  StoredTable,
  StoredTableCell,
  StoredTableCellBorders,
  StoredTableRule,
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

type SideKey = keyof StoredTableCellBorders;
type CellSlot = { row: number; column: number };
type SideOverrides = Partial<Record<SideKey, string>>;
type CellGroup<Value> = { slots: CellSlot[]; value: Value };

const OPPOSITE_SIDE: Record<SideKey, SideKey> = {
  top: "bottom",
  right: "left",
  bottom: "top",
  left: "right",
};

function slotKey(slot: CellSlot): string {
  return `${slot.row}:${slot.column}`;
}

function collectSlots(table: StoredTable): CellSlot[] {
  const slots: CellSlot[] = [];
  table.rows.forEach((row, rowIndex) => {
    row.forEach((cell, columnIndex) => {
      if (!cell.covered) slots.push({ row: rowIndex, column: columnIndex });
    });
  });
  return slots;
}

function buildOriginGrid(table: StoredTable): Array<Array<CellSlot | null>> {
  const grid = table.rows.map(row => row.map(() => null as CellSlot | null));
  table.rows.forEach((row, rowIndex) => {
    row.forEach((cell, columnIndex) => {
      if (cell.covered) return;
      for (let r = rowIndex; r < Math.min(rowIndex + cell.rowspan, table.rows.length); r += 1) {
        for (let c = columnIndex; c < Math.min(columnIndex + cell.colspan, table.columns); c += 1) {
          if (grid[r] && c < grid[r].length) grid[r][c] = { row: rowIndex, column: columnIndex };
        }
      }
    });
  });
  return grid;
}

function neighborSlots(
  table: StoredTable,
  grid: Array<Array<CellSlot | null>>,
  slot: CellSlot,
  side: SideKey,
): CellSlot[] {
  const cell = table.rows[slot.row][slot.column];
  const neighbors: CellSlot[] = [];
  const add = (row: number, column: number) => {
    const origin = row >= 0 && column >= 0 ? grid[row]?.[column] ?? null : null;
    if (origin && (origin.row !== slot.row || origin.column !== slot.column)) neighbors.push(origin);
  };
  if (side === "top" || side === "bottom") {
    const row = side === "top" ? slot.row - 1 : slot.row + cell.rowspan;
    for (let column = slot.column; column < slot.column + cell.colspan; column += 1) add(row, column);
  } else {
    const column = side === "left" ? slot.column - 1 : slot.column + cell.colspan;
    for (let row = slot.row; row < slot.row + cell.rowspan; row += 1) add(row, column);
  }
  return neighbors;
}

const BAND_FILL = 'rgb("#eef3f9")';
const HEADER_FILL = 'rgb("#dbe4f0")';
const BOOKTABS_OUTER_RULE = 1.5;
const BOOKTABS_HEADER_RULE = 0.75;

/** The number of leading rows treated as the table header. */
function headerRowCountFor(table: StoredTable): number {
  if (!table.headerRow) return 0;
  return Math.max(1, Math.min(table.headerRowCount ?? 1, table.rows.length));
}

/** The stroke a style gives each cell side before any explicit override. */
function baselineRecord(table: StoredTable, slot: CellSlot): Record<SideKey, string> {
  const record = {} as Record<SideKey, string>;
  // Styles that draw explicit rules leave the cell grid unstroked.
  if (table.style !== "booktabs" && table.style !== "report") {
    const stroke = defaultStroke(table);
    CELL_BORDER_SIDES.forEach(side => { record[side] = stroke; });
    return record;
  }
  if (table.style === "report") {
    CELL_BORDER_SIDES.forEach(side => { record[side] = "none"; });
    return record;
  }
  CELL_BORDER_SIDES.forEach(side => { record[side] = "none"; });
  if (slot.row === 0) record.top = typstStroke(BOOKTABS_OUTER_RULE, table.strokeColor);
  if (slot.row === headerRowCountFor(table) - 1) {
    record.bottom = typstStroke(BOOKTABS_HEADER_RULE, table.strokeColor);
  }
  const cell = table.rows[slot.row]?.[slot.column];
  if (cell && slot.row + cell.rowspan === table.rows.length) {
    record.bottom = typstStroke(BOOKTABS_OUTER_RULE, table.strokeColor);
  }
  return record;
}

/** The stroke argument shared by every cell that has no override. */
function strokeFallback(table: StoredTable): string {
  return table.style === "booktabs" || table.style === "report" ? "none" : defaultStroke(table);
}

/** Extra rules a preset style draws (before any user-defined rules). */
function styleRules(table: StoredTable): StoredTableRule[] {
  if (table.style !== "report") return [];
  const rules: StoredTableRule[] = [
    { axis: "horizontal", position: 0, start: 0, end: null, width: BOOKTABS_OUTER_RULE, color: table.strokeColor },
  ];
  const headerCount = headerRowCountFor(table);
  if (headerCount > 0) {
    rules.push({
      axis: "horizontal",
      position: headerCount,
      start: 0,
      end: null,
      width: BOOKTABS_HEADER_RULE,
      color: table.strokeColor,
    });
  }
  rules.push({
    axis: "horizontal",
    position: table.rows.length,
    start: 0,
    end: null,
    width: BOOKTABS_OUTER_RULE,
    color: table.strokeColor,
  });
  return rules;
}



/**
 * Typst resolves coincident cell sides in favor of the lower or right cell, so
 * an override applied to only one side of a shared edge would vanish from the
 * compiled preview. Unify every shared edge across its touching cells first.
 */
function effectiveStrokes(table: StoredTable): Map<string, Record<SideKey, string>> {
  const slots = collectSlots(table);
  const grid = buildOriginGrid(table);
  const parent = new Map<string, string>();
  const find = (key: string): string => {
    let root = key;
    while (parent.get(root) !== root) root = parent.get(root) as string;
    let cursor = key;
    while (parent.get(cursor) !== root) {
      const next = parent.get(cursor) as string;
      parent.set(cursor, root);
      cursor = next;
    }
    return root;
  };
  const union = (a: string, b: string) => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent.set(rootB, rootA);
  };
  const baselines = new Map<string, string>();
  const explicit = new Map<string, string>();
  slots.forEach(slot => {
    const cell = table.rows[slot.row][slot.column];
    const baseline = baselineRecord(table, slot);
    CELL_BORDER_SIDES.forEach(side => {
      const key = `${slotKey(slot)}:${side}`;
      parent.set(key, key);
      baselines.set(key, baseline[side]);
      if (cell.borders?.[side]) explicit.set(key, sideSource(table, cell, side));
    });
  });
  slots.forEach(slot => {
    CELL_BORDER_SIDES.forEach(side => {
      neighborSlots(table, grid, slot, side).forEach(neighbor => {
        union(`${slotKey(slot)}:${side}`, `${slotKey(neighbor)}:${OPPOSITE_SIDE[side]}`);
      });
    });
  });
  const groupValues = new Map<string, { value: string; row: number; column: number; priority: number }>();
  const consider = (value: string, key: string, priority: number) => {
    const root = find(key);
    const [row, column] = key.split(":").map(Number);
    const current = groupValues.get(root);
    if (!current
      || priority > current.priority
      || (priority === current.priority
        && (row > current.row || (row === current.row && column > current.column)))) {
      groupValues.set(root, { value, row, column, priority });
    }
  };
  baselines.forEach((value, key) => {
    if (value !== "none") consider(value, key, 0);
  });
  explicit.forEach((value, key) => consider(value, key, 1));
  const strokes = new Map<string, Record<SideKey, string>>();
  slots.forEach(slot => {
    const record = {} as Record<SideKey, string>;
    CELL_BORDER_SIDES.forEach(side => {
      record[side] = groupValues.get(find(`${slotKey(slot)}:${side}`))?.value ?? "none";
    });
    strokes.set(slotKey(slot), record);
  });
  return strokes;
}

function cellOverrides(strokes: Record<SideKey, string>, fallback: string): SideOverrides {
  const overrides: SideOverrides = {};
  CELL_BORDER_SIDES.forEach(side => {
    if (strokes[side] !== fallback) overrides[side] = strokes[side];
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
  valueOf: (slot: CellSlot, cell: StoredTableCell) => Value | null,
  keyOf: (value: Value) => string,
): Array<CellGroup<Value>> {
  const groups = new Map<string, CellGroup<Value>>();
  collectSlots(table).forEach(slot => {
    const cell = table.rows[slot.row][slot.column];
    const value = valueOf(slot, cell);
    if (value === null || value === undefined) return;
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
  const fallback = strokeFallback(table);
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

function bandFillExpression(table: StoredTable): string {
  // Preset styles shade the header rows and stripe the body so the result
  // reads as styled rather than a plain grid.
  const headerCount = headerRowCountFor(table);
  const header = headerCount > 0 ? `y < ${headerCount}` : "";
  const withHeader = (band: string) => header
    ? `if ${header} { ${HEADER_FILL} } else if ${band} { ${BAND_FILL} }`
    : `if ${band} { ${BAND_FILL} }`;
  if (table.style === "banded-rows") return withHeader("calc.odd(y)");
  if (table.style === "banded-columns") return withHeader("calc.odd(x)");
  if (table.style === "report") return withHeader("calc.odd(y)");
  return "none";
}

function fillArgument(table: StoredTable): string | null {
  const band = bandFillExpression(table);
  const groups = groupCells(table, (_slot, cell) => cell.fill, value => value);
  if (groups.length === 0) {
    return band === "none" ? null : `  fill: (x, y) => ${band},`;
  }
  const lines: string[] = [];
  conditionalArgument(
    lines,
    "fill",
    groups.map(group => ({
      predicate: coordinatePredicate(table, group.slots),
      value: `rgb("${group.value}")`,
    })),
    band,
  );
  return lines.join("\n");
}

function insetArgument(table: StoredTable): string | null {
  const groups = groupCells(table, (_slot, cell) => cell.inset, value => String(value));
  if (groups.length === 0) return null;
  const lines: string[] = [];
  conditionalArgument(
    lines,
    "inset",
    groups.map(group => ({
      predicate: coordinatePredicate(table, group.slots),
      value: `${formatPoints(group.value)}pt`,
    })),
    "5pt",
  );
  return lines.join("\n");
}

/** A Typst string literal for figure `alt` text. */
function typstString(value: string): string {
  return `"${value.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"').replace(/\r?\n/gu, " ")}"`;
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

function cellBody(cell: StoredTableCell): string {
  // Raw cells carry author-written Typst (links, footnotes, lists, ...).
  let text = cell.raw ? cell.text : escapeTableText(cell.text);
  if (cell.textColor) text = `#text(fill: rgb("${cell.textColor}"))[${text}]`;
  if (cell.emphasis === "bold") text = `#strong[${text}]`;
  else if (cell.emphasis === "italic") text = `#emph[${text}]`;
  // "Regular" must also win over an inherited bold/italic show rule.
  else if (cell.emphasis === "regular") text = `#text(weight: "regular", style: "normal")[${text}]`;
  // Vertical headers rotate the whole cell content.
  if (cell.rotate) text = `#rotate(-90deg, reflow: true)[${text}]`;
  return text;
}

function cellSource(cell: StoredTableCell): string {
  const body = cellBody(cell);
  const argumentsList: string[] = [];
  if (cell.colspan > 1) argumentsList.push(`colspan: ${cell.colspan}`);
  if (cell.rowspan > 1) argumentsList.push(`rowspan: ${cell.rowspan}`);
  if (cell.breakable !== null) argumentsList.push(`breakable: ${cell.breakable}`);
  return argumentsList.length > 0
    ? `table.cell(${argumentsList.join(", ")})[${body}]`
    : `[${body}]`;
}

/** An explicit `table.hline`/`table.vline` child. */
function ruleSource(rule: StoredTableRule): string {
  const horizontal = rule.axis === "horizontal";
  const parts = [`${horizontal ? "y" : "x"}: ${rule.position}`];
  if (rule.start > 0) parts.push(`start: ${rule.start}`);
  if (rule.end !== null) parts.push(`end: ${rule.end}`);
  parts.push(`stroke: ${typstStroke(rule.width, rule.color)}`);
  return `  table.${horizontal ? "hline" : "vline"}(${parts.join(", ")}),`;
}

/** Generates the managed Typst `table` call for a project table. */
export function generateTableTypst(table: StoredTable): string {
  const fallback = strokeFallback(table);
  const strokes = effectiveStrokes(table);
  const strokeGroups = groupCells(table, slot => {
    const record = strokes.get(slotKey(slot));
    if (!record) return null;
    const overrides = cellOverrides(record, fallback);
    return overrideKey(overrides) === "" ? null : overrides;
  }, overrideKey);
  const alignGroups = groupCells(table, (_slot, cell) => alignmentValue(cell), value => value);
  const hasTracks = table.columnSizes.some(size => size !== "");
  const hasRowTracks = table.rowSizes.some(size => size !== "");
  const lines: string[] = [
    "#table(",
    hasTracks
      ? `  columns: (${table.columnSizes.map(size => size || "auto").join(", ")}),`
      : `  columns: ${table.columns},`,
  ];
  if (hasRowTracks) {
    lines.push(`  rows: (${table.rowSizes.map(size => size || "auto").join(", ")}),`);
  }
  if (table.gutter > 0) lines.push(`  gutter: ${formatPoints(table.gutter)}pt,`);
  lines.push(strokeArgument(table, strokeGroups));
  const fill = fillArgument(table);
  if (fill) lines.push(fill);
  const inset = insetArgument(table);
  if (inset) lines.push(inset);
  if (alignGroups.length > 0) lines.push(alignArgument(table, alignGroups));
  const headerCount = headerRowCountFor(table);
  const lastRow = table.rows.length - 1;
  const footerIndex = table.footerRow && lastRow >= headerCount ? lastRow : -1;
  const rowSource = (row: StoredTableCell[]): string | null => {
    // The first column is styled in the builder; it is not a `table.header`
    // section (the docs say that is unsuitable for header columns and it breaks
    // row layout when repeated).
    const cells = row.filter(cell => !cell.covered).map(cellSource);
    return cells.length === 0 ? null : cells.join(", ");
  };
  if (headerCount > 0) {
    const bodies = table.rows
      .slice(0, headerCount)
      .map(row => rowSource(row))
      .filter((body): body is string => body !== null);
    if (bodies.length > 0) {
      const repeat = table.headerRepeat === false ? "repeat: false, " : "";
      lines.push(`  table.header(${repeat}${bodies.join(", ")}),`);
    }
  }
  const ruleLines = [...styleRules(table), ...table.rules].map(ruleSource);
  for (let rowIndex = headerCount; rowIndex < table.rows.length; rowIndex += 1) {
    const body = rowSource(table.rows[rowIndex]);
    if (body === null) continue;
    if (rowIndex === footerIndex) {
      // Explicit rules cannot follow a footer, so emit them just before it.
      lines.push(...ruleLines);
      const repeat = table.footerRepeat === false ? "repeat: false, " : "";
      lines.push(`  table.footer(${repeat}${body}),`);
    } else {
      lines.push(`  ${body},`);
    }
  }
  if (footerIndex < 0) lines.push(...ruleLines);
  lines.push(")");
  const code = lines.join("\n");
  const caption = (table.caption ?? "").trim();
  const alt = (table.alt ?? "").trim();
  const label = (table.label ?? "").trim();
  if (!caption && !alt && !label) return code;
  // A caption, alt, or label requires a figure; `kind` auto-detects as table and
  // the figure stays in flow (no `placement`, which would float it to a page
  // edge). The caption's side comes from `figure.caption(position: ...)`.
  const body = code
    .split("\n")
    .map(line => `  ${line}`)
    .join("\n")
    .replace(/^ {2}#table\(/u, "  table(");
  const figureLines = ["#figure(", `${body},`];
  if (alt) figureLines.push(`  alt: ${typstString(alt)},`);
  if (caption) {
    // Captions are left-justified unless centered; right alignment is not
    // offered because it is not a conventional caption style.
    const captionBody = table.captionAlign === "center"
      ? `align(center)[${escapeTableText(caption)}]`
      : `[${escapeTableText(caption)}]`;
    const captionArg = table.captionPosition === "top"
      ? `figure.caption(position: top, ${captionBody})`
      : captionBody;
    figureLines.push(`  caption: ${captionArg},`);
  }
  figureLines.push(")");
  const figure = label ? `${figureLines.join("\n")} <${label}>` : figureLines.join("\n");
  if (!table.breakable) return figure;
  // Figures are unbreakable by default; this scoped show rule lets long
  // captioned tables flow across pages.
  const indented = figure.split("\n").map(line => `  ${line}`).join("\n");
  return `#[\n  #show figure: set block(breakable: true)\n${indented}\n]`;
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
