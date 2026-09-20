import { invoke } from "@tauri-apps/api/core";
import type { PreviewRenderMode, TerminologyEntry } from "../settings";

export type StoredWorkspaceToolchain = {
  tinymistVersion: string;
  typstVersion: string;
};

export type StoredWorkspaceTab = {
  path: string;
  selectionAnchor: number;
  selectionHead: number;
  scrollTop?: number;
  scrollLeft?: number;
  previewScrollTop?: number;
  foldState?: "user" | null;
  foldRanges?: unknown[] | null;
};

export type StoredScriptLanguageAssignment = {
  script: string;
  languageTag: string;
};

export type StoredTableAlignment = "left" | "center" | "right";
export type StoredTableVerticalAlignment = "top" | "center" | "bottom";
export type StoredTableEmphasis = "regular" | "bold" | "italic";

/** A per-side border override; null inherits the table stroke. */
export type StoredTableBorderSide = {
  enabled: boolean;
  /** Stroke thickness in points. */
  width: number;
  /** `#rrggbb`. */
  color: string;
} | null;

export type StoredTableCellBorders = {
  top: StoredTableBorderSide;
  right: StoredTableBorderSide;
  bottom: StoredTableBorderSide;
  left: StoredTableBorderSide;
};

export type StoredTableCell = {
  text: string;
  align: StoredTableAlignment | null;
  verticalAlign: StoredTableVerticalAlignment | null;
  emphasis: StoredTableEmphasis | null;
  /** Grid span of the origin cell; covered slots inherit it. */
  colspan: number;
  rowspan: number;
  /** True for slots covered by another cell's span; they hold no content. */
  covered: boolean;
  /** Explicit side overrides; null inherits the table stroke. */
  borders: StoredTableCellBorders | null;
};

export type StoredTableStroke = "none" | "solid";

/** A predefined look; `default` follows the stroke settings. */
export type StoredTableStyle = "default" | "banded-rows" | "banded-columns" | "booktabs";
export type StoredTableCaptionPosition = "top" | "bottom";
export type StoredTableCaptionAlign = "left" | "center";

/**
 * A project-owned table reference. Tables are internal assignments: they live
 * in the portable project config and never create their own `.typ` files.
 */
export type StoredTable = {
  id: string;
  name: string;
  columns: number;
  headerRow: boolean;
  headerColumn: boolean;
  stroke: StoredTableStroke;
  strokeWidth: number;
  strokeColor: string;
  style: StoredTableStyle;
  caption: string;
  captionPosition: StoredTableCaptionPosition;
  captionAlign: StoredTableCaptionAlign;
  rows: StoredTableCell[][];
};

export type StoredProjectState = {
  schemaVersion: 2;
  projectId: string;
  mainFile: string | null;
  recommendedToolchain: StoredWorkspaceToolchain | null;
  terminology: TerminologyEntry[];
  scriptLanguages: StoredScriptLanguageAssignment[];
  tables: StoredTable[];
};

export type StoredWorkspaceState = {
  schemaVersion: 2;
  activeFile: string | null;
  openTabs: StoredWorkspaceTab[];
  expandedDirectories: string[];
  layout: {
    inputContainerWidthPct: number;
    explorerSidebarWidthPx: number;
    sidebarVisible: boolean;
    activeSidebarTool: "explorer" | "images" | "tables";
  };
  selectedToolchain: StoredWorkspaceToolchain | null;
  previewContentMode: "normal" | "draft";
  previewRenderMode: PreviewRenderMode | null;
  previewScrollTop: number;
};

export type WorkspaceMetadata = {
  project: StoredProjectState;
  workspace: StoredWorkspaceState;
};

export type LegacyWorkspaceState = {
  activeFilePath: string | null;
  pinnedMainFilePath: string | null;
  openTabs: StoredWorkspaceTab[];
  inputContainerWidthPct: number;
  explorerSidebarWidthPx: number;
  recommendedToolchain: StoredWorkspaceToolchain | null;
  selectedToolchain: StoredWorkspaceToolchain | null;
};

type MetadataPayload = { project: unknown | null; workspace: unknown | null };

export function safeRelativeWorkspacePath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) return null;
  const segments = normalized.split("/");
  return segments.some(segment => !segment || segment === "." || segment === "..") ? null : normalized;
}

export function workspaceRestoreCandidates(metadata: WorkspaceMetadata): string[] {
  const candidates = [
    metadata.workspace.activeFile,
    metadata.project.mainFile,
    ...metadata.workspace.openTabs.map(tab => tab.path)
  ];
  return candidates.filter((path, index): path is string => !!path && candidates.indexOf(path) === index);
}

export function normalizeWorkspaceMetadata(
  payload: MetadataPayload,
  createProjectId: () => string = () => crypto.randomUUID()
): WorkspaceMetadata {
  const project = objectValue(payload.project);
  const workspace = objectValue(payload.workspace);
  const layout = objectValue(workspace.layout);
  const normalizedOpenTabs = Array.isArray(workspace.openTabs)
    ? workspace.openTabs.flatMap(value => {
        const tab = objectValue(value);
        const path = safeRelativeWorkspacePath(tab.path);
        if (!path) return [];
        return [{
          path,
          selectionAnchor: numberOr(tab.selectionAnchor, 0),
          selectionHead: numberOr(tab.selectionHead, 0),
          scrollTop: typeof tab.scrollTop === "number" ? tab.scrollTop : undefined,
          scrollLeft: typeof tab.scrollLeft === "number" ? tab.scrollLeft : undefined,
          previewScrollTop: typeof tab.previewScrollTop === "number"
            ? Math.max(0, tab.previewScrollTop)
            : undefined,
          foldState: tab.foldState === "user" ? "user" as const : null,
          foldRanges: tab.foldState === "user" && Array.isArray(tab.foldRanges)
            ? tab.foldRanges
            : null
        }];
      })
    : [];
  const seenOpenTabs = new Set<string>();
  const openTabs = normalizedOpenTabs.filter(tab => {
    if (seenOpenTabs.has(tab.path)) return false;
    seenOpenTabs.add(tab.path);
    return true;
  });
  return {
    project: {
      schemaVersion: 2,
      projectId: typeof project.projectId === "string" && project.projectId.length > 0
        ? project.projectId
        : createProjectId(),
      mainFile: safeRelativeWorkspacePath(project.mainFile),
      recommendedToolchain: toolchainOrNull(project.recommendedToolchain),
      terminology: normalizeProjectTerminology(project.terminology),
      scriptLanguages: normalizeScriptLanguages(project.scriptLanguages),
      tables: normalizeTables(project.tables)
    },
    workspace: {
      schemaVersion: 2,
      activeFile: safeRelativeWorkspacePath(workspace.activeFile),
      openTabs,
      expandedDirectories: Array.isArray(workspace.expandedDirectories)
        ? [...new Set(workspace.expandedDirectories.flatMap(path => safeRelativeWorkspacePath(path) ?? []))]
        : [],
      layout: {
        inputContainerWidthPct: numberOr(layout.inputContainerWidthPct, 50),
        explorerSidebarWidthPx: numberOr(layout.explorerSidebarWidthPx, 250),
        sidebarVisible: typeof layout.sidebarVisible === "boolean" ? layout.sidebarVisible : true,
        activeSidebarTool: layout.activeSidebarTool === "images"
          ? "images"
          : layout.activeSidebarTool === "tables" ? "tables" : "explorer"
      },
      selectedToolchain: toolchainOrNull(workspace.selectedToolchain),
      previewContentMode: workspace.previewContentMode === "draft" ? "draft" : "normal",
      previewRenderMode: workspace.previewRenderMode === "on-type"
        ? "on-type"
        : workspace.previewRenderMode === "on-save" ? "on-save" : null,
      previewScrollTop: Math.max(0, numberOr(workspace.previewScrollTop, 0))
    }
  };
}

export class WorkspaceStateStore {
  private saveQueue: Promise<void> = Promise.resolve();

  public async load(workspacePath: string): Promise<WorkspaceMetadata | null> {
    const payload = await invoke<MetadataPayload>("load_workspace_metadata", { workspaceRootPath: workspacePath });
    if (payload.project === null && payload.workspace === null) return null;
    return normalizeWorkspaceMetadata(payload);
  }

  public save(workspacePath: string, metadata: WorkspaceMetadata): Promise<void> {
    this.saveQueue = this.saveQueue
      .catch(() => {})
      .then(() => invoke("save_workspace_metadata", {
        workspaceRootPath: workspacePath,
        project: metadata.project,
        workspace: metadata.workspace
      }));
    return this.saveQueue;
  }

  public loadLegacy(workspacePath: string): LegacyWorkspaceState | null {
    try {
      const stored = localStorage.getItem(this.legacyKey(workspacePath));
      if (!stored) return null;
      const value = objectValue(JSON.parse(stored));
      const openTabs = Array.isArray(value.openTabs)
        ? value.openTabs.flatMap(item => {
            const tab = objectValue(item);
            if (typeof tab.path !== "string") return [];
            return [{
              path: tab.path,
              selectionAnchor: numberOr(tab.selectionAnchor, 0),
              selectionHead: numberOr(tab.selectionHead, 0),
              scrollTop: typeof tab.scrollTop === "number" ? tab.scrollTop : undefined,
              scrollLeft: typeof tab.scrollLeft === "number" ? tab.scrollLeft : undefined,
              previewScrollTop: typeof tab.previewScrollTop === "number"
                ? Math.max(0, tab.previewScrollTop)
                : undefined,
              // Legacy state cannot distinguish automatic folds from folds the
              // user created, so it must reopen fully expanded.
              foldState: null,
              foldRanges: null
            }];
          })
        : [];
      return {
        activeFilePath: typeof value.activeFilePath === "string" ? value.activeFilePath : null,
        pinnedMainFilePath: typeof value.pinnedMainFilePath === "string" ? value.pinnedMainFilePath : null,
        openTabs,
        inputContainerWidthPct: numberOr(value.inputContainerWidthPct, 50),
        explorerSidebarWidthPx: numberOr(value.explorerSidebarWidthPx, 250),
        recommendedToolchain: toolchainOrNull(value.recommendedToolchain),
        selectedToolchain: toolchainOrNull(value.selectedToolchain)
      };
    } catch {
      return null;
    }
  }

  public removeLegacy(workspacePath: string): void {
    localStorage.removeItem(this.legacyKey(workspacePath));
  }

  private legacyKey(workspacePath: string): string {
    return `typsastra-workspace-${workspacePath}`;
  }
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function toolchainOrNull(value: unknown): StoredWorkspaceToolchain | null {
  const toolchain = objectValue(value);
  return typeof toolchain.tinymistVersion === "string" && typeof toolchain.typstVersion === "string"
    ? { tinymistVersion: toolchain.tinymistVersion, typstVersion: toolchain.typstVersion }
    : null;
}

function normalizeScriptLanguages(value: unknown): StoredScriptLanguageAssignment[] {
  if (!Array.isArray(value)) return [];
  const assignments = new Map<string, StoredScriptLanguageAssignment>();
  for (let index = value.length - 1; index >= 0 && assignments.size < 256; index -= 1) {
    const record = objectValue(value[index]);
    if (typeof record.script !== "string" || !/^[A-Z][a-z]{3}$/.test(record.script)) continue;
    if (assignments.has(record.script) || typeof record.languageTag !== "string") continue;
    const languageTag = /^([A-Za-z]{2,3})(?:-([A-Za-z]{2}|[0-9]{3}))?$/.exec(record.languageTag);
    if (!languageTag) continue;
    assignments.set(record.script, {
      script: record.script,
      languageTag: languageTag[2]
        ? `${languageTag[1].toLowerCase()}-${languageTag[2].toUpperCase()}`
        : languageTag[1].toLowerCase()
    });
  }
  return [...assignments.values()].reverse();
}

export const TABLE_ID_PATTERN = /^table_[0-9]+$/u;

function normalizeTableAlignment(value: unknown): StoredTableAlignment | null {
  return value === "left" || value === "center" || value === "right" ? value : null;
}

function normalizeTableVerticalAlignment(value: unknown): StoredTableVerticalAlignment | null {
  return value === "top" || value === "center" || value === "bottom" ? value : null;
}

function normalizeTableEmphasis(value: unknown): StoredTableEmphasis | null {
  return value === "regular" || value === "bold" || value === "italic" ? value : null;
}

function normalizeTableStyle(value: unknown): StoredTableStyle {
  return value === "banded-rows" || value === "banded-columns" || value === "booktabs"
    ? value
    : "default";
}

function normalizeCaptionPosition(value: unknown): StoredTableCaptionPosition {
  return value === "top" ? "top" : "bottom";
}

function normalizeCaptionAlign(value: unknown): StoredTableCaptionAlign {
  return value === "center" ? "center" : "left";
}

function tableSpanOverlaps(
  occupied: boolean[][],
  row: number,
  column: number,
  colspan: number,
  rowspan: number,
): boolean {
  for (let r = row; r < row + rowspan; r += 1) {
    for (let c = column; c < column + colspan; c += 1) {
      if (r === row && c === column) continue;
      if (occupied[r]?.[c]) return true;
    }
  }
  return false;
}

const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/u;
export const DEFAULT_TABLE_STROKE_WIDTH = 0.5;
export const DEFAULT_TABLE_STROKE_COLOR = "#000000";

function normalizeStrokeWidth(value: unknown): number {
  const width = numberOr(value, DEFAULT_TABLE_STROKE_WIDTH);
  return Math.max(0.1, Math.min(Math.round(width * 100) / 100, 10));
}

function normalizeStrokeColor(value: unknown): string {
  return typeof value === "string" && HEX_COLOR_PATTERN.test(value)
    ? value.toLowerCase()
    : DEFAULT_TABLE_STROKE_COLOR;
}

function normalizeBorderSide(value: unknown): StoredTableBorderSide {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = objectValue(value);
  return {
    enabled: record.enabled !== false,
    width: normalizeStrokeWidth(record.width),
    color: normalizeStrokeColor(record.color),
  };
}

function normalizeCellBorders(value: unknown): StoredTableCellBorders | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = objectValue(value);
  const borders: StoredTableCellBorders = {
    top: normalizeBorderSide(record.top),
    right: normalizeBorderSide(record.right),
    bottom: normalizeBorderSide(record.bottom),
    left: normalizeBorderSide(record.left),
  };
  return borders.top || borders.right || borders.bottom || borders.left ? borders : null;
}

function normalizeTables(value: unknown): StoredTable[] {
  if (!Array.isArray(value)) return [];
  const byId = new Map<string, StoredTable>();
  for (const item of value.slice(0, 200)) {
    const record = objectValue(item);
    const id = typeof record.id === "string" && TABLE_ID_PATTERN.test(record.id) ? record.id : null;
    if (!id || byId.has(id)) continue;
    const columns = Math.max(1, Math.min(Math.round(numberOr(record.columns, 1)), 32));
    const rawRows = Array.isArray(record.rows) ? record.rows.slice(0, 500) : [];
    const rowCount = Math.max(1, rawRows.length);
    const occupied: boolean[][] = Array.from({ length: rowCount }, () =>
      Array.from({ length: columns }, () => false));
    const rows: StoredTableCell[][] = [];
    for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
      const rawRow = Array.isArray(rawRows[rowIndex]) ? rawRows[rowIndex] as unknown[] : [];
      const row: StoredTableCell[] = [];
      for (let columnIndex = 0; columnIndex < columns; columnIndex += 1) {
        if (occupied[rowIndex][columnIndex]) {
          row.push({
            text: "",
            align: null,
            verticalAlign: null,
            emphasis: null,
            colspan: 1,
            rowspan: 1,
            covered: true,
            borders: null,
          });
          continue;
        }
        const cell = objectValue(rawRow[columnIndex]);
        let colspan = Math.max(1, Math.min(Math.round(numberOr(cell.colspan, 1)), columns - columnIndex));
        let rowspan = Math.max(1, Math.min(Math.round(numberOr(cell.rowspan, 1)), rowCount - rowIndex));
        while ((colspan > 1 || rowspan > 1) && tableSpanOverlaps(occupied, rowIndex, columnIndex, colspan, rowspan)) {
          if (colspan > 1) colspan -= 1;
          else rowspan -= 1;
        }
        for (let r = rowIndex; r < rowIndex + rowspan; r += 1) {
          for (let c = columnIndex; c < columnIndex + colspan; c += 1) occupied[r][c] = true;
        }
        row.push({
          text: typeof cell.text === "string" ? cell.text.slice(0, 2_000) : "",
          align: normalizeTableAlignment(cell.align),
          verticalAlign: normalizeTableVerticalAlignment(cell.verticalAlign),
          emphasis: normalizeTableEmphasis(cell.emphasis),
          colspan,
          rowspan,
          covered: false,
          borders: normalizeCellBorders(cell.borders),
        });
      }
      rows.push(row);
    }
    const name = typeof record.name === "string" && record.name.trim()
      ? record.name.trim().slice(0, 80)
      : id;
    byId.set(id, {
      id,
      name,
      columns,
      headerRow: record.headerRow !== false,
      headerColumn: record.headerColumn === true,
      stroke: record.stroke === "none" ? "none" : "solid",
      strokeWidth: normalizeStrokeWidth(record.strokeWidth),
      strokeColor: normalizeStrokeColor(record.strokeColor),
      style: normalizeTableStyle(record.style),
      caption: typeof record.caption === "string" ? record.caption.slice(0, 200) : "",
      captionPosition: normalizeCaptionPosition(record.captionPosition),
      captionAlign: normalizeCaptionAlign(record.captionAlign),
      rows,
    });
  }
  return [...byId.values()];
}

function normalizeProjectTerminology(value: unknown): TerminologyEntry[] {
  if (!Array.isArray(value)) return [];
  const entries = new Map<string, TerminologyEntry>();
  for (const item of value.slice(0, 2_000)) {
    const record = objectValue(item);
    const term = typeof record.term === "string" ? record.term.trim() : "";
    if (!term || term.length > 128 || /[\r\n\0]/.test(term)) continue;
    const exactCase = record.exactCase !== false;
    entries.set(`${exactCase ? "exact" : "fold"}:${term}`, { term, exactCase });
  }
  return [...entries.values()];
}
