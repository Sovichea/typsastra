import { join } from "@tauri-apps/api/path";
import type { PreviewRenderMode } from "../settings";
import type { EditorFoldRange } from "../editor/folding";
import { relativeFilePath } from "../platform/paths";
import { workspaceViewportState } from "./workspaceVisibility";
import { WorkspaceWatcher, type WorkspaceChange } from "./workspaceWatcher";
import {
  normalizeWorkspaceMetadata,
  WorkspaceStateStore,
  type LegacyWorkspaceState,
  type WorkspaceMetadata,
} from "./workspaceStateStore";

export interface WorkspacePersistenceTab {
  path: string;
  selectionAnchor: number;
  selectionHead: number;
  scrollTop?: number;
  scrollLeft?: number;
  previewScrollTop?: number;
  foldStateExplicit: boolean;
  foldRanges: EditorFoldRange[] | null;
}

export interface WorkspacePersistenceSnapshot {
  rootPath: string | null;
  metadata: WorkspaceMetadata | null;
  activeFilePath: string | null;
  pinnedMainFilePath: string | null;
  recommendedToolchain: { tinymistVersion: string; typstVersion: string } | null;
  selectedToolchain: { tinymistVersion: string; typstVersion: string } | null;
  openTabs: readonly WorkspacePersistenceTab[];
  expandedDirectories: readonly string[];
  inputContainerWidthPct: number;
  explorerSidebarWidthPx: number;
  sidebarVisible: boolean;
  activeSidebarTool: "explorer" | "images" | "tables";
  previewContentMode: "normal" | "draft";
  previewRenderMode: PreviewRenderMode;
  previewScrollTop: number;
}

export interface WorkspaceViewportInput {
  activeFilePath: string | null;
  workspaceRootPath: string | null;
  loading: boolean;
}

export interface WorkspaceControllerPort {
  dockPreview(): void;
  applySidebarVisibility(): void;
  pathKey(path: string): string;
  handleWorkspaceChange(change: WorkspaceChange): Promise<void>;
  reportWatchError(error: unknown): void;
  persistActiveTabState(): void;
  persistenceSnapshot(): WorkspacePersistenceSnapshot;
  setWorkspaceMetadata(metadata: WorkspaceMetadata): void;
  reportPersistenceError(error: unknown): void;
}

/** Owns workspace-level viewport transitions and their DOM projection. */
export class WorkspaceController {
  private readonly watcher: WorkspaceWatcher;
  private readonly stateStore = new WorkspaceStateStore();
  private readonly pendingChanges = new Map<string, WorkspaceChange>();
  private changeDrainRunning = false;

  constructor(private readonly port: WorkspaceControllerPort) {
    this.watcher = new WorkspaceWatcher(
      change => this.enqueueChange(change),
      error => this.port.reportWatchError(error),
    );
  }

  startWatching(rootPath: string): Promise<void> {
    return this.watcher.start(rootPath);
  }

  stopWatching(): void {
    this.watcher.stop();
    this.pendingChanges.clear();
  }

  saveState(): Promise<void> {
    const snapshot = this.port.persistenceSnapshot();
    if (!snapshot.rootPath || !snapshot.metadata) return Promise.resolve();
    this.port.persistActiveTabState();
    const current = this.port.persistenceSnapshot();
    if (!current.rootPath || !current.metadata) return Promise.resolve();
    const relative = (path: string | null): string | null => path
      ? relativeFilePath(current.rootPath!, path)?.replace(/\\/g, "/") ?? null
      : null;
    const metadata: WorkspaceMetadata = {
      project: {
        ...current.metadata.project,
        mainFile: relative(current.pinnedMainFilePath),
        recommendedToolchain: current.recommendedToolchain,
      },
      workspace: {
        schemaVersion: 2,
        activeFile: relative(current.activeFilePath),
        openTabs: current.openTabs.flatMap(tab => {
          const path = relative(tab.path);
          return path ? [{
            path,
            selectionAnchor: tab.selectionAnchor,
            selectionHead: tab.selectionHead,
            scrollTop: tab.scrollTop,
            scrollLeft: tab.scrollLeft,
            previewScrollTop: tab.previewScrollTop,
            foldState: tab.foldStateExplicit ? "user" as const : null,
            foldRanges: tab.foldStateExplicit ? tab.foldRanges : null,
          }] : [];
        }),
        expandedDirectories: current.expandedDirectories.flatMap(path => {
          const directory = relative(path);
          return directory ? [directory] : [];
        }),
        layout: {
          inputContainerWidthPct: current.inputContainerWidthPct,
          explorerSidebarWidthPx: current.explorerSidebarWidthPx,
          sidebarVisible: current.sidebarVisible,
          activeSidebarTool: current.activeSidebarTool,
        },
        selectedToolchain: current.selectedToolchain,
        previewContentMode: current.previewContentMode,
        previewRenderMode: current.previewRenderMode,
        previewScrollTop: current.previewScrollTop,
      },
    };
    this.port.setWorkspaceMetadata(metadata);
    return this.stateStore.save(current.rootPath, metadata).catch(error => {
      this.port.reportPersistenceError(error);
    });
  }

  async loadMetadata(workspacePath: string): Promise<WorkspaceMetadata> {
    const stored = await this.stateStore.load(workspacePath);
    if (stored) return stored;
    const legacy = this.stateStore.loadLegacy(workspacePath);
    const metadata = legacy
      ? this.migrateLegacyState(workspacePath, legacy)
      : normalizeWorkspaceMetadata({ project: null, workspace: null });
    await this.stateStore.save(workspacePath, metadata);
    if (legacy) this.stateStore.removeLegacy(workspacePath);
    return metadata;
  }

  absolutePath(workspacePath: string, relativePath: string | null): Promise<string | null> {
    return relativePath ? join(workspacePath, relativePath) : Promise.resolve(null);
  }

  private migrateLegacyState(
    workspacePath: string,
    legacy: LegacyWorkspaceState,
  ): WorkspaceMetadata {
    const relative = (path: string | null): string | null => path
      ? relativeFilePath(workspacePath, path)?.replace(/\\/g, "/") ?? null
      : null;
    const metadata = normalizeWorkspaceMetadata({ project: null, workspace: null });
    metadata.project.mainFile = relative(legacy.pinnedMainFilePath);
    metadata.project.recommendedToolchain = legacy.recommendedToolchain;
    metadata.workspace.activeFile = relative(legacy.activeFilePath);
    metadata.workspace.openTabs = legacy.openTabs.flatMap(tab => {
      const path = relative(tab.path);
      return path ? [{ ...tab, path }] : [];
    });
    metadata.workspace.expandedDirectories = [];
    metadata.workspace.layout = {
      inputContainerWidthPct: legacy.inputContainerWidthPct,
      explorerSidebarWidthPx: legacy.explorerSidebarWidthPx,
      sidebarVisible: true,
      activeSidebarTool: "explorer",
    };
    metadata.workspace.selectedToolchain = legacy.selectedToolchain;
    return metadata;
  }

  public updateViewport(input: WorkspaceViewportInput): void {
    const welcomeScreen = document.getElementById("welcome-screen");
    const inputWrapper = document.getElementById("input-container-wrapper");
    const previewWrapper = document.getElementById("preview-container-wrapper");
    const resizer = document.getElementById("editor-preview-resizer");
    const explorerSidebar = document.getElementById("explorer-sidebar");
    const explorerResizer = document.getElementById("explorer-resizer");
    const sidebarActivityBar = document.getElementById("sidebar-activity-bar");
    const appMenus = document.getElementById("app-menus");
    const loading = document.getElementById("workspace-loading");
    const statusBar = document.getElementById("status-bar");
    const viewport = workspaceViewportState(
      input.activeFilePath,
      input.workspaceRootPath,
      input.loading,
    );

    loading?.classList.toggle("hidden", !viewport.showLoading);
    statusBar?.classList.toggle("welcome-screen-active", viewport.showWelcome);
    welcomeScreen?.classList.toggle("hidden", !viewport.showWelcome);

    inputWrapper?.classList.toggle("hidden", !viewport.showEditor);
    previewWrapper?.classList.toggle("hidden", !viewport.showEditor);
    resizer?.classList.toggle("hidden", !viewport.showEditor);
    if (viewport.showEditor) this.port.dockPreview();

    if (viewport.showWorkspaceChrome) {
      sidebarActivityBar?.classList.remove("hidden");
      this.port.applySidebarVisibility();
      appMenus?.classList.remove("hidden");
      return;
    }

    explorerSidebar?.classList.add("hidden");
    explorerResizer?.classList.add("hidden");
    sidebarActivityBar?.classList.add("hidden");
    appMenus?.classList.add("hidden");
  }

  private enqueueChange(change: WorkspaceChange): void {
    const batchKey = `${this.port.pathKey(change.rootPath)}\u0000${change.kind}`;
    // Preserve the old/new pairing of independent rename events. Repeated
    // notifications for the same rename still collapse to one batch.
    const key = change.kind === "rename"
      ? `${batchKey}\u0000${change.paths.map(path => this.port.pathKey(path)).join("\u0000")}`
      : batchKey;
    const pending = this.pendingChanges.get(key);
    if (pending) {
      pending.paths = [...new Set([...pending.paths, ...change.paths])];
    } else {
      this.pendingChanges.set(key, {
        rootPath: change.rootPath,
        kind: change.kind,
        paths: [...new Set(change.paths)],
      });
    }
    if (!this.changeDrainRunning) void this.drainChanges();
  }

  private async drainChanges(): Promise<void> {
    if (this.changeDrainRunning) return;
    this.changeDrainRunning = true;
    try {
      while (this.pendingChanges.size > 0) {
        const changes = [...this.pendingChanges.values()];
        this.pendingChanges.clear();
        for (const change of changes) {
          try {
            await this.port.handleWorkspaceChange(change);
          } catch (error) {
            this.port.reportWatchError(error);
          }
        }
      }
    } finally {
      this.changeDrainRunning = false;
      if (this.pendingChanges.size > 0) void this.drainChanges();
    }
  }
}
