import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { wrapEditorCaretInput } from "../ui/editorCaretInput";
import { createAppIcon } from "../ui/icons";
import {
  createToolbar,
  type SharedToolbar,
  type ToolbarEntry,
  type ToolbarMenuEntry,
} from "../ui/toolbar";
import type {
  StoredTable,
  StoredTableBorderSide,
  StoredTableCell,
  StoredTableCellBorders,
  StoredTableAlignment,
  StoredTableCaptionAlign,
  StoredTableCaptionPosition,
  StoredTableEmphasis,
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

/** The visual formatting of a cell, copied and pasted as a unit. */
type StoredCellFormat = {
  align: StoredTableAlignment | null;
  verticalAlign: StoredTableVerticalAlignment | null;
  emphasis: StoredTableEmphasis | null;
  fill: string | null;
  inset: number | null;
  borders: StoredTableCellBorders | null;
};

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
    columnSizes: [...table.columnSizes],
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
    emphasis: null,
    colspan: 1,
    rowspan: 1,
    covered: false,
    borders: null,
    fill: null,
    inset: null,
    raw: false,
  };
}

function emptyRow(columns: number): StoredTableCell[] {
  return Array.from({ length: columns }, emptyCell);
}

/** Labels reference figures: keep only characters valid inside `<...>`. */
function sanitizeTableLabel(value: string): string {
  return value
    .replace(/^[<\s]+/u, "")
    .replace(/[>\s]+$/u, "")
    .replace(/[^A-Za-z0-9_.:-]/gu, "");
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
  private fillColor = "#eef2f7";
  private copiedFormats: StoredCellFormat[][] | null = null;
  private draggingSelection = false;
  private editingCell: Slot | null = null;
  private editStartValue = "";
  private toolbar: SharedToolbar | null = null;
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
    this.toolbar?.closeMenus();
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
      caption: "",
      captionPosition: "bottom",
      captionAlign: "left",
      columnSizes: ["", ""],
      gutter: 0,
      label: "",
      alt: "",
      footerRow: false,
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
    this.toolbar?.dispose();
    this.toolbar = null;
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
      `<label class="table-tool-name">Name <input class="table-tool-field" data-field="table-name" type="text" maxlength="80" /></label>` +
      `<div class="table-tool-menubar-host"></div>` +
      `<div class="table-tool-selection" data-field="selection-summary" aria-live="polite"></div>` +
      `<div class="table-tool-grid-host"></div>` +
      `<label class="table-tool-name table-tool-caption">Caption <input class="table-tool-field" data-field="table-caption" type="text" maxlength="200" placeholder="Optional caption" /></label>` +
      `<label class="table-tool-name">Label <input class="table-tool-field" data-field="table-label" type="text" maxlength="64" placeholder="e.g. tab:results" /></label>` +
      `<label class="table-tool-name">Alt text <input class="table-tool-field" data-field="table-alt" type="text" maxlength="300" placeholder="Optional description" /></label>` +
      `</section>` +
      `<section class="image-tool-section"><h3>Generated Typst</h3>` +
      `<div class="image-tool-actions"><button type="button" data-action="copy" class="primary"><span data-field="copy-label">Copy code</span></button></div>` +
      `<pre class="table-tool-code" data-field="code"></pre></section>`;

    // Reuse the editor's caret text field so Khmer text renders in the same font
    // and the caret behaves like the code editor's.
    this.inspector.querySelectorAll<HTMLInputElement>("input.table-tool-field").forEach(field => {
      const marker = document.createComment("table-field");
      field.replaceWith(marker);
      marker.replaceWith(wrapEditorCaretInput(field, { shellClass: "table-tool-field-shell" }));
    });

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

    const caption = this.inspector.querySelector<HTMLInputElement>('[data-field="table-caption"]')!;
    caption.value = table.caption;
    caption.addEventListener("input", () => {
      table.caption = caption.value.slice(0, 200);
      this.updateCode(table);
      this.emitChange();
    });

    const label = this.inspector.querySelector<HTMLInputElement>('[data-field="table-label"]')!;
    label.value = table.label;
    label.addEventListener("input", () => {
      const cleaned = sanitizeTableLabel(label.value);
      if (cleaned !== label.value) label.value = cleaned;
      table.label = cleaned;
      this.updateCode(table);
      this.emitChange();
    });

    const alt = this.inspector.querySelector<HTMLInputElement>('[data-field="table-alt"]')!;
    alt.value = table.alt;
    alt.addEventListener("input", () => {
      table.alt = alt.value.slice(0, 300);
      this.updateCode(table);
      this.emitChange();
    });

    this.toolbar = createToolbar({
      className: "table-tool-menubar",
      ariaLabel: "Table actions",
      entries: this.toolbarEntries(table),
    });
    this.inspector.querySelector(".table-tool-menubar-host")?.replaceWith(this.toolbar.element);

    const copy = this.inspector.querySelector<HTMLButtonElement>('[data-action="copy"]')!;
    copy.prepend(createAppIcon("copy", { size: 13 }));
    const copyLabel = this.inspector.querySelector<HTMLElement>('[data-field="copy-label"]')!;
    copy.addEventListener("click", () => {
      void writeText(generateTableTypst(table))
        .then(() => {
          copyLabel.textContent = "Copied";
          window.setTimeout(() => { copyLabel.textContent = "Copy code"; }, 1200);
        })
        .catch(error => this.deps.log?.("warning", `Could not copy table code: ${String(error)}`));
    });

    this.renderGrid(table);
    this.syncCellSelects(table);
    this.updateCode(table);
  }

  /** The table editor shares the app toolbar, exposing only table controls. */
  private toolbarEntries(table: StoredTable): ToolbarEntry[] {
    return [
      {
        kind: "menu",
        id: "rows",
        label: "Rows",
        entries: () => [
          { kind: "item", label: "Move row up", icon: "arrowUp", onSelect: () => this.moveRow(table, -1) },
          { kind: "item", label: "Move row down", icon: "arrowDown", onSelect: () => this.moveRow(table, 1) },
          { kind: "separator" },
          {
            kind: "item",
            label: "Add row",
            icon: "plus",
            onSelect: () => {
              if (table.rows.length >= MAX_ROWS) return;
              table.rows.push(emptyRow(table.columns));
              this.refreshGrid(table);
              this.emitChange();
            },
          },
          {
            kind: "item",
            label: "Remove row",
            icon: "minus",
            onSelect: () => {
              if (table.rows.length <= 1) return;
              if (tableHasSpans(table)) {
                this.deps.showPreviewMessage?.("Remove rows after splitting merged cells.");
                return;
              }
              table.rows.pop();
              this.resetSelection();
              this.refreshGrid(table);
              this.emitChange();
            },
          },
        ],
      },
      {
        kind: "menu",
        id: "columns",
        label: "Columns",
        entries: () => [
          { kind: "item", label: "Move column left", icon: "chevronLeft", onSelect: () => this.moveColumn(table, -1) },
          { kind: "item", label: "Move column right", icon: "chevronRight", onSelect: () => this.moveColumn(table, 1) },
          { kind: "separator" },
          {
            kind: "item",
            label: "Add column",
            icon: "plus",
            onSelect: () => {
              if (table.columns >= MAX_COLUMNS) return;
              table.columns += 1;
              for (const row of table.rows) row.push(emptyCell());
              table.columnSizes.push("");
              this.refreshGrid(table);
              this.emitChange();
            },
          },
          {
            kind: "item",
            label: "Remove column",
            icon: "minus",
            onSelect: () => {
              if (table.columns <= 1) return;
              if (tableHasSpans(table)) {
                this.deps.showPreviewMessage?.("Remove columns after splitting merged cells.");
                return;
              }
              table.columns -= 1;
              for (const row of table.rows) row.length = table.columns;
              table.columnSizes.length = table.columns;
              this.resetSelection();
              this.refreshGrid(table);
              this.emitChange();
            },
          },
          { kind: "separator" },
          { kind: "heading", label: "Column width" },
          {
            kind: "choices",
            values: ["", "1fr", "2fr", "3fr"],
            current: () => this.selectionColumnSize(table),
            format: value => (value === "" ? "Auto" : String(value)),
            onSelect: value => this.applyColumnSize(table, String(value)),
          },
        ],
      },
      {
        kind: "menu",
        id: "cells",
        label: "Cells",
        entries: () => [
          { kind: "item", label: "Merge cells", onSelect: () => this.mergeSelection(table) },
          { kind: "item", label: "Split cells", onSelect: () => this.splitSelection(table) },
          { kind: "separator" },
          {
            kind: "toggle",
            label: "Typst content",
            checked: this.selectionIsRaw(table),
            onSelect: () => this.applyRaw(table, !this.selectionIsRaw(table)),
          },
          { kind: "heading", label: "Fill" },
          { kind: "color", value: this.fillColor, onInput: value => { this.fillColor = value; this.applyFill(table, value); } },
          { kind: "item", label: "No fill", icon: "x", onSelect: () => this.applyFill(table, null) },
          { kind: "heading", label: "Inset" },
          {
            kind: "choices",
            values: [0, 2, 4, 8],
            current: () => this.selectionInset(table) ?? 5,
            format: value => `${value}pt`,
            onSelect: value => this.applyInset(table, Number(value)),
          },
          { kind: "separator" },
          { kind: "item", label: "Copy formatting", icon: "copy", onSelect: () => this.copyFormatting(table) },
          {
            kind: "item",
            label: "Paste formatting",
            icon: "clipboardPaste",
            disabled: !this.copiedFormats,
            onSelect: () => this.pasteFormatting(table),
          },
        ],
      },
      {
        kind: "menu",
        id: "borders",
        label: "Borders",
        entries: () => [
          {
            kind: "toggle",
            label: "Show border handles",
            checked: this.borderMode,
            onSelect: () => {
              this.borderMode = !this.borderMode;
              this.renderGrid(table);
              this.syncSelectionSummary();
            },
          },
          { kind: "separator" },
          { kind: "heading", label: "Apply to selection" },
          { kind: "item", label: "All borders", onSelect: () => this.applyBorderToSelection(table, "all") },
          { kind: "item", label: "No borders", onSelect: () => this.applyBorderToSelection(table, "none") },
          { kind: "item", label: "Outline only", onSelect: () => this.applyBorderToSelection(table, "outline") },
          { kind: "heading", label: `Thickness (${this.borderWidth}pt)` },
          {
            kind: "choices",
            values: [0.25, 0.5, 1, 2],
            current: () => this.borderWidth,
            format: value => `${value}pt`,
            onSelect: value => {
              this.borderWidth = Number(value);
              this.emitChange();
            },
          },
          { kind: "heading", label: "Color" },
          { kind: "color", value: this.borderColor, onInput: value => { this.borderColor = value; this.emitChange(); } },
        ],
      },
      {
        kind: "menu",
        id: "table",
        label: "Table",
        entries: () => [
          {
            kind: "toggle",
            label: "Header row",
            checked: table.headerRow,
            onSelect: () => {
              table.headerRow = !table.headerRow;
              this.renderGrid(table);
              this.emitChange();
            },
          },
          {
            kind: "toggle",
            label: "Header column",
            checked: table.headerColumn,
            onSelect: () => {
              table.headerColumn = !table.headerColumn;
              this.renderGrid(table);
              this.emitChange();
            },
          },
          { kind: "separator" },
          {
            kind: "toggle",
            label: "Table border",
            checked: table.stroke === "solid",
            onSelect: () => {
              table.stroke = table.stroke === "solid" ? "none" : "solid";
              this.renderGrid(table);
              this.emitChange();
            },
          },
          { kind: "heading", label: `Table thickness (${table.strokeWidth}pt)` },
          {
            kind: "choices",
            values: [0.25, 0.5, 1, 2],
            current: () => table.strokeWidth,
            format: value => `${value}pt`,
            onSelect: value => {
              table.strokeWidth = Number(value);
              this.renderGrid(table);
              this.emitChange();
            },
          },
          { kind: "heading", label: "Table color" },
          {
            kind: "color",
            value: table.strokeColor,
            onInput: value => {
              table.strokeColor = value;
              this.renderGrid(table);
              this.emitChange();
            },
          },
          { kind: "separator" },
          {
            kind: "toggle",
            label: "Footer row",
            checked: table.footerRow,
            onSelect: () => {
              table.footerRow = !table.footerRow;
              this.renderGrid(table);
              this.emitChange();
            },
          },
          { kind: "heading", label: `Gutter (${table.gutter}pt)` },
          {
            kind: "choices",
            values: [0, 2, 4, 8],
            current: () => table.gutter,
            format: value => `${value}pt`,
            onSelect: value => {
              table.gutter = Number(value);
              this.renderGrid(table);
              this.emitChange();
            },
          },
          { kind: "separator" },
          { kind: "item", label: "Delete table", icon: "x", onSelect: () => this.deleteTable(table) },
        ],
      },
      { kind: "separator" },
      {
        kind: "select",
        id: "style",
        label: "Style",
        value: table.style,
        options: [
          { value: "default", label: "Default" },
          { value: "banded-rows", label: "Banded rows" },
          { value: "banded-columns", label: "Banded columns" },
          { value: "booktabs", label: "Booktabs" },
        ],
        onChange: value => this.applyTableStyle(table, value as StoredTableStyle),
      },
      {
        kind: "select",
        id: "align",
        label: "Align",
        value: "",
        options: [
          { value: "", label: "Default" },
          { value: "left", label: "Left" },
          { value: "center", label: "Center" },
          { value: "right", label: "Right" },
        ],
        onChange: value => this.applyAlignment(table, (value || null) as StoredTableAlignment | null),
      },
      {
        kind: "select",
        id: "vertical",
        label: "Vertical",
        value: "",
        options: [
          { value: "", label: "Default" },
          { value: "top", label: "Top" },
          { value: "center", label: "Middle" },
          { value: "bottom", label: "Bottom" },
        ],
        onChange: value => this.applyVerticalAlignment(table, (value || null) as StoredTableVerticalAlignment | null),
      },
      { kind: "separator" },
      {
        kind: "select",
        id: "caption-position",
        label: "Caption",
        value: table.captionPosition,
        options: [
          { value: "bottom", label: "Below" },
          { value: "top", label: "Above" },
        ],
        onChange: value => this.applyCaptionPosition(table, value as StoredTableCaptionPosition),
      },
      {
        kind: "toggle",
        id: "caption-center",
        title: "Center caption",
        icon: "alignCenter",
        onSelect: () => this.applyCaptionAlign(table, table.captionAlign === "center" ? "left" : "center"),
      },
      { kind: "separator" },
      { kind: "toggle", id: "bold", title: "Bold", icon: "bold", onSelect: () => this.toggleEmphasis(table, "bold") },
      { kind: "toggle", id: "italic", title: "Italic", icon: "italic", onSelect: () => this.toggleEmphasis(table, "italic") },
    ];
  }

  private toggleEmphasis(table: StoredTable, value: StoredTableEmphasis): void {
    const focus = this.selectionFocus;
    const current = focus ? table.rows[focus.row]?.[focus.column]?.emphasis ?? null : null;
    this.applyEmphasis(table, current === value ? null : value);
    this.syncCellSelects(table);
  }

  private deleteTable(table: StoredTable): void {
    const index = this.tables.findIndex(candidate => candidate.id === table.id);
    if (index === -1) return;
    this.tables.splice(index, 1);
    this.selectedId = this.tables[Math.min(index, this.tables.length - 1)]?.id ?? null;
    this.resetSelection();
    this.renderSidebar();
    this.renderInspector();
    this.emitChange();
  }

  private renderGrid(table: StoredTable): void {
    const host = this.inspector.querySelector<HTMLElement>(".table-tool-grid-host");
    if (!host) return;
    // Rebuilding replaces the focused cell; remember to restore focus so
    // keyboard navigation (arrows, clipboard) keeps working after a change.
    const restoreFocus = host.contains(document.activeElement);
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
        if (cell.emphasis === "bold") input.classList.add("emphasis-bold");
        if (cell.emphasis === "italic") input.classList.add("emphasis-italic");
        if (cell.fill) input.style.setProperty("--cell-fill", cell.fill);
        if (cell.raw) input.classList.add("is-raw");
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
          // Shift+arrow moves DOM focus to the range focus; that focus already
          // matches the selection, so it must not collapse the range.
          if (this.selectionFocus?.row === rowIndex
            && this.selectionFocus?.column === columnIndex) {
            return;
          }
          this.selectionAnchor = { row: rowIndex, column: columnIndex };
          this.selectionFocus = { row: rowIndex, column: columnIndex };
          this.syncSelectionHighlight();
          this.syncSelectionSummary();
        });
        input.addEventListener("mousedown", event => {
          if (event.button !== 0) {
            // Right-click must not move focus and collapse an existing range.
            if (event.button === 2) event.preventDefault();
            return;
          }
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
          this.syncCellSelects(table);
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
        input.addEventListener("contextmenu", event =>
          this.openCellContextMenu(event, table, rowIndex, columnIndex));
        // Cells share the editor's caret so the active cell shows the same
        // blinking/steady cursor while navigating and editing.
        wrap.appendChild(wrapEditorCaretInput(input, { shellClass: "table-tool-cell-shell" }));
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
    if (restoreFocus && this.selectionFocus) {
      this.cellInputs.get(`${this.selectionFocus.row}:${this.selectionFocus.column}`)?.focus();
    }
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
    if ((event.ctrlKey || event.metaKey) && !event.altKey) {
      const key = event.key.toLowerCase();
      if (key === "c") {
        event.preventDefault();
        this.copySelection(table, false);
        return;
      }
      if (key === "x") {
        event.preventDefault();
        this.copySelection(table, true);
        return;
      }
      if (key === "v") {
        event.preventDefault();
        this.pasteSelection(table);
        return;
      }
    }
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
    this.syncCellSelects(table);
    this.cellInputs.get(`${origin.row}:${origin.column}`)?.focus();
    this.syncSelectionSummary();
  }

  /** The editor caret only appears while a cell is actually being edited. */
  private markCellEditing(input: HTMLInputElement, editing: boolean): void {
    input.classList.toggle("is-editing", editing);
    input.closest(".table-tool-cell-shell")?.classList.toggle("is-editing", editing);
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
    this.markCellEditing(input, true);
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
      this.markCellEditing(input, false);
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
    this.markCellEditing(input, false);
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
      // The input is wrapped by the editor caret shell, so walk up to the cell.
      const wrap = input.closest<HTMLElement>(".table-tool-cell-wrap");
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

  private applyCaptionPosition(table: StoredTable, position: StoredTableCaptionPosition): void {
    table.captionPosition = position;
    this.refreshGrid(table);
    this.syncCellSelects(table);
    this.emitChange();
  }

  private applyCaptionAlign(table: StoredTable, align: StoredTableCaptionAlign): void {
    table.captionAlign = align;
    this.refreshGrid(table);
    this.syncCellSelects(table);
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

  private forEachSelectionOrigin(
    table: StoredTable,
    visit: (cell: StoredTableCell, key: string) => void,
  ): void {
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
        visit(table.rows[origin.row][origin.column], key);
      }
    }
  }

  private selectionIsRaw(table: StoredTable): boolean {
    let any = false;
    let all = true;
    this.forEachSelectionOrigin(table, cell => {
      any = true;
      if (!cell.raw) all = false;
    });
    return any && all;
  }

  private selectionInset(table: StoredTable): number | null {
    let any = false;
    let value: number | null = null;
    let mixed = false;
    this.forEachSelectionOrigin(table, cell => {
      if (!any) {
        any = true;
        value = cell.inset;
      } else if (cell.inset !== value) {
        mixed = true;
      }
    });
    return any && !mixed ? value : null;
  }

  private selectionColumnSize(table: StoredTable): string {
    const range = this.selectionRange();
    if (!range) return "";
    let size: string | null = null;
    for (let column = range.minColumn; column <= range.maxColumn; column += 1) {
      const current = table.columnSizes[column] ?? "";
      if (size === null) size = current;
      else if (size !== current) return "";
    }
    return size ?? "";
  }

  private applyRaw(table: StoredTable, raw: boolean): void {
    this.forEachSelectionOrigin(table, cell => { cell.raw = raw; });
    this.renderGrid(table);
    this.updateCode(table);
    this.emitChange();
  }

  private applyFill(table: StoredTable, fill: string | null): void {
    this.forEachSelectionOrigin(table, (cell, key) => {
      cell.fill = fill;
      const input = this.cellInputs.get(key);
      if (!input) return;
      if (fill) input.style.setProperty("--cell-fill", fill);
      else input.style.removeProperty("--cell-fill");
    });
    this.updateCode(table);
    this.emitChange();
  }

  private applyInset(table: StoredTable, inset: number | null): void {
    this.forEachSelectionOrigin(table, cell => { cell.inset = inset; });
    this.updateCode(table);
    this.emitChange();
  }

  private applyColumnSize(table: StoredTable, size: string): void {
    const range = this.selectionRange();
    if (!range) return;
    for (let column = range.minColumn; column <= range.maxColumn; column += 1) {
      if (column >= 0 && column < table.columnSizes.length) table.columnSizes[column] = size;
    }
    this.renderGrid(table);
    this.emitChange();
  }

  private applyEmphasis(table: StoredTable, emphasis: StoredTableEmphasis | null): void {
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
        table.rows[origin.row][origin.column].emphasis = emphasis;
        const input = this.cellInputs.get(key);
        if (input) {
          input.classList.remove("emphasis-bold", "emphasis-italic");
          if (emphasis === "bold") input.classList.add("emphasis-bold");
          if (emphasis === "italic") input.classList.add("emphasis-italic");
        }
      }
    }
    this.updateCode(table);
    this.emitChange();
  }

  private coveredCell(): StoredTableCell {
    return { ...emptyCell(), covered: true };
  }

  private openCellContextMenu(
    event: MouseEvent,
    table: StoredTable,
    row: number,
    column: number,
  ): void {
    // Own the gesture: suppress the native menu and the generic editor menu.
    event.preventDefault();
    event.stopPropagation();
    this.commitEdit();
    const range = this.selectionRange();
    const inside = Boolean(range
      && row >= range.minRow && row <= range.maxRow
      && column >= range.minColumn && column <= range.maxColumn);
    if (!inside) {
      this.selectionAnchor = { row, column };
      this.selectionFocus = { row, column };
      this.syncSelectionHighlight();
      this.syncCellSelects(table);
      this.syncSelectionSummary();
    }
    const cell = table.rows[row][column];
    const entries: ToolbarMenuEntry[] = [
      { kind: "item", label: "Cut", icon: "scissors", onSelect: () => this.copySelection(table, true) },
      { kind: "item", label: "Copy", icon: "copy", onSelect: () => this.copySelection(table, false) },
      { kind: "item", label: "Paste", icon: "clipboardPaste", onSelect: () => this.pasteSelection(table) },
      { kind: "separator" },
      { kind: "item", label: "Copy formatting", icon: "copy", onSelect: () => this.copyFormatting(table) },
      {
        kind: "item",
        label: "Paste formatting",
        icon: "clipboardPaste",
        disabled: !this.copiedFormats,
        onSelect: () => this.pasteFormatting(table),
      },
      { kind: "separator" },
      { kind: "item", label: "Insert row above", icon: "arrowUp", onSelect: () => this.insertRow(table, row) },
      { kind: "item", label: "Insert row below", icon: "arrowDown", onSelect: () => this.insertRow(table, row + cell.rowspan) },
      { kind: "item", label: "Insert column left", icon: "chevronLeft", onSelect: () => this.insertColumn(table, column) },
      { kind: "item", label: "Insert column right", icon: "chevronRight", onSelect: () => this.insertColumn(table, column + cell.colspan) },
      { kind: "item", label: "Delete row", icon: "minus", onSelect: () => this.deleteRow(table, row) },
      { kind: "item", label: "Delete column", icon: "minus", onSelect: () => this.deleteColumn(table, column) },
      { kind: "separator" },
      { kind: "item", label: "Merge cells", onSelect: () => this.mergeSelection(table) },
      { kind: "item", label: "Split cells", onSelect: () => this.splitSelection(table) },
      { kind: "separator" },
      { kind: "item", label: "Copy table code", icon: "copy", onSelect: () => this.copyTableCode(table) },
    ];
    this.toolbar?.openMenuAt({ left: event.clientX, top: event.clientY }, () => entries);
  }

  private insertRow(table: StoredTable, index: number): void {
    if (table.rows.length >= MAX_ROWS) return;
    const spanned = new Set<number>();
    for (let row = 0; row < index; row += 1) {
      for (let column = 0; column < table.columns; column += 1) {
        const cell = table.rows[row][column];
        if (cell.covered || row + cell.rowspan <= index) continue;
        // A span crossing the new row absorbs it.
        cell.rowspan += 1;
        for (let c = column; c < column + cell.colspan; c += 1) spanned.add(c);
      }
    }
    table.rows.splice(index, 0, Array.from(
      { length: table.columns },
      (_value, column) => spanned.has(column) ? this.coveredCell() : emptyCell(),
    ));
    const column = Math.min(this.selectionAnchor?.column ?? 0, table.columns - 1);
    this.selectionAnchor = { row: index, column };
    this.selectionFocus = { ...this.selectionAnchor };
    this.refreshGrid(table);
    this.emitChange();
  }

  private insertColumn(table: StoredTable, index: number): void {
    if (table.columns >= MAX_COLUMNS) return;
    table.rows.forEach(row => {
      let covered = false;
      for (let column = 0; column < index; column += 1) {
        const cell = row[column];
        if (cell.covered || column + cell.colspan <= index) continue;
        cell.colspan += 1;
        covered = true;
      }
      row.splice(index, 0, covered ? this.coveredCell() : emptyCell());
    });
    table.columns += 1;
    table.columnSizes.splice(index, 0, "");
    const row = Math.min(this.selectionAnchor?.row ?? 0, table.rows.length - 1);
    this.selectionAnchor = { row, column: index };
    this.selectionFocus = { ...this.selectionAnchor };
    this.refreshGrid(table);
    this.emitChange();
  }

  private deleteRow(table: StoredTable, index: number): void {
    if (table.rows.length <= 1) return;
    if (tableHasSpans(table)) {
      this.deps.showPreviewMessage?.("Delete rows after splitting merged cells.");
      return;
    }
    table.rows.splice(index, 1);
    const row = Math.min(index, table.rows.length - 1);
    this.selectionAnchor = { row, column: Math.min(this.selectionAnchor?.column ?? 0, table.columns - 1) };
    this.selectionFocus = { ...this.selectionAnchor };
    this.refreshGrid(table);
    this.emitChange();
  }

  private deleteColumn(table: StoredTable, index: number): void {
    if (table.columns <= 1) return;
    if (tableHasSpans(table)) {
      this.deps.showPreviewMessage?.("Delete columns after splitting merged cells.");
      return;
    }
    table.columns -= 1;
    for (const row of table.rows) row.splice(index, 1);
    table.columnSizes.splice(index, 1);
    this.selectionAnchor = { row: Math.min(this.selectionAnchor?.row ?? 0, table.rows.length - 1), column: Math.min(index, table.columns - 1) };
    this.selectionFocus = { ...this.selectionAnchor };
    this.refreshGrid(table);
    this.emitChange();
  }

  private cellFormatOf(cell: StoredTableCell): StoredCellFormat {
    return {
      align: cell.align,
      verticalAlign: cell.verticalAlign,
      emphasis: cell.emphasis,
      fill: cell.fill,
      inset: cell.inset,
      borders: cell.borders
        ? { top: cell.borders.top, right: cell.borders.right, bottom: cell.borders.bottom, left: cell.borders.left }
        : null,
    };
  }

  private copyFormatting(table: StoredTable): void {
    const range = this.selectionRange();
    if (!range) return;
    const block: StoredCellFormat[][] = [];
    for (let row = range.minRow; row <= range.maxRow; row += 1) {
      const line: StoredCellFormat[] = [];
      for (let column = range.minColumn; column <= range.maxColumn; column += 1) {
        const origin = tableCellOrigin(table, row, column);
        const cell = origin ? table.rows[origin.row][origin.column] : null;
        line.push(cell
          ? this.cellFormatOf(cell)
          : { align: null, verticalAlign: null, emphasis: null, fill: null, inset: null, borders: null });
      }
      block.push(line);
    }
    this.copiedFormats = block;
    this.deps.showPreviewMessage?.("Cell formatting copied. Select cells and paste formatting.");
  }

  private pasteFormatting(table: StoredTable): void {
    const block = this.copiedFormats;
    const range = this.selectionRange();
    if (!block || !range) return;
    const height = block.length;
    const width = block[0]?.length ?? 0;
    if (height === 0 || width === 0) return;
    const visited = new Set<string>();
    const apply = (slotRow: number, slotColumn: number, format: StoredCellFormat) => {
      const origin = tableCellOrigin(table, slotRow, slotColumn);
      if (!origin) return;
      const key = `${origin.row}:${origin.column}`;
      if (visited.has(key)) return;
      visited.add(key);
      const cell = table.rows[origin.row][origin.column];
      cell.align = format.align;
      cell.verticalAlign = format.verticalAlign;
      cell.emphasis = format.emphasis;
      cell.fill = format.fill;
      cell.inset = format.inset;
      cell.borders = format.borders
        ? { top: format.borders.top, right: format.borders.right, bottom: format.borders.bottom, left: format.borders.left }
        : null;
    };
    const single = range.minRow === range.maxRow && range.minColumn === range.maxColumn;
    if (single) {
      // Pasting onto one cell drops the whole copied block from that corner.
      for (let row = 0; row < height; row += 1) {
        for (let column = 0; column < width; column += 1) {
          apply(range.minRow + row, range.minColumn + column, block[row][column]);
        }
      }
    } else {
      for (let row = range.minRow; row <= range.maxRow; row += 1) {
        for (let column = range.minColumn; column <= range.maxColumn; column += 1) {
          apply(row, column, block[(row - range.minRow) % height][(column - range.minColumn) % width]);
        }
      }
    }
    this.renderGrid(table);
    this.updateCode(table);
    this.emitChange();
  }

  private copySelection(table: StoredTable, cut: boolean): void {
    const range = this.selectionRange();
    if (!range) return;
    const lines: string[] = [];
    for (let row = range.minRow; row <= range.maxRow; row += 1) {
      const values: string[] = [];
      for (let column = range.minColumn; column <= range.maxColumn; column += 1) {
        const origin = tableCellOrigin(table, row, column);
        if (!origin) continue;
        if (origin.row === row && origin.column === column) {
          values.push(table.rows[origin.row][origin.column].text);
        }
      }
      lines.push(values.join("\t"));
    }
    if (cut) {
      const visited = new Set<string>();
      for (let row = range.minRow; row <= range.maxRow; row += 1) {
        for (let column = range.minColumn; column <= range.maxColumn; column += 1) {
          const origin = tableCellOrigin(table, row, column);
          if (!origin) continue;
          const key = `${origin.row}:${origin.column}`;
          if (visited.has(key)) continue;
          visited.add(key);
          table.rows[origin.row][origin.column].text = "";
        }
      }
      this.refreshGrid(table);
      this.emitChange();
    }
    void writeText(lines.join("\n"))
      .catch(error => this.deps.log?.("warning", `Could not copy table cells: ${String(error)}`));
  }

  private pasteSelection(table: StoredTable): void {
    const range = this.selectionRange();
    if (!range) return;
    void readText()
      .then(text => {
        if (typeof text !== "string" || text.length === 0) return;
        const visited = new Set<string>();
        text.replace(/\r\n?/gu, "\n").split("\n").forEach((line, rowOffset) => {
          line.split("\t").forEach((value, columnOffset) => {
            const row = range.minRow + rowOffset;
            const column = range.minColumn + columnOffset;
            if (row >= table.rows.length || column >= table.columns) return;
            const origin = tableCellOrigin(table, row, column);
            if (!origin) return;
            const key = `${origin.row}:${origin.column}`;
            if (visited.has(key)) return;
            visited.add(key);
            table.rows[origin.row][origin.column].text = value;
          });
        });
        this.refreshGrid(table);
        this.emitChange();
      })
      .catch(error => this.deps.log?.("warning", `Could not paste into the table: ${String(error)}`));
  }

  private copyTableCode(table: StoredTable): void {
    void writeText(generateTableTypst(table))
      .then(() => this.deps.log?.("info", "Table code copied to the clipboard."))
      .catch(error => this.deps.log?.("warning", `Could not copy table code: ${String(error)}`));
  }

  private mergeSelection(table: StoredTable): void {
    const range = this.selectionRange();
    if (!range) return;
    if (range.minRow === range.maxRow && range.minColumn === range.maxColumn) {
      this.deps.showPreviewMessage?.("Select more than one cell to merge.");
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
    [table.columnSizes[column], table.columnSizes[target]] = [table.columnSizes[target], table.columnSizes[column]];
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

  private syncCellSelects(table: StoredTable): void {
    const focus = this.selectionFocus;
    const cell = focus ? table.rows[focus.row]?.[focus.column] : null;
    this.toolbar?.setSelectValue("align", cell?.align ?? "");
    this.toolbar?.setDisabled("align", !focus);
    this.toolbar?.setSelectValue("vertical", cell?.verticalAlign ?? "");
    this.toolbar?.setDisabled("vertical", !focus);
    this.toolbar?.setActive("bold", cell?.emphasis === "bold");
    this.toolbar?.setActive("italic", cell?.emphasis === "italic");
    this.toolbar?.setDisabled("bold", !focus);
    this.toolbar?.setDisabled("italic", !focus);
    this.toolbar?.setSelectValue("caption-position", table.captionPosition);
    this.toolbar?.setActive("caption-center", table.captionAlign === "center");
  }

  private updateCode(table: StoredTable): void {
    const code = this.inspector.querySelector<HTMLElement>('[data-field="code"]');
    if (code) code.textContent = generateTableTypst(table);
  }
}
