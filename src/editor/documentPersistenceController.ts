import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import type { LspStatus } from "../compiler/lsp";
import { fileExtension, isBinaryImagePath, isTypstDocumentPath } from "../platform/fileTypes";
import { filePathKey } from "../platform/paths";
import type { EditorTab } from "./editorTab";

export type SaveIntent = "manual" | "automatic";

type DocumentPersistenceDependencies = {
  activeFilePath: () => string | null;
  activeMode: () => "CODE" | "WYSIWYM";
  workspaceRootPath: () => string | null;
  openTabs: () => EditorTab[];
  isInternallySupportedPath: (path: string) => boolean;
  flushEditorContentMutation: () => void;
  formatOnSave: () => boolean;
  autoSaveSettings: () => { enabled: boolean; intervalSeconds: number };
  formatActiveDocument: (options?: { silent?: boolean }) => Promise<boolean>;
  removeTrailingSpaces: () => void;
  editorText: () => string;
  wysiwymMarkup: () => string;
  isPinnedMainFile: (path: string) => boolean;
  refreshWorkspaceExplorer: (workspaceRootPath: string) => Promise<void>;
  loadFile: (path: string) => Promise<void>;
  setPinnedMainFile: (path: string | null) => Promise<void>;
  lspReady: () => boolean;
  flushPendingLspSync: () => Promise<void>;
  notifyLspSave: (path: string, content: string) => Promise<void>;
  logMemoryDiagnostics: (reason: string) => Promise<void>;
  clearExternalConflict: (path: string) => void;
  renderEditorTabs: () => void;
  refreshPreviewAfterManualSave: (path: string, content: string) => Promise<void>;
  setLspStatus: (status: LspStatus) => void;
  log: (kind: "info" | "error", source: string, message: string) => void;
};

export class DocumentPersistenceController {
  private saveInProgress: Promise<void> | null = null;
  private saveInProgressIntent: SaveIntent | null = null;
  private autoSaveTimer: number | null = null;
  private saveMemoryDiagnosticGeneration = 0;

  constructor(private readonly deps: DocumentPersistenceDependencies) {}

  async saveActiveFile(intent: SaveIntent = "manual"): Promise<void> {
    if (this.saveInProgress) {
      const inProgressIntent = this.saveInProgressIntent;
      await this.saveInProgress;
      if (intent === "manual" && inProgressIntent === "automatic") {
        await this.saveActiveFile("manual");
      }
      return;
    }
    this.deps.flushEditorContentMutation();
    const operation = this.performSaveActiveFile(intent);
    this.saveInProgress = operation;
    this.saveInProgressIntent = intent;
    try {
      await operation;
    } finally {
      if (this.saveInProgress === operation) {
        this.saveInProgress = null;
        this.saveInProgressIntent = null;
      }
    }
  }

  configureAutoSave(enabled: boolean, intervalSeconds: number): void {
    if (this.autoSaveTimer !== null) window.clearTimeout(this.autoSaveTimer);
    this.autoSaveTimer = null;
    if (!enabled) return;
    this.autoSaveTimer = window.setTimeout(() => {
      this.autoSaveTimer = null;
      void this.runAutoSaveCycle().finally(() => {
        const settings = this.deps.autoSaveSettings();
        this.configureAutoSave(settings.enabled, settings.intervalSeconds);
      });
    }, intervalSeconds * 1000);
  }

  async saveActiveFileAs(): Promise<void> {
    const activeFilePath = this.deps.activeFilePath();
    if (!activeFilePath || !this.canPersistPath(activeFilePath)) return;

    const sourceWasPinnedMain = this.deps.isPinnedMainFile(activeFilePath);
    const extension = fileExtension(activeFilePath);
    const savePath = await save({
      defaultPath: activeFilePath,
      filters: extension ? [{ name: `${extension.toUpperCase()} File`, extensions: [extension] }] : undefined
    });
    if (typeof savePath !== "string") return;
    if (filePathKey(savePath) === filePathKey(activeFilePath)) {
      await this.saveActiveFile();
      return;
    }

    try {
      if (this.deps.activeMode() === "CODE" && this.deps.formatOnSave()) {
        await this.deps.formatActiveDocument({ silent: true });
        this.deps.removeTrailingSpaces();
      }
      const content = this.currentContent();
      await invoke("save_workspace_file", { path: savePath, contents: content });
      const workspaceRootPath = this.deps.workspaceRootPath();
      if (workspaceRootPath) await this.deps.refreshWorkspaceExplorer(workspaceRootPath);
      await this.deps.loadFile(savePath);
      if (sourceWasPinnedMain && isTypstDocumentPath(savePath)) {
        await this.deps.setPinnedMainFile(savePath);
      }
      this.deps.setLspStatus({ kind: "preview-ready", message: "File saved as a new document" });
    } catch (error) {
      const failure = `Save As failed: ${String(error)}`;
      console.error(failure);
      this.deps.setLspStatus({ kind: "error", message: failure });
      alert(failure);
    }
  }

  private async runAutoSaveCycle(): Promise<void> {
    if (this.saveInProgress || !this.deps.workspaceRootPath()) return;
    this.deps.flushEditorContentMutation();
    const dirtyTabs = this.deps.openTabs().filter(tab =>
      tab.contentLoaded
      && tab.isDirty
      && this.canPersistPath(tab.path)
    );
    if (dirtyTabs.length === 0) return;

    const operation = this.performAutoSave(dirtyTabs);
    this.saveInProgress = operation;
    this.saveInProgressIntent = "automatic";
    try {
      await operation;
    } finally {
      if (this.saveInProgress === operation) {
        this.saveInProgress = null;
        this.saveInProgressIntent = null;
      }
    }
  }

  private async performAutoSave(tabs: EditorTab[]): Promise<void> {
    let savedCount = 0;
    try {
      for (const tab of tabs) {
        const content = tab.content;
        await invoke("save_workspace_file", { path: tab.path, contents: content });
        if (tab.content !== content) continue;
        tab.savedContent = content;
        tab.isDirty = false;
        this.deps.clearExternalConflict(tab.path);
        savedCount += 1;
      }
    } catch (error) {
      const message = `Auto-save failed: ${String(error)}`;
      console.error(message);
      this.deps.setLspStatus({ kind: "error", message });
    } finally {
      if (savedCount > 0) {
        this.deps.renderEditorTabs();
        this.deps.log(
          "info",
          "workspace",
          `Auto-saved ${savedCount} file${savedCount === 1 ? "" : "s"} without requesting preview compilation.`,
        );
      }
    }
  }

  private async performSaveActiveFile(intent: SaveIntent): Promise<void> {
    const activeFilePath = this.deps.activeFilePath();
    if (!activeFilePath || !this.canPersistPath(activeFilePath)) return;

    try {
      const saveDiagnosticId = ++this.saveMemoryDiagnosticGeneration;
      await this.deps.logMemoryDiagnostics(`save ${saveDiagnosticId}: before write`);
      if (intent === "manual" && this.deps.activeMode() === "CODE" && this.deps.formatOnSave()) {
        await this.deps.formatActiveDocument({ silent: true });
        this.deps.removeTrailingSpaces();
      }

      const content = this.currentContent();
      await invoke("save_workspace_file", { path: activeFilePath, contents: content });
      await this.deps.logMemoryDiagnostics(`save ${saveDiagnosticId}: after workspace write`);

      if (intent === "manual" && this.deps.lspReady()) {
        await this.deps.flushPendingLspSync();
        await this.deps.notifyLspSave(activeFilePath, content);
      }
      await this.deps.logMemoryDiagnostics(`save ${saveDiagnosticId}: after LSP save notification`);

      const activeTab = this.deps.openTabs().find(tab => filePathKey(tab.path) === filePathKey(activeFilePath)) ?? null;
      if (activeTab) {
        activeTab.content = content;
        activeTab.savedContent = content;
        activeTab.isDirty = false;
        this.deps.clearExternalConflict(activeTab.path);
        this.deps.renderEditorTabs();
      }
      this.deps.setLspStatus({ kind: "preview-ready", message: "File saved" });
      if (intent === "manual" && isTypstDocumentPath(activeFilePath)) {
        // Saving has already succeeded. Start preview refresh separately so a
        // compiler/indexing failure is reported by the preview without
        // incorrectly presenting the successful file write as a save failure.
        void this.deps.refreshPreviewAfterManualSave(activeFilePath, content).catch(error => {
          this.deps.log("error", "preview scheduler", `Preview refresh after save failed: ${String(error)}`);
        });
      }
    } catch (error) {
      const message = `Save failed: ${String(error)}`;
      console.error(message);
      this.deps.setLspStatus({ kind: "error", message });
      alert(message);
    }
  }

  private canPersistPath(path: string): boolean {
    return this.deps.isInternallySupportedPath(path)
      && !isBinaryImagePath(path)
      && fileExtension(path) !== "pdf";
  }

  private currentContent(): string {
    return this.deps.activeMode() === "WYSIWYM"
      ? this.deps.wysiwymMarkup()
      : this.deps.editorText();
  }
}
