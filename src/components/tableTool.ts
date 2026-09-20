import { confirm, open } from "@tauri-apps/plugin-dialog";
import { readTextFile } from "@tauri-apps/plugin-fs";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { TABLE_SAMPLES, type TableSample } from "./tableSamples";
import { parseDelimitedText, tableFromRows, transposeRows } from "./tableImport";
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
  StoredTableRule,
  StoredTableStyle,
  StoredTableVerticalAlignment,
} from "../workspace/workspaceStateStore";
import { autoTextColorForFill, generateTableTypst } from "./tableTypst";

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
  /** Shows the app's shared context menu (used by the table explorer list). */
  showContextMenu?(items: ReadonlyArray<{ label: string; onSelect: () => void }>, x: number, y: number): void;
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
    rowSizes: [...table.rowSizes],
    rules: table.rules.map(rule => ({ ...rule })),
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
    textColor: null,
    rotate: false,
    breakable: null,
    inset: null,
    raw: false,
  };
}

function emptyRow(columns: number): StoredTableCell[] {
  return Array.from({ length: columns }, emptyCell);
}

// Track sizes accept a length unit (pt/mm/cm/in/em/%) or a fraction; a bare
// number is only meaningful as the scalar `columns: N` count.
const TRACK_SIZE_PATTERN = /^(?:auto|[0-9]+(?:\.[0-9]+)?(?:pt|mm|cm|in|em|%|fr))$/u;

/** Parses a track-size input; returns "" for auto, null when invalid. */
function normalizeTrackSize(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === "" || trimmed === "auto") return "";
  return TRACK_SIZE_PATTERN.test(trimmed) ? trimmed : null;
}

/** Confirm destructive removals with the app's shared dialog style. */
async function confirmDelete(message: string): Promise<boolean> {
  return confirm(message, { title: "Confirm Delete", kind: "warning" });
}

/** Leading header rows, matching generation. */
function headerRowCountOf(table: StoredTable): number {
  return table.headerRow ? Math.max(1, Math.min(table.headerRowCount, table.rows.length)) : 0;
}

/** Numbers sort numerically; everything else sorts case-insensitively. */
export function compareCellText(a: string, b: string): number {
  const asNumber = (value: string) => {
    const cleaned = value.replace(/[^0-9.eE+-]/gu, "");
    return cleaned !== "" && Number.isFinite(Number(cleaned)) ? Number(cleaned) : null;
  };
  const left = asNumber(a);
  const right = asNumber(b);
  if (left !== null && right !== null) return left - right;
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

function describeRule(rule: StoredTableRule): string {
  const axis = rule.axis === "horizontal" ? "H" : "V";
  const span = rule.end === null ? `from ${rule.start}` : `${rule.start}–${rule.end}`;
  return `Remove ${axis} rule at ${rule.position} (${span})`;
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
  private textColor = "#ffffff";
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
  private sampleDialog: HTMLElement | null = null;
  private sampleDialogCleanup: (() => void) | null = null;
  private importDialog: HTMLElement | null = null;
  private importDialogCleanup: (() => void) | null = null;

  public constructor(
    private readonly list: HTMLElement,
    private readonly inspector: HTMLElement,
    private readonly deps: TableToolDependencies,
  ) {
    document.getElementById("tables-new-button")?.addEventListener("click", () => this.openSamplesDialog());
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
    this.closeSamplesDialog();
    this.closeImportDialog();
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
    this.createFromSample(TABLE_SAMPLES[0]);
  }

  private uniqueTableName(base: string): string {
    const names = new Set(this.tables.map(table => table.name));
    if (!names.has(base)) return base;
    let index = 2;
    while (names.has(`${base} ${index}`)) index += 1;
    return `${base} ${index}`;
  }

  private createFromSample(sample: TableSample): void {
    const id = this.nextTableId();
    const built = sample.build();
    const table: StoredTable = { ...built, id, name: this.uniqueTableName(sample.name) };
    this.tables.push(table);
    this.selectedId = id;
    this.selectionAnchor = { row: 0, column: 0 };
    this.selectionFocus = { row: 0, column: 0 };
    this.resetHistory(table);
    this.emitChange();
    this.renderSidebar();
    this.renderInspector();
    this.schedulePreview();
    this.closeSamplesDialog();
  }

  /** Offers ready-made tables (with rendered thumbnails) when creating one. */
  private openSamplesDialog(): void {
    this.closeSamplesDialog();
    // Use the shared modal conventions (`.settings-overlay` + an inner
    // `[aria-modal]` dialog) so the app's focus trap keeps Tab inside.
    const overlay = document.createElement("div");
    overlay.className = "settings-overlay table-samples-overlay";
    overlay.setAttribute("role", "presentation");
    overlay.innerHTML =
      `<div class="table-samples-dialog" role="dialog" aria-modal="true" aria-label="New table">` +
      `<header class="table-samples-header"><div><h2>New Table</h2>` +
      `<p>Start from a sample or an empty table.</p></div>` +
      `<button type="button" class="table-samples-close settings-icon-button" aria-label="Close">✕</button>` +
      `</header><div class="table-samples-grid"></div></div>`;
    const grid = overlay.querySelector<HTMLElement>(".table-samples-grid")!;
    for (const sample of TABLE_SAMPLES) {
      const card = document.createElement("button");
      card.type = "button";
      card.className = "table-sample-card";
      card.dataset.sample = sample.id;
      // Thumbnails are pre-rendered static images (see `samples:render`).
      card.innerHTML =
        `<span class="table-sample-thumb">` +
        `<img class="table-sample-image" src="/table-samples/${sample.id}.svg" ` +
        `alt="" loading="lazy" draggable="false" /></span>` +
        `<span class="table-sample-name"></span><span class="table-sample-desc"></span>`;
      card.querySelector<HTMLElement>(".table-sample-name")!.textContent = sample.name;
      card.querySelector<HTMLElement>(".table-sample-desc")!.textContent = sample.description;
      card.addEventListener("click", () => this.createFromSample(sample));
      grid.appendChild(card);
    }
    const importCard = document.createElement("button");
    importCard.type = "button";
    importCard.className = "table-sample-card table-sample-import";
    importCard.innerHTML =
      `<span class="table-sample-thumb table-sample-import-thumb">` +
      `<span class="table-sample-placeholder">Paste CSV / TSV</span></span>` +
      `<span class="table-sample-name">Import data</span>` +
      `<span class="table-sample-desc">Paste comma- or tab-separated rows.</span>`;
    importCard.addEventListener("click", () => this.openImportDialog());
    grid.appendChild(importCard);
    overlay.querySelector(".table-samples-close")?.addEventListener("click", () => this.closeSamplesDialog());
    overlay.addEventListener("pointerdown", event => {
      if (event.target === overlay) this.closeSamplesDialog();
    });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") this.closeSamplesDialog();
    };
    document.addEventListener("keydown", onKeyDown, true);
    this.sampleDialogCleanup = () => document.removeEventListener("keydown", onKeyDown, true);
    document.body.appendChild(overlay);
    this.sampleDialog = overlay;
    grid.querySelector<HTMLElement>(".table-sample-card")?.focus();
  }

  private closeSamplesDialog(): void {
    this.sampleDialogCleanup?.();
    this.sampleDialogCleanup = null;
    this.sampleDialog?.remove();
    this.sampleDialog = null;
  }

  /** Paste CSV/TSV to build a new table (first row becomes the header). */
  private openImportDialog(): void {
    this.closeSamplesDialog();
    const overlay = document.createElement("div");
    overlay.className = "settings-overlay table-import-overlay";
    overlay.setAttribute("role", "presentation");
    overlay.innerHTML =
      `<div class="table-samples-dialog table-import-dialog" role="dialog" aria-modal="true" aria-label="Import table data">` +
      `<header class="table-samples-header"><div><h2>Import data</h2>` +
      `<p>Paste comma- or tab-separated rows, or choose a .csv / .tsv file.</p></div>` +
      `<button type="button" class="table-import-close settings-icon-button" aria-label="Close">✕</button></header>` +
      `<div class="table-import-body"><textarea class="table-import-text" spellcheck="false" ` +
      `placeholder="Name, Score, Grade&#10;Ada, 95, A"></textarea>` +
      `<label class="table-import-option"><input type="checkbox" class="table-import-transpose" /> ` +
      `Transpose rows and columns</label>` +
      `<fieldset class="table-import-mode"><legend>Import as</legend>` +
      `<label class="table-import-option"><input type="radio" name="table-import-mode" ` +
      `class="table-import-flatten" checked /> Individual rows</label>` +
      `<label class="table-import-option"><input type="radio" name="table-import-mode" ` +
      `class="table-import-map" disabled /> Linked CSV (read at compile time)</label>` +
      `</fieldset></div>` +
      `<footer class="table-import-footer">` +
      `<button type="button" class="table-import-file">Choose file…</button>` +
      `<button type="button" class="table-import-cancel">Cancel</button>` +
      `<button type="button" class="table-import-confirm primary">Import</button></footer></div>`;
    const close = () => this.closeImportDialog();
    let chosenPath = "";
    overlay.querySelector(".table-import-close")?.addEventListener("click", close);
    overlay.querySelector(".table-import-cancel")?.addEventListener("click", close);
    overlay.querySelector(".table-import-file")?.addEventListener("click", () => {
      void this.chooseImportFile(overlay, path => {
        chosenPath = path;
        const map = overlay.querySelector<HTMLInputElement>(".table-import-map");
        if (map) map.disabled = false;
      });
    });
    overlay.addEventListener("pointerdown", event => {
      if (event.target === overlay) close();
    });
    overlay.querySelector(".table-import-confirm")?.addEventListener("click", () => {
      const text = overlay.querySelector<HTMLTextAreaElement>(".table-import-text")?.value ?? "";
      const parsed = parseDelimitedText(text);
      if (parsed.every(row => row.every(value => value === ""))) {
        this.deps.showPreviewMessage?.("Paste some comma- or tab-separated rows first.");
        return;
      }
      const transpose = overlay.querySelector<HTMLInputElement>(".table-import-transpose")?.checked;
      const linked = overlay.querySelector<HTMLInputElement>(".table-import-map")?.checked;
      this.createTableFromRows(
        transpose ? transposeRows(parsed) : parsed,
        linked && chosenPath ? chosenPath : "",
      );
      this.closeImportDialog();
    });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("keydown", onKeyDown, true);
    this.importDialogCleanup = () => document.removeEventListener("keydown", onKeyDown, true);
    document.body.appendChild(overlay);
    this.importDialog = overlay;
    overlay.querySelector<HTMLTextAreaElement>(".table-import-text")?.focus();
  }

  private closeImportDialog(): void {
    this.importDialogCleanup?.();
    this.importDialogCleanup = null;
    this.importDialog?.remove();
    this.importDialog = null;
  }

  private async chooseImportFile(
    overlay: HTMLElement,
    onSelected: (path: string) => void,
  ): Promise<void> {
    try {
      const selected = await open({
        multiple: false,
        filters: [{ name: "Table data", extensions: ["csv", "tsv"] }],
      });
      const path = Array.isArray(selected) ? selected[0] : selected;
      if (!path) return;
      const text = await readTextFile(path);
      const textarea = overlay.querySelector<HTMLTextAreaElement>(".table-import-text");
      if (textarea && this.importDialog === overlay) {
        textarea.value = text;
        textarea.focus();
      }
      onSelected(path);
    } catch (error) {
      this.deps.log?.("warning", `Could not read the selected table file: ${String(error)}`);
    }
  }

  private createTableFromRows(rows: string[][], dataFile = ""): void {
    const id = this.nextTableId();
    const table = tableFromRows(rows, id, this.uniqueTableName("Imported table"));
    table.dataFile = dataFile;
    this.tables.push(table);
    this.selectedId = id;
    this.selectionAnchor = { row: 0, column: 0 };
    this.selectionFocus = { row: 0, column: 0 };
    this.resetHistory(table);
    this.emitChange();
    this.renderSidebar();
    this.renderInspector();
    this.schedulePreview();
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
      // Tables are managed from the explorer: right-click to delete.
      item.addEventListener("contextmenu", event => {
        event.preventDefault();
        event.stopPropagation();
        this.selectTable(table.id);
        const name = this.inspector.querySelector<HTMLInputElement>('[data-field="table-name"]');
        this.deps.showContextMenu?.([
          { label: "Rename", onSelect: () => name?.focus() },
          { label: "Delete table", onSelect: () => this.deleteTable(table) },
        ], event.clientX, event.clientY);
      });
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
              table.rowSizes.push("");
              this.refreshGrid(table);
              this.emitChange();
            },
          },
          {
            kind: "item",
            label: "Remove row",
            icon: "minus",
            onSelect: () => void this.deleteRow(table, table.rows.length - 1),
          },
          { kind: "separator" },
          { kind: "heading", label: "Row height" },
          {
            kind: "choices",
            values: ["", "40pt", "60pt"],
            current: () => this.selectionRowSize(table),
            format: value => (value === "" ? "Auto" : String(value)),
            onSelect: value => this.applyRowSize(table, String(value)),
          },
          {
            kind: "field",
            value: this.selectionRowSize(table),
            placeholder: "e.g. 40pt or 1fr",
            ariaLabel: "Custom row height",
            onCommit: value => this.applyRowSize(table, value),
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
            onSelect: () => void this.deleteColumn(table, table.columns - 1),
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
          {
            kind: "field",
            value: this.selectionColumnSize(table),
            placeholder: "e.g. 80pt or 2fr",
            ariaLabel: "Custom column width",
            onCommit: value => this.applyColumnSize(table, value),
          },
          { kind: "separator" },
          { kind: "item", label: "Sort ascending", icon: "arrowUp", onSelect: () => this.sortByColumn(table, 1) },
          { kind: "item", label: "Sort descending", icon: "arrowDown", onSelect: () => this.sortByColumn(table, -1) },
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
          { kind: "heading", label: "Text color" },
          { kind: "color", value: this.textColor, onInput: value => { this.textColor = value; this.applyTextColor(table, value); } },
          { kind: "item", label: "Default text color", icon: "x", onSelect: () => this.applyTextColor(table, null) },
          { kind: "heading", label: "Inset" },
          {
            kind: "choices",
            values: [0, 2, 4, 8],
            current: () => this.selectionInset(table) ?? 5,
            format: value => `${value}pt`,
            onSelect: value => this.applyInset(table, Number(value)),
          },
          { kind: "separator" },
          {
            kind: "toggle",
            label: "Rotate content",
            checked: this.selectionAll(table, cell => cell.rotate),
            onSelect: () => this.applyRotate(table, !this.selectionAll(table, cell => cell.rotate)),
          },
          {
            kind: "toggle",
            label: "Keep together",
            checked: this.selectionAll(table, cell => cell.breakable === false),
            onSelect: () => this.applyCellBreakable(
              table,
              this.selectionAll(table, cell => cell.breakable === false) ? null : false,
            ),
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
          { kind: "separator" },
          { kind: "heading", label: `Rules (${table.rules.length})` },
          { kind: "item", label: "Rule below", onSelect: () => this.addRuleFromSelection(table, "horizontal", "after") },
          { kind: "item", label: "Rule above", onSelect: () => this.addRuleFromSelection(table, "horizontal", "before") },
          { kind: "item", label: "Rule right", onSelect: () => this.addRuleFromSelection(table, "vertical", "after") },
          { kind: "item", label: "Rule left", onSelect: () => this.addRuleFromSelection(table, "vertical", "before") },
          {
            kind: "item",
            label: "Clear rules",
            icon: "x",
            disabled: table.rules.length === 0,
            onSelect: () => {
              table.rules = [];
              this.updateCode(table);
              this.emitChange();
            },
          },
          ...this.ruleRemovalEntries(table),
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
              if (table.headerRow && table.headerRowCount < 1) table.headerRowCount = 1;
              this.renderGrid(table);
              this.emitChange();
            },
          },
          { kind: "heading", label: "Header rows" },
          {
            kind: "choices",
            values: [1, 2, 3],
            current: () => Math.max(1, table.headerRowCount || 1),
            format: value => String(value),
            onSelect: value => this.applyHeaderRows(table, Number(value)),
          },
          {
            kind: "toggle",
            label: "Repeat header",
            checked: table.headerRepeat,
            onSelect: () => {
              table.headerRepeat = !table.headerRepeat;
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
          {
            kind: "toggle",
            label: "Repeat footer",
            checked: table.footerRepeat,
            onSelect: () => {
              table.footerRepeat = !table.footerRepeat;
              this.emitChange();
            },
          },
          {
            kind: "toggle",
            label: "Break across pages",
            checked: table.breakable,
            onSelect: () => {
              table.breakable = !table.breakable;
              this.updateCode(table);
              this.emitChange();
            },
          },
          { kind: "separator" },
          { kind: "heading", label: "CSV data source" },
          {
            kind: "field",
            value: table.dataFile,
            placeholder: "path (e.g. data/results.csv)",
            ariaLabel: "CSV data file",
            onCommit: value => this.applyDataFile(table, value),
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
          { kind: "item", label: "Transpose", onSelect: () => this.transpose(table) },
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
          { value: "report", label: "Report" },
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

  private async deleteTable(table: StoredTable): Promise<void> {
    const index = this.tables.findIndex(candidate => candidate.id === table.id);
    if (index === -1) return;
    const accepted = await confirmDelete(`Delete the table "${table.name}"? This cannot be undone.`);
    if (!accepted) return;
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
        if (table.headerRow && rowIndex < Math.max(1, table.headerRowCount)) {
          wrap.classList.add("is-header-row");
        }
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
        this.applyInputAppearance(input, cell);
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

  private ruleRemovalEntries(table: StoredTable): ToolbarMenuEntry[] {
    if (table.rules.length === 0) return [];
    const entries: ToolbarMenuEntry[] = [{ kind: "heading", label: "Remove rule" }];
    table.rules.slice(0, 12).forEach((rule, index) => {
      entries.push({
        kind: "item",
        label: describeRule(rule),
        icon: "minus",
        onSelect: () => {
          table.rules.splice(index, 1);
          this.updateCode(table);
          this.emitChange();
        },
      });
    });
    return entries;
  }

  private addRuleFromSelection(
    table: StoredTable,
    axis: "horizontal" | "vertical",
    where: "before" | "after",
  ): void {
    const range = this.selectionRange();
    if (!range) return;
    let position: number;
    let start: number;
    let end: number;
    if (axis === "horizontal") {
      position = where === "before" ? range.minRow : range.maxRow + 1;
      start = range.minColumn;
      end = range.maxColumn + 1;
    } else {
      position = where === "before" ? range.minColumn : range.maxColumn + 1;
      start = range.minRow;
      end = range.maxRow + 1;
    }
    const full = start === 0 && end >= (axis === "horizontal" ? table.columns : table.rows.length);
    const normalizedEnd = full ? null : end;
    const index = table.rules.findIndex(rule =>
      rule.axis === axis && rule.position === position && rule.start === start && rule.end === normalizedEnd);
    if (index >= 0) {
      table.rules.splice(index, 1);
    } else {
      table.rules.push({
        axis,
        position,
        start,
        end: normalizedEnd,
        width: this.borderWidth,
        color: this.borderColor,
      });
    }
    this.updateCode(table);
    this.emitChange();
  }

  /** Keeps explicit rules aligned when a row/column is inserted. */
  private shiftRulesForInsert(insertedAxis: "row" | "column", index: number): void {
    const table = this.selected();
    if (!table) return;
    const positionAxis = insertedAxis === "row" ? "horizontal" : "vertical";
    for (const rule of table.rules) {
      if (rule.axis === positionAxis) {
        if (rule.position >= index) rule.position += 1;
      } else if (index <= rule.start) {
        rule.start += 1;
        if (rule.end !== null) rule.end += 1;
      } else if (rule.end !== null && index < rule.end) {
        rule.end += 1;
      }
    }
  }

  /** Keeps explicit rules aligned when a row/column is removed. */
  private shiftRulesForDelete(insertedAxis: "row" | "column", index: number): void {
    const table = this.selected();
    if (!table) return;
    const positionAxis = insertedAxis === "row" ? "horizontal" : "vertical";
    table.rules = table.rules.filter(rule => {
      if (rule.axis === positionAxis) {
        if (rule.position === index) return false;
        if (rule.position > index) rule.position -= 1;
        return true;
      }
      if (index < rule.start) {
        rule.start -= 1;
        if (rule.end !== null) rule.end -= 1;
        return true;
      }
      if (rule.end !== null && index < rule.end) {
        rule.end -= 1;
        if (rule.end <= rule.start) return false;
      }
      return true;
    });
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

  private selectionAll(
    table: StoredTable,
    predicate: (cell: StoredTableCell) => boolean,
  ): boolean {
    let any = false;
    let all = true;
    this.forEachSelectionOrigin(table, cell => {
      any = true;
      if (!predicate(cell)) all = false;
    });
    return any && all;
  }

  private selectionIsRaw(table: StoredTable): boolean {
    return this.selectionAll(table, cell => cell.raw);
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

  private selectionRowSize(table: StoredTable): string {
    const range = this.selectionRange();
    if (!range) return "";
    let size: string | null = null;
    for (let row = range.minRow; row <= range.maxRow; row += 1) {
      const current = table.rowSizes[row] ?? "";
      if (size === null) size = current;
      else if (size !== current) return "";
    }
    return size ?? "";
  }

  private applyHeaderRows(table: StoredTable, count: number): void {
    table.headerRow = true;
    table.headerRowCount = Math.max(1, Math.min(count, table.rows.length));
    this.renderGrid(table);
    this.updateCode(table);
    this.emitChange();
  }

  private applyRowSize(table: StoredTable, value: string): void {
    const size = normalizeTrackSize(value);
    if (size === null) {
      this.deps.showPreviewMessage?.("Enter a track size like 40pt, 2fr, or auto.");
      return;
    }
    const range = this.selectionRange();
    if (!range) return;
    for (let row = range.minRow; row <= range.maxRow; row += 1) {
      if (row >= 0 && row < table.rowSizes.length) table.rowSizes[row] = size;
    }
    this.renderGrid(table);
    this.updateCode(table);
    this.emitChange();
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

  /** Reflects a cell's fill/text color on its builder input. */
  private applyInputAppearance(input: HTMLInputElement, cell: StoredTableCell): void {
    if (cell.fill) input.style.setProperty("--cell-fill", cell.fill);
    else input.style.removeProperty("--cell-fill");
    const color = cell.textColor ?? (cell.fill ? autoTextColorForFill(cell.fill) : null);
    if (color) input.style.color = color;
    else input.style.removeProperty("color");
  }

  private applyFill(table: StoredTable, fill: string | null): void {
    this.forEachSelectionOrigin(table, (cell, key) => {
      cell.fill = fill;
      const input = this.cellInputs.get(key);
      if (input) this.applyInputAppearance(input, cell);
    });
    this.updateCode(table);
    this.emitChange();
  }

  private applyDataFile(table: StoredTable, value: string): void {
    const file = value.trim();
    if (file && tableHasSpans(table)) {
      this.deps.showPreviewMessage?.("CSV data needs a table without merged cells.");
      return;
    }
    table.dataFile = file;
    this.updateCode(table);
    this.emitChange();
  }

  private applyRotate(table: StoredTable, rotate: boolean): void {
    this.forEachSelectionOrigin(table, cell => { cell.rotate = rotate; });
    this.updateCode(table);
    this.emitChange();
  }

  private applyCellBreakable(table: StoredTable, breakable: boolean | null): void {
    this.forEachSelectionOrigin(table, cell => { cell.breakable = breakable; });
    this.updateCode(table);
    this.emitChange();
  }

  private applyTextColor(table: StoredTable, color: string | null): void {
    this.forEachSelectionOrigin(table, (cell, key) => {
      cell.textColor = color;
      const input = this.cellInputs.get(key);
      if (input) this.applyInputAppearance(input, cell);
    });
    this.updateCode(table);
    this.emitChange();
  }

  private applyInset(table: StoredTable, inset: number | null): void {
    this.forEachSelectionOrigin(table, cell => { cell.inset = inset; });
    this.updateCode(table);
    this.emitChange();
  }

  private applyColumnSize(table: StoredTable, value: string): void {
    const size = normalizeTrackSize(value);
    if (size === null) {
      this.deps.showPreviewMessage?.("Enter a track size like 80pt, 2fr, or auto.");
      return;
    }
    const range = this.selectionRange();
    if (!range) return;
    for (let column = range.minColumn; column <= range.maxColumn; column += 1) {
      if (column >= 0 && column < table.columnSizes.length) table.columnSizes[column] = size;
    }
    this.renderGrid(table);
    this.updateCode(table);
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
    table.rowSizes.splice(index, 0, "");
    this.shiftRulesForInsert("row", index);
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
    this.shiftRulesForInsert("column", index);
    const row = Math.min(this.selectionAnchor?.row ?? 0, table.rows.length - 1);
    this.selectionAnchor = { row, column: index };
    this.selectionFocus = { ...this.selectionAnchor };
    this.refreshGrid(table);
    this.emitChange();
  }

  private async deleteRow(table: StoredTable, index: number): Promise<void> {
    if (table.rows.length <= 1) return;
    if (tableHasSpans(table)) {
      this.deps.showPreviewMessage?.("Delete rows after splitting merged cells.");
      return;
    }
    const accepted = await confirmDelete(`Delete row ${index + 1}? This cannot be undone.`);
    if (!accepted) return;
    table.rows.splice(index, 1);
    table.rowSizes.splice(index, 1);
    this.shiftRulesForDelete("row", index);
    const row = Math.min(index, table.rows.length - 1);
    this.selectionAnchor = { row, column: Math.min(this.selectionAnchor?.column ?? 0, table.columns - 1) };
    this.selectionFocus = { ...this.selectionAnchor };
    this.refreshGrid(table);
    this.emitChange();
  }

  private async deleteColumn(table: StoredTable, index: number): Promise<void> {
    if (table.columns <= 1) return;
    if (tableHasSpans(table)) {
      this.deps.showPreviewMessage?.("Delete columns after splitting merged cells.");
      return;
    }
    const accepted = await confirmDelete(`Delete column ${index + 1}? This cannot be undone.`);
    if (!accepted) return;
    table.columns -= 1;
    for (const row of table.rows) row.splice(index, 1);
    table.columnSizes.splice(index, 1);
    this.shiftRulesForDelete("column", index);
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

  private sortByColumn(table: StoredTable, direction: 1 | -1): void {
    if (tableHasSpans(table)) {
      this.deps.showPreviewMessage?.("Sort after splitting merged cells.");
      return;
    }
    const range = this.selectionRange();
    const column = range ? range.minColumn : this.selectionFocus?.column ?? 0;
    if (column < 0 || column >= table.columns) return;
    const headerCount = headerRowCountOf(table);
    const footerCount = table.footerRow && table.rows.length > headerCount ? 1 : 0;
    const end = table.rows.length - footerCount;
    const body = table.rows.slice(headerCount, end).map((row, index) => ({
      row,
      size: table.rowSizes[headerCount + index] ?? "",
    }));
    if (body.length < 2) return;
    body.sort((a, b) =>
      direction * compareCellText(a.row[column]?.text ?? "", b.row[column]?.text ?? ""));
    body.forEach((entry, index) => {
      table.rows[headerCount + index] = entry.row;
      table.rowSizes[headerCount + index] = entry.size;
    });
    this.refreshGrid(table);
    this.emitChange();
  }

  private transpose(table: StoredTable): void {
    if (tableHasSpans(table)) {
      this.deps.showPreviewMessage?.("Transpose after splitting merged cells.");
      return;
    }
    if (table.rules.length > 0) {
      this.deps.showPreviewMessage?.("Transpose after clearing rules.");
      return;
    }
    const rows = table.rows;
    const rowCount = rows.length;
    const columnCount = table.columns;
    const next: StoredTableCell[][] = [];
    for (let column = 0; column < columnCount; column += 1) {
      const row: StoredTableCell[] = [];
      for (let source = 0; source < rowCount; source += 1) {
        row.push({ ...rows[source][column], colspan: 1, rowspan: 1, covered: false });
      }
      next.push(row);
    }
    const oldColumnSizes = [...table.columnSizes];
    const oldRowSizes = [...table.rowSizes];
    table.rows = next;
    table.columns = rowCount;
    table.columnSizes = Array.from({ length: rowCount }, (_value, index) => oldRowSizes[index] ?? "");
    table.rowSizes = Array.from({ length: columnCount }, (_value, index) => oldColumnSizes[index] ?? "");
    const previousHeaderRow = table.headerRow;
    table.headerRow = table.headerColumn;
    table.headerColumn = previousHeaderRow;
    table.headerRowCount = table.headerRow ? 1 : 0;
    this.selectionAnchor = { row: 0, column: 0 };
    this.selectionFocus = { row: 0, column: 0 };
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
    const from = range.minRow;
    const target = from + direction;
    if (target < 0 || target >= table.rows.length) return;
    [table.rows[from], table.rows[target]] = [table.rows[target], table.rows[from]];
    [table.rowSizes[from], table.rowSizes[target]] = [table.rowSizes[target], table.rowSizes[from]];
    // Reordering is a remove + insert; move explicit rules along with it.
    this.shiftRulesForDelete("row", from);
    this.shiftRulesForInsert("row", target);
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
    this.shiftRulesForDelete("column", column);
    this.shiftRulesForInsert("column", target);
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
