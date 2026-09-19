import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { createAppIcon } from "../ui/icons";
import type {
  StoredTable,
  StoredTableCell,
  StoredTableCellBorders,
  StoredTableAlignment,
  StoredTableStroke,
} from "../workspace/workspaceStateStore";
import { generateTableTypst } from "./tableTypst";

export type TableToolDependencies = {
  /** Writes the current tables back to the portable project config. */
  persist(tables: readonly StoredTable[]): void;
  /** Called after any change so managed directive blocks can be refreshed. */
  tablesChanged?(tables: readonly StoredTable[]): void;
  /** Compiles the generated Typst into SVG pages with the active toolchain. */
  compilePreview?(table: StoredTable): Promise<string[]>;
  /** Shows compiled SVG pages in the preview pane. */
  showPreview?(pages: readonly string[]): void;
  /** Shows a plain-text status in the preview pane. */
  showPreviewMessage?(message: string): void;
  log?(kind: "info" | "warning", message: string): void;
};

export type TableSummary = {
  id: string;
  name: string;
};

type Slot = { row: number; column: number };
type SelectionRange = { minRow: number; maxRow: number; minColumn: number; maxColumn: number };

const MAX_COLUMNS = 32;
const MAX_ROWS = 500;
const BORDER_SIDES: Array<keyof StoredTableCellBorders> = ["top", "right", "bottom", "left"];
const OPPOSITE_SIDE: Record<keyof StoredTableCellBorders, keyof StoredTableCellBorders> = {
  top: "bottom",
  right: "left",
  bottom: "top",
  left: "right",
};

function cloneTable(table: StoredTable): StoredTable {
  return {
    ...table,
    rows: table.rows.map(row => row.map(cell => ({
      ...cell,
      borders: cell.borders ? { ...cell.borders } : null,
    }))),
  };
}

function emptyCell(): StoredTableCell {
  return { text: "", align: null, colspan: 1, rowspan: 1, covered: false, borders: null };
}

function emptyRow(columns: number): StoredTableCell[] {
  return Array.from({ length: columns }, emptyCell);
}

/** Returns the origin slot of the cell covering a grid slot, if any. */
export function tableCellOrigin(table: StoredTable, row: number, column: number): Slot | null {
  if (row < 0 || column < 0 || row >= table.rows.length || column >= table.columns) return null;
  for (let r = 0; r < table.rows.length; r += 1) {
    for (let c = 0; c < table.columns; c += 1) {
      const cell = table.rows[r][c];
      if (cell.covered) continue;
      if (row >= r && row < r + cell.rowspan && column >= c && column < c + cell.colspan) {
        return { row: r, column: c };
      }
    }
  }
  return null;
}

function tableHasSpans(table: StoredTable): boolean {
  return table.rows.some(row => row.some(cell => !cell.covered && (cell.colspan > 1 || cell.rowspan > 1)));
}

function effectiveBorder(table: StoredTable, cell: StoredTableCell, side: keyof StoredTableCellBorders): boolean {
  const override = cell.borders?.[side];
  return typeof override === "boolean" ? override : table.stroke === "solid";
}

/** Owns the project table list, the grid editor, and generated Typst code. */
export class TableToolController {
  private tables: StoredTable[] = [];
  private selectedId: string | null = null;
  private selectionAnchor: Slot | null = null;
  private selectionFocus: Slot | null = null;
  private borderMode = false;
  private readonly cellInputs = new Map<string, HTMLInputElement>();
  private persistTimer: number | null = null;
  private previewTimer: number | null = null;
  private previewGeneration = 0;
  private previewCompiling = false;
  private previewDirty = false;

  public constructor(
    private readonly list: HTMLElement,
    private readonly inspector: HTMLElement,
    private readonly deps: TableToolDependencies,
  ) {
    document.getElementById("tables-new-button")?.addEventListener("click", () => this.createTable());
  }

  public setWorkspace(tables: readonly StoredTable[]): void {
    this.tables = tables.map(cloneTable);
    if (!this.tables.some(table => table.id === this.selectedId)) {
      this.selectedId = this.tables[0]?.id ?? null;
    }
    this.resetSelection();
    this.renderSidebar();
    this.renderInspector();
  }

  public show(): void {
    this.renderSidebar();
    this.renderInspector();
    this.schedulePreview();
  }

  public hide(): void {
    this.flushPersist();
    if (this.previewTimer !== null) {
      window.clearTimeout(this.previewTimer);
      this.previewTimer = null;
    }
    this.previewGeneration += 1;
  }

  /** Table identities for the `//@table:` completion source. */
  public tableNames(): TableSummary[] {
    return this.tables.map(table => ({ id: table.id, name: table.name }));
  }

  public createTable(): void {
    const id = this.nextTableId();
    const table: StoredTable = {
      id,
      name: `Table ${this.tables.length + 1}`,
      columns: 2,
      headerRow: true,
      headerColumn: false,
      stroke: "solid",
      rows: [emptyRow(2), emptyRow(2)],
    };
    this.tables.push(table);
    this.selectedId = id;
    this.selectionAnchor = { row: 0, column: 0 };
    this.selectionFocus = { row: 0, column: 0 };
    this.emitChange();
    this.renderSidebar();
    this.renderInspector();
  }

  public selectTable(id: string): void {
    if (!this.tables.some(table => table.id === id)) return;
    this.selectedId = id;
    this.resetSelection();
    this.renderSidebar();
    this.renderInspector();
    this.schedulePreview();
  }

  private resetSelection(): void {
    this.selectionAnchor = null;
    this.selectionFocus = null;
    this.borderMode = false;
  }

  private nextTableId(): string {
    let index = this.tables.length + 1;
    while (this.tables.some(table => table.id === `table_${index}`)) index += 1;
    return `table_${index}`;
  }

  private selected(): StoredTable | null {
    return this.tables.find(table => table.id === this.selectedId) ?? null;
  }

  private emitChange(): void {
    this.deps.tablesChanged?.(this.tables);
    this.schedulePersist();
    this.schedulePreview();
  }

  private schedulePersist(): void {
    if (this.persistTimer !== null) window.clearTimeout(this.persistTimer);
    this.persistTimer = window.setTimeout(() => {
      this.persistTimer = null;
      this.deps.persist(this.tables);
    }, 350);
  }

  private flushPersist(): void {
    if (this.persistTimer === null) return;
    window.clearTimeout(this.persistTimer);
    this.persistTimer = null;
    this.deps.persist(this.tables);
  }

  private schedulePreview(): void {
    if (!this.deps.compilePreview) return;
    if (this.previewTimer !== null) window.clearTimeout(this.previewTimer);
    this.previewTimer = window.setTimeout(() => {
      this.previewTimer = null;
      void this.refreshPreview();
    }, 500);
  }

  private async refreshPreview(): Promise<void> {
    const compile = this.deps.compilePreview;
    const table = this.selected();
    if (!compile || !table) {
      this.deps.showPreviewMessage?.("Create or select a table to preview it.");
      return;
    }
    if (this.previewCompiling) {
      this.previewDirty = true;
      return;
    }
    this.previewCompiling = true;
    const generation = ++this.previewGeneration;
    const snapshot = cloneTable(table);
    try {
      const pages = await compile(snapshot);
      if (generation === this.previewGeneration) {
        this.deps.showPreview?.(pages);
      }
    } catch (error) {
      if (generation === this.previewGeneration) {
        this.deps.showPreviewMessage?.(`Table preview failed: ${String(error)}`);
      }
    } finally {
      this.previewCompiling = false;
      if (this.previewDirty) {
        this.previewDirty = false;
        this.schedulePreview();
      }
    }
  }

  private renderSidebar(): void {
    this.list.replaceChildren();
    if (this.tables.length === 0) {
      const empty = document.createElement("div");
      empty.className = "image-tool-empty";
      empty.textContent = "No tables yet. Create one to generate Typst code.";
      this.list.appendChild(empty);
      return;
    }
    for (const table of this.tables) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "tree-item table-tool-list-item";
      if (table.id === this.selectedId) item.classList.add("selected");
      const icon = document.createElement("span");
      icon.className = "tree-icon";
      icon.appendChild(createAppIcon("table", { size: 16 }));
      const text = document.createElement("span");
      text.className = "tree-text";
      text.textContent = table.name;
      const meta = document.createElement("span");
      meta.className = "table-tool-list-meta";
      meta.textContent = `${table.rows.length}×${table.columns}`;
      item.append(icon, text, meta);
      item.addEventListener("click", () => this.selectTable(table.id));
      this.list.appendChild(item);
    }
  }

  private selectionRange(): SelectionRange | null {
    if (!this.selectionAnchor || !this.selectionFocus) return null;
    return {
      minRow: Math.min(this.selectionAnchor.row, this.selectionFocus.row),
      maxRow: Math.max(this.selectionAnchor.row, this.selectionFocus.row),
      minColumn: Math.min(this.selectionAnchor.column, this.selectionFocus.column),
      maxColumn: Math.max(this.selectionAnchor.column, this.selectionFocus.column),
    };
  }

  private renderInspector(): void {
    const table = this.selected();
    if (!table) {
      this.inspector.innerHTML =
        `<div class="preview-disabled-placeholder image-tool-inspector-empty"><div class="guardrail-placeholder-content">` +
        `<div class="preview-disabled-title preview-accent-title">Table Tool</div>` +
        `<div class="preview-disabled-msg">Create a table to generate Typst code.</div></div></div>`;
      return;
    }
    this.inspector.innerHTML =
      `<div class="image-tool-inspector-header"><div><h2 data-field="table-heading"></h2><div class="image-tool-path" data-field="table-id"></div></div><span class="image-tool-status current-document">Table</span></div>` +
      `<section class="image-tool-section"><h3>Structure</h3>` +
      `<label class="table-tool-name">Name <input data-field="table-name" type="text" maxlength="80" /></label>` +
      `<div class="table-tool-toolbar">` +
      `<button type="button" data-action="merge">Merge</button>` +
      `<button type="button" data-action="split">Split</button>` +
      `<button type="button" data-action="move-row-up" title="Move row up">Row ↑</button>` +
      `<button type="button" data-action="move-row-down" title="Move row down">Row ↓</button>` +
      `<button type="button" data-action="move-column-left" title="Move column left">Col ←</button>` +
      `<button type="button" data-action="move-column-right" title="Move column right">Col →</button>` +
      `<button type="button" data-action="add-row">Add row</button>` +
      `<button type="button" data-action="remove-row">Remove row</button>` +
      `<button type="button" data-action="add-column">Add column</button>` +
      `<button type="button" data-action="remove-column">Remove column</button>` +
      `<button type="button" data-action="borders">Borders</button>` +
      `<button type="button" data-action="delete">Delete table</button>` +
      `</div>` +
      `<div class="table-tool-options">` +
      `<label class="image-tool-lock"><input data-field="header-row" type="checkbox" /> Header row</label>` +
      `<label class="image-tool-lock"><input data-field="header-column" type="checkbox" /> Header column</label>` +
      `<label>Align selection <select data-field="cell-align"><option value="">Default</option><option value="left">Left</option><option value="center">Center</option><option value="right">Right</option></select></label>` +
      `<label>Table stroke <select data-field="table-stroke"><option value="solid">Solid</option><option value="none">None</option></select></label>` +
      `</div>` +
      `<div class="table-tool-selection" data-field="selection-summary" aria-live="polite"></div>` +
      `<div class="table-tool-grid-host"></div></section>` +
      `<section class="image-tool-section"><h3>Generated Typst</h3>` +
      `<div class="image-tool-actions"><button type="button" data-action="copy" class="primary">Copy code</button></div>` +
      `<pre class="table-tool-code" data-field="code"></pre></section>`;

    const heading = this.inspector.querySelector<HTMLElement>('[data-field="table-heading"]')!;
    heading.textContent = table.name;
    this.inspector.querySelector<HTMLElement>('[data-field="table-id"]')!.textContent = table.id;

    const name = this.inspector.querySelector<HTMLInputElement>('[data-field="table-name"]')!;
    name.value = table.name;
    name.addEventListener("input", () => {
      table.name = name.value.slice(0, 80);
      heading.textContent = table.name;
      this.renderSidebar();
      this.emitChange();
    });

    const headerRow = this.inspector.querySelector<HTMLInputElement>('[data-field="header-row"]')!;
    headerRow.checked = table.headerRow;
    headerRow.addEventListener("change", () => {
      table.headerRow = headerRow.checked;
      this.renderGrid(table);
      this.emitChange();
    });
    const headerColumn = this.inspector.querySelector<HTMLInputElement>('[data-field="header-column"]')!;
    headerColumn.checked = table.headerColumn;
    headerColumn.addEventListener("change", () => {
      table.headerColumn = headerColumn.checked;
      this.renderGrid(table);
      this.emitChange();
    });

    const align = this.inspector.querySelector<HTMLSelectElement>('[data-field="cell-align"]')!;
    align.addEventListener("change", () => this.applyAlignment(table, (align.value || null) as StoredTableAlignment | null));

    const stroke = this.inspector.querySelector<HTMLSelectElement>('[data-field="table-stroke"]')!;
    stroke.value = table.stroke;
    stroke.addEventListener("change", () => {
      table.stroke = (stroke.value === "none" ? "none" : "solid") as StoredTableStroke;
      this.renderGrid(table);
      this.emitChange();
    });

    const on = (action: string, handler: () => void) => {
      this.inspector.querySelector<HTMLButtonElement>(`[data-action="${action}"]`)?.addEventListener("click", handler);
    };
    on("merge", () => this.mergeSelection(table));
    on("split", () => this.splitSelection(table));
    on("move-row-up", () => this.moveRow(table, -1));
    on("move-row-down", () => this.moveRow(table, 1));
    on("move-column-left", () => this.moveColumn(table, -1));
    on("move-column-right", () => this.moveColumn(table, 1));
    on("borders", () => {
      this.borderMode = !this.borderMode;
      this.renderGrid(table);
      this.syncSelectionSummary();
    });
    on("add-row", () => {
      if (table.rows.length >= MAX_ROWS) return;
      table.rows.push(emptyRow(table.columns));
      this.renderInspector();
      this.emitChange();
    });
    on("remove-row", () => {
      if (table.rows.length <= 1) return;
      if (tableHasSpans(table)) {
        this.deps.showPreviewMessage?.("Remove rows after splitting merged cells.");
        return;
      }
      table.rows.pop();
      this.resetSelection();
      this.renderInspector();
      this.emitChange();
    });
    on("add-column", () => {
      if (table.columns >= MAX_COLUMNS) return;
      table.columns += 1;
      for (const row of table.rows) row.push(emptyCell());
      this.renderInspector();
      this.emitChange();
    });
    on("remove-column", () => {
      if (table.columns <= 1) return;
      if (tableHasSpans(table)) {
        this.deps.showPreviewMessage?.("Remove columns after splitting merged cells.");
        return;
      }
      table.columns -= 1;
      for (const row of table.rows) row.length = table.columns;
      this.resetSelection();
      this.renderInspector();
      this.emitChange();
    });
    on("delete", () => {
      const index = this.tables.findIndex(candidate => candidate.id === table.id);
      if (index === -1) return;
      this.tables.splice(index, 1);
      this.selectedId = this.tables[Math.min(index, this.tables.length - 1)]?.id ?? null;
      this.resetSelection();
      this.renderSidebar();
      this.renderInspector();
      this.emitChange();
    });

    const copy = this.inspector.querySelector<HTMLButtonElement>('[data-action="copy"]')!;
    copy.addEventListener("click", () => {
      void writeText(generateTableTypst(table))
        .then(() => {
          copy.textContent = "Copied";
          window.setTimeout(() => { copy.textContent = "Copy code"; }, 1200);
        })
        .catch(error => this.deps.log?.("warning", `Could not copy table code: ${String(error)}`));
    });

    this.renderGrid(table);
    this.syncAlignSelect(align, table);
    this.updateCode(table);
  }

  private renderGrid(table: StoredTable): void {
    const host = this.inspector.querySelector<HTMLElement>(".table-tool-grid-host");
    if (!host) return;
    this.cellInputs.clear();
    const grid = document.createElement("div");
    grid.className = "table-tool-grid";
    grid.classList.toggle("borders-mode", this.borderMode);
    grid.style.setProperty("--table-columns", String(table.columns));
    const range = this.selectionRange();
    table.rows.forEach((row, rowIndex) => {
      row.forEach((cell, columnIndex) => {
        if (cell.covered) return;
        const wrap = document.createElement("div");
        wrap.className = "table-tool-cell-wrap";
        wrap.style.gridRow = `${rowIndex + 1} / span ${cell.rowspan}`;
        wrap.style.gridColumn = `${columnIndex + 1} / span ${cell.colspan}`;
        if (table.headerRow && rowIndex === 0) wrap.classList.add("is-header-row");
        if (table.headerColumn && columnIndex === 0) wrap.classList.add("is-header-column");
        if (range
          && rowIndex >= range.minRow && rowIndex <= range.maxRow
          && columnIndex >= range.minColumn && columnIndex <= range.maxColumn) {
          wrap.classList.add("selected");
        }
        if (this.borderMode) wrap.classList.add("borders-visible");

        const input = document.createElement("input");
        input.type = "text";
        input.className = "table-tool-cell";
        input.dataset.row = String(rowIndex);
        input.dataset.column = String(columnIndex);
        if (cell.align) input.classList.add(`align-${cell.align}`);
        input.value = cell.text;
        input.addEventListener("input", () => {
          cell.text = input.value;
          this.updateCode(table);
          this.emitChange();
        });
        input.addEventListener("mousedown", event => {
          if (event.shiftKey && this.selectionAnchor) {
            this.selectionFocus = { row: rowIndex, column: columnIndex };
          } else {
            this.selectionAnchor = { row: rowIndex, column: columnIndex };
            this.selectionFocus = { row: rowIndex, column: columnIndex };
          }
          this.syncSelectionHighlight();
          const align = this.inspector.querySelector<HTMLSelectElement>('[data-field="cell-align"]');
          if (align) this.syncAlignSelect(align, table);
        });
        input.addEventListener("keydown", event => this.handleCellKeydown(event, table, rowIndex, columnIndex, cell));
        wrap.appendChild(input);
        if (this.borderMode) {
          for (const side of BORDER_SIDES) {
            const edge = document.createElement("span");
            edge.className = `table-tool-edge table-tool-edge-${side}`;
            if (effectiveBorder(table, cell, side)) edge.classList.add("on");
            edge.title = `${side} border`;
            edge.addEventListener("pointerdown", event => {
              event.preventDefault();
              event.stopPropagation();
              this.toggleBorder(table, { row: rowIndex, column: columnIndex }, side);
            });
            wrap.appendChild(edge);
          }
        }
        this.cellInputs.set(`${rowIndex}:${columnIndex}`, input);
        grid.appendChild(wrap);
      });
    });
    host.replaceChildren(grid);
    this.syncSelectionSummary();
  }

  private handleCellKeydown(
    event: KeyboardEvent,
    table: StoredTable,
    row: number,
    column: number,
    cell: StoredTableCell,
  ): void {
    const moves: Record<string, Slot> = {
      ArrowLeft: { row, column: column - 1 },
      ArrowRight: { row, column: column + cell.colspan },
      ArrowUp: { row: row - 1, column },
      ArrowDown: { row: row + cell.rowspan, column },
    };
    const target = moves[event.key];
    if (!target) return;
    const origin = tableCellOrigin(table, target.row, target.column);
    if (!origin) return;
    event.preventDefault();
    if (event.shiftKey && this.selectionAnchor) {
      this.selectionFocus = origin;
    } else {
      this.selectionAnchor = origin;
      this.selectionFocus = origin;
    }
    this.syncSelectionHighlight();
    const align = this.inspector.querySelector<HTMLSelectElement>('[data-field="cell-align"]');
    if (align) this.syncAlignSelect(align, table);
    this.cellInputs.get(`${origin.row}:${origin.column}`)?.focus();
    this.syncSelectionSummary();
  }

  private syncSelectionHighlight(): void {
    const table = this.selected();
    if (!table) return;
    const range = this.selectionRange();
    for (const [key, input] of this.cellInputs) {
      const wrap = input.parentElement;
      if (!wrap) continue;
      const [row, column] = key.split(":").map(Number);
      const selected = range
        && row >= range.minRow && row <= range.maxRow
        && column >= range.minColumn && column <= range.maxColumn;
      wrap.classList.toggle("selected", Boolean(selected));
    }
  }

  private syncSelectionSummary(): void {
    const summary = this.inspector.querySelector<HTMLElement>('[data-field="selection-summary"]');
    if (!summary) return;
    const range = this.selectionRange();
    if (!range) {
      summary.textContent = "Click a cell to start. Shift+click or Shift+arrows select a range.";
      return;
    }
    const rows = range.maxRow - range.minRow + 1;
    const columns = range.maxColumn - range.minColumn + 1;
    summary.textContent = rows === 1 && columns === 1
      ? `Cell R${range.minRow + 1}C${range.minColumn + 1}. Shift+click or Shift+arrows select a range.`
      : `Selected ${rows} × ${columns} cells.`;
  }

  private applyAlignment(table: StoredTable, align: StoredTableAlignment | null): void {
    const range = this.selectionRange();
    if (!range) return;
    const visited = new Set<string>();
    for (let row = range.minRow; row <= range.maxRow; row += 1) {
      for (let column = range.minColumn; column <= range.maxColumn; column += 1) {
        const origin = tableCellOrigin(table, row, column);
        if (!origin) continue;
        const key = `${origin.row}:${origin.column}`;
        if (visited.has(key)) continue;
        visited.add(key);
        const cell = table.rows[origin.row][origin.column];
        cell.align = align;
        const input = this.cellInputs.get(key);
        if (input) {
          input.classList.remove("align-left", "align-center", "align-right");
          if (align) input.classList.add(`align-${align}`);
        }
      }
    }
    this.emitChange();
  }

  private mergeSelection(table: StoredTable): void {
    const range = this.selectionRange();
    if (!range) return;
    if (range.minRow === range.maxRow && range.minColumn === range.maxColumn) {
      this.deps.log?.("info", "Select more than one cell to merge.");
      return;
    }
    for (let row = range.minRow; row <= range.maxRow; row += 1) {
      for (let column = range.minColumn; column <= range.maxColumn; column += 1) {
        const cell = table.rows[row]?.[column];
        if (!cell || cell.covered || cell.colspan !== 1 || cell.rowspan !== 1) {
          this.deps.showPreviewMessage?.("Merging requires a range of single, unmerged cells.");
          return;
        }
      }
    }
    const originCell = table.rows[range.minRow][range.minColumn];
    originCell.colspan = range.maxColumn - range.minColumn + 1;
    originCell.rowspan = range.maxRow - range.minRow + 1;
    originCell.borders = null;
    for (let row = range.minRow; row <= range.maxRow; row += 1) {
      for (let column = range.minColumn; column <= range.maxColumn; column += 1) {
        if (row === range.minRow && column === range.minColumn) continue;
        table.rows[row][column] = { ...emptyCell(), covered: true };
      }
    }
    this.selectionAnchor = { row: range.minRow, column: range.minColumn };
    this.selectionFocus = { ...this.selectionAnchor };
    this.renderInspector();
    this.emitChange();
  }

  private splitSelection(table: StoredTable): void {
    const range = this.selectionRange();
    if (!range) return;
    let split = false;
    for (let row = range.minRow; row <= range.maxRow; row += 1) {
      for (let column = range.minColumn; column <= range.maxColumn; column += 1) {
        const cell = table.rows[row]?.[column];
        if (!cell || cell.covered || (cell.colspan === 1 && cell.rowspan === 1)) continue;
        const { colspan, rowspan } = cell;
        cell.colspan = 1;
        cell.rowspan = 1;
        for (let r = row; r < row + rowspan; r += 1) {
          for (let c = column; c < column + colspan; c += 1) {
            if (r === row && c === column) continue;
            table.rows[r][c] = emptyCell();
          }
        }
        split = true;
      }
    }
    if (!split) {
      this.deps.showPreviewMessage?.("Select a merged cell to split it.");
      return;
    }
    this.renderInspector();
    this.emitChange();
  }

  private moveRow(table: StoredTable, direction: -1 | 1): void {
    if (tableHasSpans(table)) {
      this.deps.showPreviewMessage?.("Reorder rows after splitting merged cells.");
      return;
    }
    const range = this.selectionRange();
    if (!range) return;
    const target = range.minRow + direction;
    if (target < 0 || target >= table.rows.length) return;
    [table.rows[range.minRow], table.rows[target]] = [table.rows[target], table.rows[range.minRow]];
    this.selectionAnchor = { row: target, column: this.selectionAnchor?.column ?? 0 };
    this.selectionFocus = { ...this.selectionAnchor };
    this.renderInspector();
    this.emitChange();
  }

  private moveColumn(table: StoredTable, direction: -1 | 1): void {
    if (tableHasSpans(table)) {
      this.deps.showPreviewMessage?.("Reorder columns after splitting merged cells.");
      return;
    }
    const range = this.selectionRange();
    if (!range) return;
    const column = range.minColumn;
    const target = column + direction;
    if (target < 0 || target >= table.columns) return;
    for (const row of table.rows) {
      [row[column], row[target]] = [row[target], row[column]];
    }
    this.selectionAnchor = { row: this.selectionAnchor?.row ?? 0, column: target };
    this.selectionFocus = { ...this.selectionAnchor };
    this.renderInspector();
    this.emitChange();
  }

  private toggleBorder(table: StoredTable, origin: Slot, side: keyof StoredTableCellBorders): void {
    const cell = table.rows[origin.row][origin.column];
    const next = !effectiveBorder(table, cell, side);
    const apply = (target: StoredTableCell, targetSide: keyof StoredTableCellBorders, value: boolean) => {
      if (!target.borders) {
        const base = table.stroke === "solid";
        target.borders = { top: base, right: base, bottom: base, left: base };
      }
      target.borders[targetSide] = value;
    };
    apply(cell, side, next);
    const neighborSlot: Record<keyof StoredTableCellBorders, Slot> = {
      top: { row: origin.row - 1, column: origin.column },
      bottom: { row: origin.row + cell.rowspan, column: origin.column },
      left: { row: origin.row, column: origin.column - 1 },
      right: { row: origin.row, column: origin.column + cell.colspan },
    };
    const neighbor = tableCellOrigin(table, neighborSlot[side].row, neighborSlot[side].column);
    if (neighbor && (neighbor.row !== origin.row || neighbor.column !== origin.column)) {
      apply(table.rows[neighbor.row][neighbor.column], OPPOSITE_SIDE[side], next);
    }
    this.renderGrid(table);
    this.syncSelectionHighlight();
    this.emitChange();
  }

  private syncAlignSelect(select: HTMLSelectElement, table: StoredTable): void {
    const focus = this.selectionFocus;
    const cell = focus ? table.rows[focus.row]?.[focus.column] : null;
    select.value = cell?.align ?? "";
    select.disabled = !focus;
  }

  private updateCode(table: StoredTable): void {
    const code = this.inspector.querySelector<HTMLElement>('[data-field="code"]');
    if (code) code.textContent = generateTableTypst(table);
  }
}
