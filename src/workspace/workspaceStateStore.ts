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
  foldState?: "user" | null;
  foldRanges?: unknown[] | null;
};

export type StoredProjectState = {
  schemaVersion: 2;
  projectId: string;
  mainFile: string | null;
  recommendedToolchain: StoredWorkspaceToolchain | null;
  terminology: TerminologyEntry[];
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
    activeSidebarTool: "explorer" | "images" | "fonts";
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
      terminology: normalizeProjectTerminology(project.terminology)
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
          : layout.activeSidebarTool === "fonts" ? "fonts" : "explorer"
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
