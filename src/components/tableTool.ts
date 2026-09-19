import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { createAppIcon } from "../ui/icons";
import type {
  StoredTable,
  StoredTableCell,
  StoredTableAlignment,
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

const MAX_COLUMNS = 32;
const MAX_ROWS = 500;

function cloneTable(table: StoredTable): StoredTable {
  return {
    ...table,
    rows: table.rows.map(row => row.map(cell => ({ ...cell }))),
  };
}

function emptyCell(): StoredTableCell {
  return { text: "", align: null };
}

function emptyRow(columns: number): StoredTableCell[] {
  return Array.from({ length: columns }, emptyCell);
}

/** Owns the project table list, the grid editor, and generated Typst code. */
export class TableToolController {
  private tables: StoredTable[] = [];
  private selectedId: string | null = null;
  private focusedCell: { row: number; column: number } | null = null;
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
    const index = this.tables.length + 1;
    const table: StoredTable = {
      id,
      name: `Table ${index}`,
      columns: 2,
      headerRow: true,
      headerColumn: false,
      rows: [emptyRow(2), emptyRow(2)],
    };
    this.tables.push(table);
    this.selectedId = id;
    this.emitChange();
    this.renderSidebar();
    this.renderInspector();
  }

  public selectTable(id: string): void {
    if (!this.tables.some(table => table.id === id)) return;
    this.selectedId = id;
    this.focusedCell = null;
    this.renderSidebar();
    this.renderInspector();
    this.schedulePreview();
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
      `<button type="button" data-action="add-row">Add row</button>` +
      `<button type="button" data-action="remove-row">Remove row</button>` +
      `<button type="button" data-action="add-column">Add column</button>` +
      `<button type="button" data-action="remove-column">Remove column</button>` +
      `<button type="button" data-action="delete">Delete table</button>` +
      `</div>` +
      `<div class="table-tool-options">` +
      `<label class="image-tool-lock"><input data-field="header-row" type="checkbox" /> Header row</label>` +
      `<label class="image-tool-lock"><input data-field="header-column" type="checkbox" /> Header column</label>` +
      `<label>Align cell <select data-field="cell-align"><option value="">Default</option><option value="left">Left</option><option value="center">Center</option><option value="right">Right</option></select></label>` +
      `</div>` +
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
    align.addEventListener("change", () => {
      const focused = this.focusedCell;
      if (!focused) return;
      const cell = table.rows[focused.row]?.[focused.column];
      if (!cell) return;
      cell.align = (align.value || null) as StoredTableAlignment | null;
      this.applyCellAlignment(table, focused.row, focused.column);
      this.emitChange();
    });
    this.syncAlignSelect(align, table);

    this.inspector.querySelector<HTMLButtonElement>('[data-action="add-row"]')!.addEventListener("click", () => {
      if (table.rows.length >= MAX_ROWS) return;
      table.rows.push(emptyRow(table.columns));
      this.renderInspector();
      this.emitChange();
    });
    this.inspector.querySelector<HTMLButtonElement>('[data-action="remove-row"]')!.addEventListener("click", () => {
      if (table.rows.length <= 1) return;
      table.rows.pop();
      this.focusedCell = null;
      this.renderInspector();
      this.emitChange();
    });
    this.inspector.querySelector<HTMLButtonElement>('[data-action="add-column"]')!.addEventListener("click", () => {
      if (table.columns >= MAX_COLUMNS) return;
      table.columns += 1;
      for (const row of table.rows) row.push(emptyCell());
      this.renderInspector();
      this.emitChange();
    });
    this.inspector.querySelector<HTMLButtonElement>('[data-action="remove-column"]')!.addEventListener("click", () => {
      if (table.columns <= 1) return;
      table.columns -= 1;
      for (const row of table.rows) row.pop();
      this.focusedCell = null;
      this.renderInspector();
      this.emitChange();
    });
    this.inspector.querySelector<HTMLButtonElement>('[data-action="delete"]')!.addEventListener("click", () => {
      const index = this.tables.findIndex(candidate => candidate.id === table.id);
      if (index === -1) return;
      this.tables.splice(index, 1);
      this.selectedId = this.tables[Math.min(index, this.tables.length - 1)]?.id ?? null;
      this.focusedCell = null;
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
    this.updateCode(table);
  }

  private renderGrid(table: StoredTable): void {
    const host = this.inspector.querySelector<HTMLElement>(".table-tool-grid-host");
    if (!host) return;
    const grid = document.createElement("div");
    grid.className = "table-tool-grid";
    grid.style.setProperty("--table-columns", String(table.columns));
    table.rows.forEach((row, rowIndex) => {
      const rowEl = document.createElement("div");
      rowEl.className = "table-tool-row";
      row.forEach((cell, columnIndex) => {
        const input = document.createElement("input");
        input.type = "text";
        input.className = "table-tool-cell";
        input.dataset.row = String(rowIndex);
        input.dataset.column = String(columnIndex);
        if (table.headerRow && rowIndex === 0) input.classList.add("is-header-row");
        if (table.headerColumn && columnIndex === 0) input.classList.add("is-header-column");
        if (cell.align) input.classList.add(`align-${cell.align}`);
        input.value = cell.text;
        input.addEventListener("input", () => {
          cell.text = input.value;
          this.updateCode(table);
          this.emitChange();
        });
        input.addEventListener("focus", () => {
          this.focusedCell = { row: rowIndex, column: columnIndex };
          const align = this.inspector.querySelector<HTMLSelectElement>('[data-field="cell-align"]');
          if (align) this.syncAlignSelect(align, table);
        });
        rowEl.appendChild(input);
      });
      grid.appendChild(rowEl);
    });
    host.replaceChildren(grid);
  }

  private applyCellAlignment(table: StoredTable, row: number, column: number): void {
    const host = this.inspector.querySelector<HTMLElement>(".table-tool-grid-host");
    const input = host?.querySelector<HTMLInputElement>(
      `.table-tool-cell[data-row="${row}"][data-column="${column}"]`,
    );
    if (!input) return;
    input.classList.remove("align-left", "align-center", "align-right");
    const align = table.rows[row]?.[column]?.align;
    if (align) input.classList.add(`align-${align}`);
  }

  private syncAlignSelect(select: HTMLSelectElement, table: StoredTable): void {
    const focused = this.focusedCell;
    const align = focused ? table.rows[focused.row]?.[focused.column]?.align ?? "" : "";
    select.value = align ?? "";
    select.disabled = focused === null;
  }

  private updateCode(table: StoredTable): void {
    const code = this.inspector.querySelector<HTMLElement>('[data-field="code"]');
    if (code) code.textContent = generateTableTypst(table);
  }
}
