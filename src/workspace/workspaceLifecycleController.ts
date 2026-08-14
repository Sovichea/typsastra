import { invoke } from "@tauri-apps/api/core";
import { confirm, message } from "@tauri-apps/plugin-dialog";
import { filePathKey } from "../platform/paths";
import { fileExtension, isBinaryImagePath, isSupportedInAppPath } from "../platform/fileTypes";
import { createTabEditorState } from "../editor/tabHistory";
import type { EditorFoldRange } from "../editor/folding";
import { parseDocumentScripts } from "../editor/documentTypography";
import type { ImportedTypsastraProject } from "../projectArchive";
import type { ToolchainStatus } from "../toolchain/toolchainController";
import { workspaceRestoreCandidates, type WorkspaceMetadata } from "./workspaceStateStore";
import type { EditorTab } from "../editor/editorTab";
import type { DocumentTypography } from "../editor/documentTypography";
import type { PreviewRenderMode } from "../settings";
import type { TerminologyEntry } from "../settings";
import type { Extension, StateEffect } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { LspStatus, TinymistLspClient } from "../compiler/lsp";

type ExamplesWorkspace = {
  workspacePath: string;
  entryPath: string;
};

type WorkspaceToolchain = { tinymistVersion: string; typstVersion: string };
type DeveloperLog = { kind: "log" | "info" | "warning" | "error"; source: string; message: string };

/** Mutable session state currently owned by the application composition root. */
export interface WorkspaceLifecycleSessionState {
  previewScrollTop: number;
  previewScrollSaveTimer: number | null;
  pinnedMainFilePath: string | null;
  pinnedLspMainPath: string | null;
  mainDocumentScripts: DocumentTypography["fonts"];
  workspaceRootPath: string | null;
  workspaceMetadata: WorkspaceMetadata | null;
  workspaceLoading: boolean;
  workspaceServicesDeferredForLargeFile: boolean;
  blockedLargePreviewRoot: string | null;
  recommendedWorkspaceToolchain: WorkspaceToolchain | null;
  selectedWorkspaceToolchain: WorkspaceToolchain | null;
  activeFilePath: string | null;
  openTabs: EditorTab[];
  lspReady: boolean;
  previewRootPath: string | null;
  previewMainPath: string | null;
  previewTaskId: string | null;
  previewSessionKey: string | null;
  previewImported: boolean;
  previewStandalone: boolean;
  previewDisabled: boolean;
  externalPreviewRefreshPending: boolean;
  lastPreviewRenderMode: PreviewRenderMode | undefined;
  isLoadingFile: boolean;
  editorExtensions: Extension;
  editorInstance: EditorView;
  lspClient: TinymistLspClient | null;
  approvedLargePreviewRoots: Set<string>;
  inspectedPreviewRoots: Set<string>;
  pdfPreviewGeneratedFiles: Map<string, unknown>;
  managedImageToolPathKeys: Set<string>;
  lspDocumentController: { resetSessionState(): void };
  externalConflictPaths: Set<string>;
  activeMode: "CODE" | "WYSIWYM";
}

/** Long-lived services used to carry out workspace lifecycle transitions. */
export interface WorkspaceLifecycleServices {
  previewFrame: {
    currentUrl: string | null;
    restoreWorkspaceScrollPosition(scrollTop: number): void;
    clear(): void;
  };
  pdfPreviewRenderController: {
    sourceMapTaskId: string | null;
    resetForWorkspaceClose(): void;
  };
  pdfPreviewPreparationController: {
    clearGeneratedFiles(): void;
  };
  layoutController: {
    setDockedInputWidthPct(width: number): void;
  };
  sidebarController: {
    activeTool: string;
    restore(state: { visible: boolean; activeTool: "explorer" | "images" }): void;
    reset(): void;
  };
  workspaceController: {
    absolutePath(root: string, path: string | null): Promise<string | null>;
    loadMetadata(root: string): Promise<WorkspaceMetadata>;
    startWatching(root: string): Promise<void>;
    stopWatching(): void;
  };
  settingsController: {
    value: {
      preview: { renderMode: PreviewRenderMode; lowMemoryMode: boolean };
      editor: {
        globalTerminology: TerminologyEntry[];
        languageTerminology: Record<string, TerminologyEntry[]>;
        scopedIgnoredWords: Record<string, TerminologyEntry[]>;
      };
    };
    setWorkspacePreviewRenderMode(mode: PreviewRenderMode | null, changed?: (mode: PreviewRenderMode) => void): void;
    setProjectTerminology(entries: TerminologyEntry[], changed: (entries: TerminologyEntry[]) => void): void;
  };
  draftPreviewController: { mode: unknown; setMode(mode: unknown, reason: string): void; reset(): void };
  spellcheckController: { setTerminology(global: TerminologyEntry[], project: TerminologyEntry[], language: Record<string, TerminologyEntry[]>, ignored: Record<string, TerminologyEntry[]>): void };
  explorer: {
    loadWorkspace(root: string, expanded?: string[]): Promise<void>;
    revealPath(path: string): Promise<void>;
    setActiveFile(path: string | null): void;
    clearWorkspace(): void;
  };
  imageToolsController: { setWorkspace(root: string | null, main: string | null): Promise<void>; show(): void };
  recentProjectsController: { add(path: string): void };
  editorFontManager: { ready(): Promise<void>; updateDocument(text: string): void };
  editorController: { updateCaretMarker(): void };
  editorToolbarController: { synchronizeDocumentTypography(config: DocumentTypography): void; setDisabled(disabled: boolean): void };
  toolchainController: { setStatus(status: ToolchainStatus): void };
  typographyController: { resetRuntime(): void };
  previewSyncController: { cancelManual(): void; clearForward(): void };
  sourceMapSessionController: { registeredTaskId: string | null; reset(): void };
  imagePreviewController: { clear(): void };
  documentOutlineController: { clear(): void };
  logConsoleController: { clearAllLogs(): void; setVisible(visible: boolean): void };
}

/** Application-level operations coordinated by workspace lifecycle transitions. */
export interface WorkspaceLifecycleOperations {
  activateEditorTab(path: string, persist?: boolean, options?: { skipPreviewActivation?: boolean }): Promise<void>;
  loadFile(path: string, options?: { skipPreviewActivation?: boolean }): Promise<void>;
  renderEditorTabs(): void;
  getActiveTab(): EditorTab | null;
  saveWorkspaceState(): Promise<void>;
  setPreviewRenderMode(mode: PreviewRenderMode): Promise<void>;
  ensureLargePreviewApproved(path: string): Promise<boolean>;
  preparePinnedMainTypography(path: string): Promise<DocumentTypography | null | false>;
  prepareRenderProjectIfNeeded(): Promise<void>;
  restartTinymistSession(message: string): Promise<void>;
  stopTinymistSession(message: string): Promise<void>;
  restoreActiveDocumentAfterTinymistRestart(): Promise<void>;
  setPinnedMainFile(path: string | null): Promise<void>;
  closeEditorTab(path: string, skipDirtyCheck?: boolean): Promise<void>;
  updateWorkspaceViewportVisibility(): void;
  appendDeveloperLog(entry: DeveloperLog): void;
  appendLspLog(entry: DeveloperLog): void;
  setLspStatus(status: LspStatus): void;
  updatePreviewActionsToolbar(path: string | null): void;
  clearPendingLspSync(): void;
  clearDiagnostics(): void;
  activateSpellcheckDocument(path: string | null): void;
  currentEditorSettingsEffects(): readonly StateEffect<unknown>[];
  applyFoldRanges(ranges: EditorFoldRange[]): void;
  mapMarkupToWysiwym(markup: string): void;
  finishEditorTextPresentation(path: string): void;
  restoreActiveNonTextPreview(): Promise<void>;
}

/**
 * Compatibility boundary used while lifecycle state moves out of the root.
 * Keeping the three concerns named prevents new dependencies from being added
 * to an undifferentiated application-shaped interface.
 */
export type WorkspaceLifecycleDependencies = WorkspaceLifecycleSessionState
  & WorkspaceLifecycleServices
  & WorkspaceLifecycleOperations;

/**
 * Owns the project lifecycle while the legacy root controller still supplies
 * the concrete UI and service ports. Keeping that bridge in one place lets
 * the root shed complete workflows without duplicating their state.
 */
export class WorkspaceLifecycleController {
  constructor(private readonly app: WorkspaceLifecycleDependencies) {}

  async restore(workspacePath: string, metadata: WorkspaceMetadata): Promise<void> {
    const app = this.app;
    try {
      const state = metadata.workspace;
      const project = metadata.project;
      app.previewScrollTop = state.previewScrollTop;
      app.previewFrame.restoreWorkspaceScrollPosition(state.previewScrollTop);
      const inputContainer = document.getElementById("input-container-wrapper");
      const previewContainerWrapper = document.getElementById("preview-container-wrapper");
      app.layoutController.setDockedInputWidthPct(state.layout.inputContainerWidthPct);
      inputContainer!.style.width = `${state.layout.inputContainerWidthPct}%`;
      if (previewContainerWrapper) {
        previewContainerWrapper.style.width = `${100 - state.layout.inputContainerWidthPct}%`;
      }
      app.sidebarController.restore({
        visible: state.layout.sidebarVisible,
        activeTool: state.layout.activeSidebarTool,
      });
      const pinnedMainFilePath = await app.workspaceController.absolutePath(workspacePath, project.mainFile);
      app.pinnedMainFilePath = pinnedMainFilePath
        && await invoke<boolean>("workspace_path_exists", { path: pinnedMainFilePath })
        ? pinnedMainFilePath
        : null;
      app.mainDocumentScripts = app.pinnedMainFilePath
        ? parseDocumentScripts(await invoke<string>("read_workspace_text_prefix", {
            path: app.pinnedMainFilePath,
            maxBytes: 65_536,
          }))
        : [];
      if (project.mainFile && !app.pinnedMainFilePath) metadata.project.mainFile = null;
      const explorerSidebar = document.getElementById("explorer-sidebar");
      if (explorerSidebar) explorerSidebar.style.width = `${state.layout.explorerSidebarWidthPx}px`;

      const restoredTabs = await Promise.all(state.openTabs.map(async tabInfo => ({
        tabInfo,
        path: await app.workspaceController.absolutePath(workspacePath, tabInfo.path),
      })));
      for (const { tabInfo, path } of restoredTabs) {
        if (!path) continue;
        if (app.openTabs.some(tab => filePathKey(tab.path) === filePathKey(path))) continue;
        app.openTabs.push({
          path,
          content: "",
          savedContent: "",
          contentLoaded: !isSupportedInAppPath(path),
          isDirty: false,
          previewRootPath: null,
          previewMainPath: null,
          previewTaskId: null,
          previewSessionKey: null,
          previewImported: false,
          previewStandalone: true,
          previewDisabled: false,
          version: 1,
          latestVersion: 1,
          selectionAnchor: tabInfo.selectionAnchor || 0,
          selectionHead: tabInfo.selectionHead || 0,
          scrollTop: tabInfo.scrollTop,
          scrollLeft: tabInfo.scrollLeft,
          previewScrollTop: tabInfo.previewScrollTop
            ?? (tabInfo.path === state.activeFile ? state.previewScrollTop : undefined),
          foldRanges: tabInfo.foldState === "user" && Array.isArray(tabInfo.foldRanges)
            ? tabInfo.foldRanges as EditorFoldRange[]
            : [],
          foldStateExplicit: tabInfo.foldState === "user",
        });
      }
      app.renderEditorTabs();

      if (app.openTabs.length === 0) {
        for (const candidate of workspaceRestoreCandidates(metadata)) {
          const path = await app.workspaceController.absolutePath(workspacePath, candidate);
          if (path && await invoke<boolean>("workspace_path_exists", { path })) {
            await app.loadFile(path, { skipPreviewActivation: true });
            return;
          }
        }
      }

      const activeFilePath = await app.workspaceController.absolutePath(workspacePath, state.activeFile);
      const preferredTab = activeFilePath
        ? app.openTabs.find(tab => filePathKey(tab.path) === filePathKey(activeFilePath))
        : null;
      const activationCandidates = preferredTab
        ? [preferredTab, ...app.openTabs.filter(tab => tab !== preferredTab)]
        : [...app.openTabs];
      for (const tab of activationCandidates) {
        try {
          await app.activateEditorTab(tab.path, false, { skipPreviewActivation: true });
          break;
        } catch (error) {
          console.warn("Failed to restore tab:", tab.path, error);
          app.openTabs = app.openTabs.filter(candidate => candidate !== tab);
          app.renderEditorTabs();
        }
      }
      if (!app.activeFilePath) {
        for (const candidate of workspaceRestoreCandidates(metadata)) {
          const path = await app.workspaceController.absolutePath(workspacePath, candidate);
          if (!path || app.openTabs.some(tab => filePathKey(tab.path) === filePathKey(path))) continue;
          if (!await invoke<boolean>("workspace_path_exists", { path })) continue;
          await app.loadFile(path, { skipPreviewActivation: true });
          if (app.activeFilePath) break;
        }
      }
    } catch (error) {
      console.warn("Failed to restore workspace state:", error);
      throw error;
    }
  }

  async open(selected: string): Promise<void> {
    const app = this.app;
    if (app.workspaceRootPath && filePathKey(app.workspaceRootPath) === filePathKey(selected)) {
      app.recentProjectsController.add(selected);
      return;
    }
    if (app.workspaceRootPath && app.workspaceRootPath !== selected) {
      const previousWorkspace = app.workspaceRootPath;
      try {
        const closed = await this.close();
        if (!closed) return;
      } catch (error) {
        // Closing releases workspace ownership before resetting the remaining
        // presentation state. A late UI-reset failure must not consume the
        // user's first attempt to open the replacement project. If ownership
        // was not released, however, continuing could mix two workspaces.
        if (app.workspaceRootPath !== null) throw error;
        console.warn(
          `Project teardown for ${previousWorkspace} completed with a non-critical cleanup error; continuing with ${selected}.`,
          error,
        );
      }
    }
    app.workspaceLoading = true;
    app.updateWorkspaceViewportVisibility();
    app.workspaceRootPath = selected;
    try {
      await invoke("cleanup_workspace_preview_files", { workspaceRootPath: selected });
      app.lspReady = false;
      app.workspaceMetadata = await app.workspaceController.loadMetadata(selected);
      app.workspaceMetadata.workspace.previewRenderMode ??= app.settingsController.value.preview.renderMode;
      app.settingsController.setWorkspacePreviewRenderMode(
        app.workspaceMetadata.workspace.previewRenderMode,
        mode => void app.setPreviewRenderMode(mode),
      );
      app.lastPreviewRenderMode = app.workspaceMetadata.workspace.previewRenderMode;
      app.draftPreviewController.setMode(app.workspaceMetadata.workspace.previewContentMode, "normal");
      app.spellcheckController.setTerminology(
        app.settingsController.value.editor.globalTerminology,
        app.workspaceMetadata.project.terminology,
        app.settingsController.value.editor.languageTerminology,
        app.settingsController.value.editor.scopedIgnoredWords,
      );
      app.settingsController.setProjectTerminology(
        app.workspaceMetadata.project.terminology,
        (entries: TerminologyEntry[]) => {
          if (!app.workspaceMetadata) return;
          app.workspaceMetadata.project.terminology = entries;
          app.spellcheckController.setTerminology(
            app.settingsController.value.editor.globalTerminology,
            entries,
            app.settingsController.value.editor.languageTerminology,
            app.settingsController.value.editor.scopedIgnoredWords,
          );
          void app.saveWorkspaceState();
        },
      );
      await this.restoreToolchain(app.workspaceMetadata);
      const expandedDirectories = (await Promise.all(
        app.workspaceMetadata.workspace.expandedDirectories.map((path: string) =>
          app.workspaceController.absolutePath(selected, path))
      )).filter((path: string | null): path is string => !!path);
      await app.explorer.loadWorkspace(selected, expandedDirectories);
      await this.restore(selected, app.workspaceMetadata);
      await app.imageToolsController.setWorkspace(selected, app.pinnedMainFilePath);
      if (app.sidebarController.activeTool === "images") app.imageToolsController.show();
      if (app.activeFilePath) await app.explorer.revealPath(app.activeFilePath);
      await app.saveWorkspaceState();
      await app.explorer.loadWorkspace(selected);
      await app.workspaceController.startWatching(selected);
      app.recentProjectsController.add(selected);
    } catch (error) {
      app.workspaceController.stopWatching();
      app.workspaceRootPath = null;
      app.workspaceMetadata = null;
      app.activeFilePath = null;
      app.pinnedMainFilePath = null;
      app.mainDocumentScripts = [];
      app.openTabs = [];
      app.explorer.setActiveFile(null);
      app.explorer.clearWorkspace();
      app.renderEditorTabs();
      await message(String(error), { title: "Unable to Open Project", kind: "error" });
      return;
    } finally {
      await app.editorFontManager.ready();
      app.workspaceLoading = false;
      app.updateWorkspaceViewportVisibility();
      await this.restoreStartupViewport();
    }
    void this.startServices(selected);
  }

  private async restoreStartupViewport(): Promise<void> {
    const app = this.app;
    const activeTab = app.getActiveTab();
    if (!activeTab || !app.activeFilePath) return;
    const activePath = activeTab.path;
    if (!activeTab.contentLoaded) {
      app.appendDeveloperLog({
        kind: "info",
        source: "editor syntax",
        message: `Startup viewport restoration deferred until guarded file confirmation: ` +
          `path=${activePath}; savedScroll=${(activeTab.scrollTop ?? 0).toFixed(1)}:` +
          `${(activeTab.scrollLeft ?? 0).toFixed(1)}.`,
      });
      return;
    }
    // Workspace restoration activates tabs with preview work suppressed so
    // stale content from the previous project cannot leak into the new one.
    // Once the workspace is visible, replay standalone non-text previews that
    // have no compiler-service startup phase of their own.
    if (isBinaryImagePath(activePath) || fileExtension(activePath) === "pdf") {
      await app.restoreActiveNonTextPreview();
      return;
    }
    const targetScrollTop = activeTab.scrollTop ?? 0;
    const targetScrollLeft = activeTab.scrollLeft ?? 0;
    const stillActive = () => !!app.activeFilePath
      && filePathKey(app.activeFilePath) === filePathKey(activePath);
    const viewportSnapshot = () => {
      const ranges = app.editorInstance.visibleRanges
        .map(range => `${range.from}:${range.to}`)
        .join(",") || "none";
      const scroll = app.editorInstance.scrollDOM;
      return `actualScroll=${scroll.scrollTop.toFixed(1)}:${scroll.scrollLeft.toFixed(1)}; ` +
        `viewport=${ranges}; scrollClient=${scroll.clientWidth}x${scroll.clientHeight}; ` +
        `editorRect=${app.editorInstance.dom.clientWidth}x${app.editorInstance.dom.clientHeight}`;
    };
    app.appendDeveloperLog({
      kind: "info",
      source: "editor syntax",
      message: `Startup viewport restoration started: path=${activePath}; ` +
        `targetScroll=${targetScrollTop.toFixed(1)}:${targetScrollLeft.toFixed(1)}; ${viewportSnapshot()}.`,
    });
    const nextFrame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    const restoreMeasuredViewport = (pass: number) => new Promise<void>(resolve => {
      app.editorInstance.requestMeasure({
        read: () => null,
        write: () => {
          if (stillActive()) {
            app.editorInstance.scrollDOM.scrollTop = targetScrollTop;
            app.editorInstance.scrollDOM.scrollLeft = targetScrollLeft;
          }
          app.appendDeveloperLog({
            kind: "info",
            source: "editor syntax",
            message: `Startup viewport restoration pass ${pass} written: path=${activePath}; ` +
              `stillActive=${stillActive()}; ${viewportSnapshot()}.`,
          });
          resolve();
        },
      });
    });

    // The editor was measured once while hidden during tab activation. Give
    // the now-visible workspace a frame, then restore twice across a complete
    // measure cycle. This makes CodeMirror's visibleRanges describe the saved
    // viewport before the syntax presentation gate starts parsing it.
    await nextFrame();
    await restoreMeasuredViewport(1);
    await nextFrame();
    await restoreMeasuredViewport(2);
    if (!stillActive()) {
      app.appendDeveloperLog({
        kind: "info",
        source: "editor syntax",
        message: `Startup viewport restoration abandoned because the active file changed: path=${activePath}.`,
      });
      return;
    }

    app.editorController.updateCaretMarker();
    app.appendDeveloperLog({
      kind: "info",
      source: "editor syntax",
      message: `Startup viewport restoration completed; releasing syntax presentation: ` +
        `path=${activePath}; ${viewportSnapshot()}.`,
    });
    app.finishEditorTextPresentation(activePath);
    if (activeTab.scrollTop !== undefined || activeTab.scrollLeft !== undefined) {
      app.appendDeveloperLog({
        kind: "info",
        source: "editor state",
        message: `Restored startup editor viewport: top=${targetScrollTop.toFixed(0)}, left=${targetScrollLeft.toFixed(0)}`,
      });
    }
  }

  async startServices(selected: string): Promise<void> {
    const app = this.app;
    try {
      if (app.workspaceRootPath !== selected || app.workspaceServicesDeferredForLargeFile) return;
      if (app.pinnedMainFilePath && !await app.ensureLargePreviewApproved(app.pinnedMainFilePath)) return;
      app.workspaceServicesDeferredForLargeFile = false;
      if (app.pinnedMainFilePath) {
        const typography = await app.preparePinnedMainTypography(app.pinnedMainFilePath);
        if (app.workspaceRootPath !== selected) return;
        if (typography === false) {
          await invoke<boolean>("clear_scaled_workspace_fonts", { workspaceRootPath: selected });
          app.pinnedMainFilePath = null;
          app.mainDocumentScripts = [];
          await app.saveWorkspaceState();
        } else if (typography) {
          app.editorToolbarController.synchronizeDocumentTypography(typography);
        }
      }
      await app.prepareRenderProjectIfNeeded();
      if (app.workspaceRootPath !== selected) return;
      if (app.settingsController.value.preview.lowMemoryMode) {
        await app.stopTinymistSession("Low memory mode: using one-shot compiler on save");
        return;
      }
      if (app.lspClient) {
        try {
          await app.restartTinymistSession("Connecting to new project...");
          if (app.workspaceRootPath !== selected) return;
        } catch (error) {
          if (app.workspaceRootPath !== selected) return;
          app.lspReady = false;
          app.appendDeveloperLog({
            kind: "error",
            source: "lsp",
            message: `Failed to restart Tinymist for workspace ${selected}: ${String(error)}`,
          });
        }
      }
      if (app.workspaceRootPath === selected && app.activeFilePath) {
        await app.restoreActiveDocumentAfterTinymistRestart();
      }
    } catch (error) {
      if (app.workspaceRootPath === selected) {
        app.appendDeveloperLog({
          kind: "error",
          source: "workspace",
          message: `Workspace services failed to start: ${String(error)}`,
        });
      }
    }
  }

  async restoreToolchain(metadata: WorkspaceMetadata): Promise<void> {
    const app = this.app;
    app.recommendedWorkspaceToolchain = metadata.project.recommendedToolchain;
    app.selectedWorkspaceToolchain = metadata.workspace.selectedToolchain;
    if (!app.selectedWorkspaceToolchain) return;
    try {
      const status = await invoke<ToolchainStatus>("select_project_toolchain", {
        tinymistVersion: app.selectedWorkspaceToolchain.tinymistVersion,
        typstVersion: app.selectedWorkspaceToolchain.typstVersion,
      });
      app.toolchainController.setStatus(status);
    } catch (error) {
      app.appendDeveloperLog({
        kind: "warning",
        source: "toolchain",
        message: `Could not restore this workspace's selected toolchain: ${String(error)}`,
      });
    }
  }

  async completeImport(imported: ImportedTypsastraProject, projectName: string): Promise<boolean> {
    const app = this.app;
    await this.open(imported.workspacePath);
    const activeToolchain = await invoke<ToolchainStatus>("get_toolchain_status").catch(() => null);
    app.recommendedWorkspaceToolchain = {
      tinymistVersion: imported.manifest.toolchain.tinymistVersion,
      typstVersion: imported.manifest.toolchain.typstVersion,
    };
    app.selectedWorkspaceToolchain = activeToolchain?.tinymistVersion && activeToolchain.typstVersion
      ? { tinymistVersion: activeToolchain.tinymistVersion, typstVersion: activeToolchain.typstVersion }
      : null;
    if (!app.workspaceRootPath || filePathKey(app.workspaceRootPath) !== filePathKey(imported.workspacePath)) {
      return false;
    }
    await app.setPinnedMainFile(imported.mainFilePath);
    await app.saveWorkspaceState();
    app.setLspStatus({ kind: "preview-ready", message: `Imported ${projectName}` });
    return true;
  }

  async closeOtherTabs(pathToKeep: string): Promise<void> {
    const app = this.app;
    const tabsToClose = app.openTabs.filter(tab => tab.path !== pathToKeep);
    for (const tab of tabsToClose) await app.closeEditorTab(tab.path, false);
  }

  async restart(): Promise<void> {
    const app = this.app;
    if (!app.workspaceRootPath) return;
    const currentWorkspace = app.workspaceRootPath;
    await this.close({ confirmUnsaved: false });
    await this.open(currentWorkspace);
  }

  async openExamples(): Promise<void> {
    const app = this.app;
    const button = document.getElementById("welcome-open-examples") as HTMLButtonElement | null;
    if (button) button.disabled = true;
    try {
      const examples = await invoke<ExamplesWorkspace>("prepare_examples_workspace");
      await this.open(examples.workspacePath);
      await app.loadFile(examples.entryPath);
    } catch (error) {
      app.appendLspLog({ kind: "error", source: "examples", message: `Failed to open examples: ${String(error)}` });
      await message(String(error), { title: "Unable to open examples", kind: "error" });
    } finally {
      if (button) button.disabled = false;
    }
  }

  async close(options: { confirmUnsaved?: boolean } = {}): Promise<boolean> {
    const app = this.app;
    const confirmUnsaved = options.confirmUnsaved ?? true;
    if (confirmUnsaved && app.openTabs.some(tab => tab.isDirty)) {
      const shouldClose = await confirm(
        "Close this project with unsaved changes? The editor state will be kept for session recovery, but the files are not saved to disk.",
        { title: "Unsaved Changes", kind: "warning" },
      );
      if (!shouldClose) return false;
    }

    // Retire the visible document before any asynchronous persistence or
    // compiler teardown. In particular, project replacement must never leave
    // the previous project's PDF visible while the new workspace starts.
    app.previewFrame.clear();
    await app.saveWorkspaceState();
    app.workspaceController.stopWatching();
    const previewTaskIds = new Set([
      app.previewTaskId,
      app.pdfPreviewRenderController.sourceMapTaskId,
      app.sourceMapSessionController.registeredTaskId,
    ].filter((taskId: string | null): taskId is string => Boolean(taskId)));
    if (app.lspClient) {
      for (const taskId of previewTaskIds) void app.lspClient.stopPreview(taskId).catch(() => {});
    }
    try {
      await app.stopTinymistSession("Project closed");
    } catch (error) {
      app.appendDeveloperLog({
        kind: "warning",
        source: "lsp",
        message: `Tinymist did not stop cleanly while closing the project: ${String(error)}`,
      });
    }

    app.pdfPreviewRenderController.resetForWorkspaceClose();
    app.pdfPreviewPreparationController.clearGeneratedFiles();
    app.typographyController.resetRuntime();
    app.approvedLargePreviewRoots.clear();
    app.inspectedPreviewRoots.clear();
    app.blockedLargePreviewRoot = null;
    app.draftPreviewController.reset();
    app.previewScrollTop = 0;
    if (app.previewScrollSaveTimer !== null) window.clearTimeout(app.previewScrollSaveTimer);
    app.previewScrollSaveTimer = null;
    app.previewSyncController.cancelManual();

    app.workspaceRootPath = null;
    app.sidebarController.reset();
    document.body.classList.remove("image-tools-active");
    void app.imageToolsController.setWorkspace(null, null);
    app.workspaceMetadata = null;
    app.settingsController.setWorkspacePreviewRenderMode(null);
    app.lastPreviewRenderMode = app.settingsController.value.preview.renderMode;
    app.workspaceLoading = false;
    app.recommendedWorkspaceToolchain = null;
    app.selectedWorkspaceToolchain = null;
    app.activeFilePath = null;
    app.explorer.setActiveFile(null);
    app.openTabs = [];
    app.pinnedMainFilePath = null;
    app.mainDocumentScripts = [];
    app.pinnedLspMainPath = null;
    app.previewRootPath = null;
    app.previewMainPath = null;
    app.previewTaskId = null;
    app.previewSessionKey = null;
    app.previewImported = false;
    app.previewStandalone = true;
    app.previewDisabled = false;
    app.managedImageToolPathKeys.clear();
    app.sourceMapSessionController.reset();
    app.externalPreviewRefreshPending = false;
    app.imagePreviewController.clear();
    app.updatePreviewActionsToolbar(null);
    app.lspDocumentController.resetSessionState();
    app.externalConflictPaths.clear();
    app.clearPendingLspSync();
    app.previewSyncController.clearForward();
    app.clearDiagnostics();
    app.logConsoleController.clearAllLogs();
    app.logConsoleController.setVisible(false);

    app.isLoadingFile = true;
    try {
      app.editorInstance.setState(createTabEditorState({
        doc: "",
        anchor: 0,
        head: 0,
        extensions: app.editorExtensions,
      }));
      app.editorInstance.dispatch({ effects: app.currentEditorSettingsEffects() });
      app.applyFoldRanges([]);
    } finally {
      app.isLoadingFile = false;
    }
    app.activateSpellcheckDocument(null);
    app.editorFontManager.updateDocument("");
    app.editorToolbarController.setDisabled(true);
    if (app.activeMode === "WYSIWYM") app.mapMarkupToWysiwym("");
    app.explorer.clearWorkspace();
    app.documentOutlineController.clear();
    app.renderEditorTabs();
    app.setLspStatus({ kind: "stopped", message: "Project closed" });
    app.updateWorkspaceViewportVisibility();
    return true;
  }
}
