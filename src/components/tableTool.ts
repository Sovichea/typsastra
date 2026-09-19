import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { createAppIcon } from "../ui/icons";
import type {
  StoredTable,
  StoredTableBorderSide,
  StoredTableCell,
  StoredTableCellBorders,
  StoredTableAlignment,
  StoredTableStyle,
  StoredTableVerticalAlignment,
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
  return {
    text: "",
    align: null,
    verticalAlign: null,
    colspan: 1,
    rowspan: 1,
    covered: false,
    borders: null,
  };
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

function effectiveSide(
  table: StoredTable,
  cell: StoredTableCell,
  side: keyof StoredTableCellBorders,
): { enabled: boolean; width: number; color: string } {
  const override: StoredTableBorderSide = cell.borders?.[side] ?? null;
  if (override) return { enabled: override.enabled, width: override.width, color: override.color };
  return { enabled: table.stroke === "solid", width: table.strokeWidth, color: table.strokeColor };
}

/** Owns the project table list, the grid editor, and generated Typst code. */
export class TableToolController {
  private tables: StoredTable[] = [];
  private selectedId: string | null = null;
  private selectionAnchor: Slot | null = null;
  private selectionFocus: Slot | null = null;
  private borderMode = false;
  private borderWidth = 0.5;
  private borderColor = "#000000";
  private draggingSelection = false;
  private editingCell: Slot | null = null;
  private editStartValue = "";
  private activeMenu: HTMLElement | null = null;
  private activeMenuAnchor: HTMLButtonElement | null = null;
  private menuBuild: ((menu: HTMLElement) => void) | null = null;
  private menuCleanup: (() => void) | null = null;
  private readonly cellInputs = new Map<string, HTMLInputElement>();
  private historyPast: StoredTable[] = [];
  private historyFuture: StoredTable[] = [];
  private pendingSnapshot: StoredTable | null = null;
  private lastState: StoredTable | null = null;
  private historyTimer: number | null = null;
  private applyingHistory = false;
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
    window.addEventListener("pointerup", () => { this.draggingSelection = false; });
    this.inspector.addEventListener("keydown", event => {
      if (!(event.ctrlKey || event.metaKey)) return;
      if (event.code === "KeyZ" && !event.shiftKey) {
        event.preventDefault();
        this.undo();
      } else if (event.code === "KeyY" || (event.code === "KeyZ" && event.shiftKey)) {
        event.preventDefault();
        this.redo();
      }
    }, true);
  }

  public setWorkspace(tables: readonly StoredTable[]): void {
    this.tables = tables.map(cloneTable);
    if (!this.tables.some(table => table.id === this.selectedId)) {
      this.selectedId = this.tables[0]?.id ?? null;
    }
    this.resetSelection();
    this.resetHistory(this.selected());
    this.renderSidebar();
    this.renderInspector();
  }

  public show(): void {
    this.renderSidebar();
    this.renderInspector();
    this.schedulePreview();
  }

  public hide(): void {
    this.closeTableMenu();
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
      strokeWidth: 0.5,
      strokeColor: "#000000",
      style: "default",
      rows: [emptyRow(2), emptyRow(2)],
    };
    this.tables.push(table);
    this.selectedId = id;
    this.selectionAnchor = { row: 0, column: 0 };
    this.selectionFocus = { row: 0, column: 0 };
    this.resetHistory(table);
    this.emitChange();
    this.renderSidebar();
    this.renderInspector();
  }

  public selectTable(id: string): void {
    if (!this.tables.some(table => table.id === id)) return;
    this.selectedId = id;
    this.resetSelection();
    this.resetHistory(this.selected());
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

  private emitChange(options: { preview?: boolean } = {}): void {
    if (!this.applyingHistory) this.recordHistoryBurst();
    this.notifyChange(options);
  }

  private notifyChange(options: { preview?: boolean } = {}): void {
    this.deps.tablesChanged?.(this.tables);
    this.schedulePersist();
    if (options.preview !== false) this.schedulePreview();
  }

  private recordHistoryBurst(): void {
    const table = this.selected();
    if (!table) return;
    if (this.pendingSnapshot === null && this.lastState) {
      this.pendingSnapshot = cloneTable(this.lastState);
    }
    if (this.historyTimer !== null) window.clearTimeout(this.historyTimer);
    this.historyTimer = window.setTimeout(() => this.commitHistory(), 400);
  }

  private commitHistory(): void {
    if (this.historyTimer !== null) window.clearTimeout(this.historyTimer);
    this.historyTimer = null;
    const table = this.selected();
    if (this.pendingSnapshot && table) {
      this.historyPast.push(this.pendingSnapshot);
      if (this.historyPast.length > 100) this.historyPast.shift();
      this.historyFuture = [];
    }
    this.pendingSnapshot = null;
    if (table) this.lastState = cloneTable(table);
  }

  private resetHistory(table: StoredTable | null): void {
    this.commitHistory();
    this.historyPast = [];
    this.historyFuture = [];
    this.pendingSnapshot = null;
    this.historyTimer = null;
    this.lastState = table ? cloneTable(table) : null;
  }

  private undo(): void {
    this.commitHistory();
    const table = this.selected();
    if (!table || this.historyPast.length === 0) return;
    const previous = this.historyPast.pop()!;
    this.historyFuture.push(cloneTable(table));
    this.applyTableState(previous);
  }

  private redo(): void {
    this.commitHistory();
    const table = this.selected();
    if (!table || this.historyFuture.length === 0) return;
    const next = this.historyFuture.pop()!;
    this.historyPast.push(cloneTable(table));
    this.applyTableState(next);
  }

  private applyTableState(state: StoredTable): void {
    const index = this.tables.findIndex(candidate => candidate.id === state.id);
    if (index === -1) return;
    const restored = cloneTable(state);
    this.tables[index] = restored;
    const anchor = this.selectionAnchor
      && tableCellOrigin(restored, this.selectionAnchor.row, this.selectionAnchor.column)
      ? this.selectionAnchor
      : null;
    const focus = this.selectionFocus
      && tableCellOrigin(restored, this.selectionFocus.row, this.selectionFocus.column)
      ? this.selectionFocus
      : anchor;
    this.selectionAnchor = anchor;
    this.selectionFocus = focus;
    this.applyingHistory = true;
    try {
      this.lastState = cloneTable(restored);
      this.renderGrid(restored);
      this.updateCode(restored);
      this.syncSelectionSummary();
      this.emitChange();
    } finally {
      this.applyingHistory = false;
    }
  }

  private refreshGrid(table: StoredTable): void {
    this.renderGrid(table);
    this.updateCode(table);
    this.syncSelectionSummary();
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
    this.closeTableMenu();
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
      `<div class="table-tool-menubar">` +
      `<button type="button" data-menu="rows">Rows ▾</button>` +
      `<button type="button" data-menu="columns">Columns ▾</button>` +
      `<button type="button" data-menu="cells">Cells ▾</button>` +
      `<button type="button" data-menu="borders">Borders ▾</button>` +
      `<button type="button" data-menu="table">Table ▾</button>` +
      `<label class="table-tool-inline">Style <select data-field="table-style"><option value="default">Default</option><option value="banded-rows">Banded rows</option><option value="banded-columns">Banded columns</option><option value="booktabs">Booktabs</option></select></label>` +
      `<label class="table-tool-inline">Align <select data-field="cell-align"><option value="">Default</option><option value="left">Left</option><option value="center">Center</option><option value="right">Right</option></select></label>` +
      `<label class="table-tool-inline">Vertical <select data-field="cell-vertical-align"><option value="">Default</option><option value="top">Top</option><option value="center">Middle</option><option value="bottom">Bottom</option></select></label>` +
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

    const style = this.inspector.querySelector<HTMLSelectElement>('[data-field="table-style"]')!;
    style.value = table.style;
    style.addEventListener("change", () => this.applyTableStyle(table, style.value as StoredTableStyle));
    const align = this.inspector.querySelector<HTMLSelectElement>('[data-field="cell-align"]')!;
    align.addEventListener("change", () => this.applyAlignment(table, (align.value || null) as StoredTableAlignment | null));
    const verticalAlign = this.inspector.querySelector<HTMLSelectElement>('[data-field="cell-vertical-align"]')!;
    verticalAlign.addEventListener("change", () => this.applyVerticalAlignment(
      table,
      (verticalAlign.value || null) as StoredTableVerticalAlignment | null,
    ));

    const menu = (name: string, build: (menuElement: HTMLElement) => void) => {
      this.inspector.querySelector<HTMLButtonElement>(`[data-menu="${name}"]`)
        ?.addEventListener("click", event => {
          event.stopPropagation();
          this.openTableMenu(event.currentTarget as HTMLButtonElement, build);
        });
    };
    menu("rows", menuElement => {
      this.appendMenuItem(menuElement, "Move row up", () => this.moveRow(table, -1));
      this.appendMenuItem(menuElement, "Move row down", () => this.moveRow(table, 1));
      this.appendMenuSeparator(menuElement);
      this.appendMenuItem(menuElement, "Add row", () => {
        if (table.rows.length >= MAX_ROWS) return;
        table.rows.push(emptyRow(table.columns));
        this.refreshGrid(table);
        this.emitChange();
      });
      this.appendMenuItem(menuElement, "Remove row", () => {
        if (table.rows.length <= 1) return;
        if (tableHasSpans(table)) {
          this.deps.showPreviewMessage?.("Remove rows after splitting merged cells.");
          return;
        }
        table.rows.pop();
        this.resetSelection();
        this.refreshGrid(table);
        this.emitChange();
      });
    });
    menu("columns", menuElement => {
      this.appendMenuItem(menuElement, "Move column left", () => this.moveColumn(table, -1));
      this.appendMenuItem(menuElement, "Move column right", () => this.moveColumn(table, 1));
      this.appendMenuSeparator(menuElement);
      this.appendMenuItem(menuElement, "Add column", () => {
        if (table.columns >= MAX_COLUMNS) return;
        table.columns += 1;
        for (const row of table.rows) row.push(emptyCell());
        this.refreshGrid(table);
        this.emitChange();
      });
      this.appendMenuItem(menuElement, "Remove column", () => {
        if (table.columns <= 1) return;
        if (tableHasSpans(table)) {
          this.deps.showPreviewMessage?.("Remove columns after splitting merged cells.");
          return;
        }
        table.columns -= 1;
        for (const row of table.rows) row.length = table.columns;
        this.resetSelection();
        this.refreshGrid(table);
        this.emitChange();
      });
    });
    menu("cells", menuElement => {
      this.appendMenuItem(menuElement, "Merge cells", () => this.mergeSelection(table));
      this.appendMenuItem(menuElement, "Split cells", () => this.splitSelection(table));
    });
    menu("borders", menuElement => {
      this.appendMenuToggle(menuElement, "Show border handles", this.borderMode, () => {
        this.borderMode = !this.borderMode;
        this.renderGrid(table);
        this.syncSelectionSummary();
        this.refreshTableMenu();
      });
      this.appendMenuSeparator(menuElement);
      this.appendMenuHeading(menuElement, "Apply to selection");
      this.appendMenuItem(menuElement, "All borders", () => this.applyBorderToSelection(table, "all"));
      this.appendMenuItem(menuElement, "No borders", () => this.applyBorderToSelection(table, "none"));
      this.appendMenuItem(menuElement, "Outline only", () => this.applyBorderToSelection(table, "outline"));
      this.appendMenuHeading(menuElement, `Thickness (${this.borderWidth}pt)`);
      this.appendMenuChoices(menuElement, [0.25, 0.5, 1, 2], () => this.borderWidth, value => {
        this.borderWidth = value;
        this.emitChange();
      });
      this.appendMenuHeading(menuElement, "Color");
      this.appendMenuColor(menuElement, this.borderColor, value => {
        this.borderColor = value;
        this.emitChange();
      });
    });
    menu("table", menuElement => {
      this.appendMenuToggle(menuElement, "Header row", table.headerRow, () => {
        table.headerRow = !table.headerRow;
        this.renderGrid(table);
        this.emitChange();
        this.refreshTableMenu();
      });
      this.appendMenuToggle(menuElement, "Header column", table.headerColumn, () => {
        table.headerColumn = !table.headerColumn;
        this.renderGrid(table);
        this.emitChange();
        this.refreshTableMenu();
      });
      this.appendMenuSeparator(menuElement);
      this.appendMenuToggle(menuElement, "Table border", table.stroke === "solid", () => {
        table.stroke = table.stroke === "solid" ? "none" : "solid";
        this.renderGrid(table);
        this.emitChange();
        this.refreshTableMenu();
      });
      this.appendMenuHeading(menuElement, `Table thickness (${table.strokeWidth}pt)`);
      this.appendMenuChoices(menuElement, [0.25, 0.5, 1, 2], () => table.strokeWidth, value => {
        table.strokeWidth = value;
        this.renderGrid(table);
        this.emitChange();
      });
      this.appendMenuHeading(menuElement, "Table color");
      this.appendMenuColor(menuElement, table.strokeColor, value => {
        table.strokeColor = value;
        this.renderGrid(table);
        this.emitChange();
      });
      this.appendMenuSeparator(menuElement);
      this.appendMenuItem(menuElement, "Delete table", () => {
        const index = this.tables.findIndex(candidate => candidate.id === table.id);
        if (index === -1) return;
        this.tables.splice(index, 1);
        this.selectedId = this.tables[Math.min(index, this.tables.length - 1)]?.id ?? null;
        this.resetSelection();
        this.renderSidebar();
        this.renderInspector();
        this.emitChange();
      });
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
    this.syncAlignSelects(table);
    this.updateCode(table);
  }

  private renderGrid(table: StoredTable): void {
    const host = this.inspector.querySelector<HTMLElement>(".table-tool-grid-host");
    if (!host) return;
    this.commitEdit();
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
        const banded = table.style === "banded-rows"
          ? rowIndex % 2 === 1
          : table.style === "banded-columns" && columnIndex % 2 === 1;
        if (banded) wrap.classList.add("band-fill");
        if (range
          && rowIndex >= range.minRow && rowIndex <= range.maxRow
          && columnIndex >= range.minColumn && columnIndex <= range.maxColumn) {
          wrap.classList.add("selected");
        }
        if (this.selectionFocus
          && rowIndex === this.selectionFocus.row
          && columnIndex === this.selectionFocus.column) {
          wrap.classList.add("focus-cell");
        }
        if (this.borderMode) wrap.classList.add("borders-visible");

        const input = document.createElement("input");
        input.type = "text";
        input.className = "table-tool-cell";
        input.dataset.row = String(rowIndex);
        input.dataset.column = String(columnIndex);
        if (cell.align) input.classList.add(`align-${cell.align}`);
        input.value = cell.text;
        input.readOnly = true;
        input.addEventListener("input", () => {
          cell.text = input.value;
          this.updateCode(table);
          // The content is not final while editing; defer the render to commit.
          this.emitChange({ preview: false });
        });
        input.addEventListener("focus", () => {
          if (this.editingCell) return;
          this.selectionAnchor = { row: rowIndex, column: columnIndex };
          this.selectionFocus = { row: rowIndex, column: columnIndex };
          this.syncSelectionHighlight();
          this.syncSelectionSummary();
        });
        input.addEventListener("mousedown", event => {
          if (event.button !== 0) return;
          // Navigation and editing are separate states: the first click only
          // selects a cell, a second click (or typing) starts editing.
          event.preventDefault();
          const origin = { row: rowIndex, column: columnIndex };
          const isFocus = this.selectionFocus?.row === rowIndex
            && this.selectionFocus?.column === columnIndex;
          if (this.editingCell
            && (this.editingCell.row !== rowIndex || this.editingCell.column !== columnIndex)) {
            this.commitEdit();
          }
          if (isFocus && !this.editingCell) {
            this.enterEditMode(table, origin);
            return;
          }
          if (event.shiftKey && this.selectionAnchor) {
            this.selectionFocus = origin;
          } else {
            this.selectionAnchor = origin;
            this.selectionFocus = origin;
            this.draggingSelection = true;
          }
          input.focus();
          this.syncSelectionHighlight();
          this.syncSelectionSummary();
          this.syncAlignSelects(table);
        });
        input.addEventListener("dblclick", event => {
          event.preventDefault();
          this.enterEditMode(table, { row: rowIndex, column: columnIndex });
        });
        input.addEventListener("pointerenter", event => {
          if (this.editingCell || !this.draggingSelection || (event.buttons & 1) === 0) return;
          this.selectionFocus = { row: rowIndex, column: columnIndex };
          this.syncSelectionHighlight();
          this.syncSelectionSummary();
        });
        input.addEventListener("keydown", event =>
          this.handleCellKeydown(event, table, rowIndex, columnIndex, cell, input));
        wrap.appendChild(input);
        // Always draw the model's strokes; the edge strips become clickable
        // handles only while border mode is active.
        for (const side of BORDER_SIDES) {
          const edge = document.createElement("span");
          edge.className = `table-tool-edge table-tool-edge-${side}`;
          const sideStyle = effectiveSide(table, cell, side);
          edge.classList.toggle("on", sideStyle.enabled);
          edge.style.setProperty("--edge-color", sideStyle.color);
          edge.style.setProperty("--edge-width", `${Math.max(1, Math.round(sideStyle.width * 1.5))}px`);
          edge.title = `${side} border (${sideStyle.enabled ? "on" : "off"})`;
          edge.addEventListener("pointerdown", event => {
            event.preventDefault();
            event.stopPropagation();
            this.toggleBorder(table, { row: rowIndex, column: columnIndex }, side);
          });
          wrap.appendChild(edge);
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
    input: HTMLInputElement,
  ): void {
    const editing = this.editingCell?.row === row && this.editingCell?.column === column;
    if (editing) {
      if (event.key === "Escape") {
        event.preventDefault();
        this.cancelEdit(table, input);
      } else if (event.key === "Enter") {
        event.preventDefault();
        this.commitEdit();
        this.moveSelection(table, "ArrowDown", row, column, cell);
      }
      return;
    }
    if (event.key === "Escape") return;
    if (event.key === "Enter" || event.key === "F2") {
      event.preventDefault();
      this.enterEditMode(table, { row, column });
      return;
    }
    if (event.key === "Backspace" || event.key === "Delete") {
      event.preventDefault();
      cell.text = "";
      input.value = "";
      this.updateCode(table);
      this.emitChange();
      return;
    }
    // Typing replaces the cell content and starts editing.
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      this.enterEditMode(table, { row, column }, event.key);
      return;
    }
    if (event.key === "ArrowLeft" || event.key === "ArrowRight"
      || event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      this.moveSelection(table, event.key, row, column, cell, event.shiftKey);
    }
  }

  private moveSelection(
    table: StoredTable,
    key: "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown",
    row: number,
    column: number,
    cell: StoredTableCell,
    extend = false,
  ): void {
    const moves: Record<typeof key, Slot> = {
      ArrowLeft: { row, column: column - 1 },
      ArrowRight: { row, column: column + cell.colspan },
      ArrowUp: { row: row - 1, column },
      ArrowDown: { row: row + cell.rowspan, column },
    };
    const origin = tableCellOrigin(table, moves[key].row, moves[key].column);
    if (!origin) return;
    if (!extend || !this.selectionAnchor) this.selectionAnchor = origin;
    this.selectionFocus = origin;
    this.syncSelectionHighlight();
    this.syncAlignSelects(table);
    this.cellInputs.get(`${origin.row}:${origin.column}`)?.focus();
    this.syncSelectionSummary();
  }

  private enterEditMode(table: StoredTable, origin: Slot, typedCharacter?: string): void {
    const cell = table.rows[origin.row]?.[origin.column];
    const input = this.cellInputs.get(`${origin.row}:${origin.column}`);
    if (!cell || cell.covered || !input) return;
    this.editingCell = origin;
    this.editStartValue = cell.text;
    this.selectionAnchor = origin;
    this.selectionFocus = origin;
    // Any pending render belongs to the committed content; hold renders until
    // the edit commits.
    if (this.previewTimer !== null) {
      window.clearTimeout(this.previewTimer);
      this.previewTimer = null;
    }
    if (typedCharacter !== undefined) cell.text = typedCharacter;
    input.readOnly = false;
    input.value = cell.text;
    input.classList.add("is-editing");
    input.focus();
    const caret = input.value.length;
    input.setSelectionRange(caret, caret);
    this.syncSelectionHighlight();
    this.syncSelectionSummary();
    if (typedCharacter !== undefined) {
      this.updateCode(table);
      this.emitChange({ preview: false });
    }
  }

  private commitEdit(): void {
    const origin = this.editingCell;
    if (!origin) return;
    this.editingCell = null;
    const input = this.cellInputs.get(`${origin.row}:${origin.column}`);
    if (input) {
      input.readOnly = true;
      input.classList.remove("is-editing");
    }
    // The content is final now, so the deferred render can run.
    this.schedulePreview();
  }

  private cancelEdit(table: StoredTable, input: HTMLInputElement): void {
    const origin = this.editingCell;
    if (!origin) return;
    const cell = table.rows[origin.row]?.[origin.column];
    if (cell) cell.text = this.editStartValue;
    input.value = this.editStartValue;
    this.editingCell = null;
    input.readOnly = true;
    input.classList.remove("is-editing");
    // A cancelled edit must not remain in history or the persisted model.
    if (this.historyTimer !== null) {
      window.clearTimeout(this.historyTimer);
      this.historyTimer = null;
    }
    this.pendingSnapshot = null;
    const selected = this.selected();
    this.lastState = selected ? cloneTable(selected) : null;
    this.updateCode(table);
    // The content returned to its committed value; no render is needed.
    this.notifyChange({ preview: false });
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
      const focus = this.selectionFocus;
      wrap.classList.toggle(
        "focus-cell",
        focus !== null && row === focus.row && column === focus.column,
      );
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

  private applyTableStyle(table: StoredTable, style: StoredTableStyle): void {
    table.style = style;
    this.refreshGrid(table);
    this.emitChange();
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

  private applyVerticalAlignment(table: StoredTable, verticalAlign: StoredTableVerticalAlignment | null): void {
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
        cell.verticalAlign = verticalAlign;
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
    this.refreshGrid(table);
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
    this.refreshGrid(table);
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
    this.refreshGrid(table);
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
    this.refreshGrid(table);
    this.emitChange();
  }

  private setCellBorder(cell: StoredTableCell, side: keyof StoredTableCellBorders, enabled: boolean): void {
    if (!cell.borders) cell.borders = { top: null, right: null, bottom: null, left: null };
    cell.borders[side] = { enabled, width: this.borderWidth, color: this.borderColor };
  }

  private toggleBorder(table: StoredTable, origin: Slot, side: keyof StoredTableCellBorders): void {
    const cell = table.rows[origin.row][origin.column];
    const next = !effectiveSide(table, cell, side).enabled;
    this.setCellBorder(cell, side, next);
    const neighborSlot: Record<keyof StoredTableCellBorders, Slot> = {
      top: { row: origin.row - 1, column: origin.column },
      bottom: { row: origin.row + cell.rowspan, column: origin.column },
      left: { row: origin.row, column: origin.column - 1 },
      right: { row: origin.row, column: origin.column + cell.colspan },
    };
    const neighbor = tableCellOrigin(table, neighborSlot[side].row, neighborSlot[side].column);
    if (neighbor && (neighbor.row !== origin.row || neighbor.column !== origin.column)) {
      this.setCellBorder(table.rows[neighbor.row][neighbor.column], OPPOSITE_SIDE[side], next);
    }
    this.renderGrid(table);
    this.syncSelectionHighlight();
    this.emitChange();
  }

  private applyBorderToSelection(table: StoredTable, mode: "all" | "none" | "outline"): void {
    const range = this.selectionRange();
    if (!range) {
      this.deps.showPreviewMessage?.("Select cells before applying borders.");
      return;
    }
    const inside = (row: number, column: number) =>
      row >= range.minRow && row <= range.maxRow && column >= range.minColumn && column <= range.maxColumn;
    const visited = new Set<string>();
    for (let row = range.minRow; row <= range.maxRow; row += 1) {
      for (let column = range.minColumn; column <= range.maxColumn; column += 1) {
        const origin = tableCellOrigin(table, row, column);
        if (!origin) continue;
        const key = `${origin.row}:${origin.column}`;
        if (visited.has(key)) continue;
        visited.add(key);
        const cell = table.rows[origin.row][origin.column];
        const sides: Array<[keyof StoredTableCellBorders, Slot]> = [
          ["top", { row: origin.row - 1, column: origin.column }],
          ["bottom", { row: origin.row + cell.rowspan, column: origin.column }],
          ["left", { row: origin.row, column: origin.column - 1 }],
          ["right", { row: origin.row, column: origin.column + cell.colspan }],
        ];
        for (const [side, neighbor] of sides) {
          const outer = !inside(neighbor.row, neighbor.column);
          const enabled = mode === "all" ? true : mode === "none" ? false : outer;
          this.setCellBorder(cell, side, enabled);
        }
      }
    }
    this.renderGrid(table);
    this.syncSelectionHighlight();
    this.emitChange();
  }

  private openTableMenu(anchor: HTMLButtonElement, build: (menu: HTMLElement) => void): void {
    if (this.activeMenu && this.activeMenuAnchor === anchor) {
      this.closeTableMenu();
      return;
    }
    this.closeTableMenu();
    const menu = document.createElement("div");
    menu.className = "dropdown-menu table-tool-menu";
    menu.setAttribute("role", "menu");
    build(menu);
    this.menuBuild = build;
    this.activeMenuAnchor = anchor;
    document.body.appendChild(menu);
    const rect = anchor.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - menu.offsetWidth - 8))}px`;
    menu.style.top = `${rect.bottom + 4}px`;
    this.activeMenu = menu;
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node
        && (menu.contains(event.target) || this.activeMenuAnchor?.contains(event.target))) {
        // Clicks inside the menu or on its owning button must not count as
        // "outside"; the button's click handler toggles the menu closed.
        return;
      }
      this.closeTableMenu();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") this.closeTableMenu();
    };
    this.menuCleanup = () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
    window.setTimeout(() => {
      document.addEventListener("pointerdown", onPointerDown, true);
      document.addEventListener("keydown", onKeyDown, true);
    }, 0);
  }

  private closeTableMenu(): void {
    this.menuCleanup?.();
    this.menuCleanup = null;
    this.activeMenu?.remove();
    this.activeMenu = null;
    this.activeMenuAnchor = null;
    this.menuBuild = null;
  }

  /** Rebuilds the open menu so toggles and choice highlights stay current. */
  private refreshTableMenu(): void {
    const menu = this.activeMenu;
    const build = this.menuBuild;
    if (!menu || !build) return;
    menu.replaceChildren();
    build(menu);
  }

  private appendMenuItem(
    menu: HTMLElement,
    label: string,
    onSelect: () => void,
    options: { disabled?: boolean; checked?: boolean } = {},
  ): void {
    const item = document.createElement("div");
    item.className = "dropdown-item";
    if (options.disabled) item.classList.add("dropdown-item-disabled");
    item.setAttribute("role", "menuitem");
    item.textContent = options.checked ? `✓ ${label}` : label;
    if (!options.disabled) {
      // Menus stay open after a selection; an outside click or the owning
      // button closes them.
      item.addEventListener("click", () => onSelect());
    }
    menu.appendChild(item);
  }

  private appendMenuToggle(menu: HTMLElement, label: string, checked: boolean, onSelect: () => void): void {
    this.appendMenuItem(menu, label, onSelect, { checked });
  }

  private appendMenuSeparator(menu: HTMLElement): void {
    const separator = document.createElement("div");
    separator.className = "dropdown-separator";
    menu.appendChild(separator);
  }

  private appendMenuHeading(menu: HTMLElement, label: string): void {
    const heading = document.createElement("div");
    heading.className = "table-tool-menu-heading";
    heading.textContent = label;
    menu.appendChild(heading);
  }

  private appendMenuChoices(
    menu: HTMLElement,
    values: readonly number[],
    current: () => number,
    onSelect: (value: number) => void,
  ): void {
    const row = document.createElement("div");
    row.className = "table-tool-menu-choices";
    for (const value of values) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = `${value}pt`;
      if (current() === value) button.classList.add("active");
      button.addEventListener("click", () => {
        onSelect(value);
        this.refreshTableMenu();
      });
      row.appendChild(button);
    }
    menu.appendChild(row);
  }

  private appendMenuColor(menu: HTMLElement, value: string, onSelect: (value: string) => void): void {
    const row = document.createElement("div");
    row.className = "table-tool-menu-color";
    const input = document.createElement("input");
    input.type = "color";
    input.value = value;
    input.addEventListener("input", () => onSelect(input.value));
    row.appendChild(input);
    menu.appendChild(row);
  }

  private syncAlignSelects(table: StoredTable): void {
    const focus = this.selectionFocus;
    const cell = focus ? table.rows[focus.row]?.[focus.column] : null;
    const align = this.inspector.querySelector<HTMLSelectElement>('[data-field="cell-align"]');
    if (align) {
      align.value = cell?.align ?? "";
      align.disabled = !focus;
    }
    const verticalAlign = this.inspector.querySelector<HTMLSelectElement>('[data-field="cell-vertical-align"]');
    if (verticalAlign) {
      verticalAlign.value = cell?.verticalAlign ?? "";
      verticalAlign.disabled = !focus;
    }
  }

  private updateCode(table: StoredTable): void {
    const code = this.inspector.querySelector<HTMLElement>('[data-field="code"]');
    if (code) code.textContent = generateTableTypst(table);
  }
}
