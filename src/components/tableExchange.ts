import type { StoredTable } from "../workspace/workspaceStateStore";
import { normalizeWorkspaceMetadata } from "../workspace/workspaceStateStore";
import { extractTableCells } from "./tableParse";
import { tableFromRows } from "./tableImport";
import { generateTableTypst } from "./tableTypst";

export const TABLE_EXPORT_MARKER = "//@typsastra-table-export";
export const TABLE_MODEL_MARKER = "//@typsastra-table-model";
const EXPORT_VERSION = "v1";

/** A portable `.typ` file: the generated code plus a model sidecar comment. */
export function exportTableTypst(table: StoredTable): string {
  return [
    `${TABLE_EXPORT_MARKER} ${EXPORT_VERSION}`,
    `${TABLE_MODEL_MARKER} ${JSON.stringify(table)}`,
    generateTableTypst(table),
    "",
  ].join("\n");
}

export type TableImportResult =
  | { ok: true; table: StoredTable; source: "tool" | "handwritten" }
  | { ok: false; error: string };

/**
 * Imports a `.typ` table. Files exported by the tool carry a model sidecar and
 * round-trip losslessly. Anything else is parsed strictly and only accepted if
 * it can be reproduced exactly.
 */
export function importTableTypst(text: string): TableImportResult {
  const modelLine = text.split(/\r?\n/u).find(line => line.trimStart().startsWith(TABLE_MODEL_MARKER));
  if (modelLine) {
    const json = modelLine
      .slice(modelLine.indexOf(TABLE_MODEL_MARKER) + TABLE_MODEL_MARKER.length)
      .trim();
    try {
      const parsed = JSON.parse(json) as unknown;
      const metadata = normalizeWorkspaceMetadata(
        { project: { tables: [parsed] }, workspace: null },
        () => "imported",
      );
      const table = metadata.project.tables[0];
      if (table) return { ok: true, table, source: "tool" };
    } catch {
      // Fall through to the strict parser below.
    }
  }
  return importHandwrittenTable(text);
}

function importHandwrittenTable(text: string): TableImportResult {
  if (/\b(?:colspan|rowspan)\s*:/u.test(text)) {
    return { ok: false, error: "Merged cells can't be reproduced from code. Export from the Table tool instead." };
  }
  if (/\bcsv\s*\(/u.test(text)) {
    return { ok: false, error: "Data-linked tables can't be imported. Export from the Table tool instead." };
  }
  const columnsMatch = /\bcolumns\s*:\s*(\d+)\b/u.exec(text);
  if (!columnsMatch) {
    return { ok: false, error: "Add an integer columns: count (or export from the Table tool) to import." };
  }
  const columns = Math.max(1, Math.min(Number(columnsMatch[1]), 100));
  const cells = extractTableCells(text);
  if (!cells) {
    return { ok: false, error: "This file isn't a table the tool can reproduce." };
  }
  const rows: string[][] = [];
  for (let index = 0; index < cells.length; index += columns) {
    rows.push(cells.slice(index, index + columns));
  }
  if (rows.length === 0) return { ok: false, error: "The table has no cells." };
  if (rows.some(row => row.length !== columns)) {
    return { ok: false, error: "The table cells don't line up with its columns: count." };
  }
  const header = /\btable\.header\s*\(/u.test(text);
  const table = tableFromRows(rows, "imported", "Imported table");
  table.headerRow = header;
  table.headerRowCount = header ? 1 : 0;
  table.rows.forEach(row => row.forEach(cell => { cell.raw = true; }));
  // Strict sanity check: the rebuilt table must regenerate the same cells.
  const regenerated = extractTableCells(generateTableTypst(table));
  const reproducible = regenerated !== null
    && regenerated.length === cells.length
    && regenerated.every((cell, index) => cell === cells[index]);
  if (!reproducible) {
    return { ok: false, error: "The table couldn't be reproduced from its code. Export from the Table tool instead." };
  }
  return { ok: true, table, source: "handwritten" };
}
