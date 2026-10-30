import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import type { LspStatus } from "../compiler/lsp";
import { fileExtension, isBinaryImagePath, isTypstDocumentPath } from "../platform/fileTypes";
import { filePathKey, isUntitledDocumentPath } from "../platform/paths";
import type { PreviewRenderMode } from "../settings";
import type { EditorTab } from "./editorTab";
import { t } from "../i18n";

export type SaveIntent = "manual" | "automatic";

type DocumentPersistenceDependencies = {
  activeFilePath: () => string | null;
  activeMode: () => "CODE" | "WYSIWYM";
  previewRenderMode: () => PreviewRenderMode;
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
  autoSaveAllowed: () => boolean;
  activeTab: () => EditorTab | null;
  saveUntitledDocumentAs: () => Promise<void>;
  cachePreviewAfterSave: () => Promise<void> | void;
  recoveryRevision: (tab: EditorTab) => number;
  recoverySaved: (tab: EditorTab, revision: number) => Promise<void> | void;
  renderEditorTabs: () => void;
  refreshPreviewAfterSave: (path: string, content: string) => Promise<void>;
  setLspStatus: (status: LspStatus) => void;
  log: (kind: "info" | "error", source: string, message: string) => void;
};

export class DocumentPersistenceController {
  private saveInProgress: Promise<void> | null = null;
  private saveInProgressIntent: SaveIntent | null = null;
  private autoSaveTimer: number | null = null;
  private saveMemoryDiagnosticGeneration = 0;

  constructor(private readonly deps: DocumentPersistenceDependencies) {}

  get isSaving(): boolean { return this.saveInProgress !== null; }

  async saveActiveFile(intent: SaveIntent = "manual"): Promise<void> {
    if (this.saveInProgress) {
      const inProgressIntent = this.saveInProgressIntent;
      await this.saveInProgress;
      if (intent === "manual" && inProgressIntent === "automatic") {
        await this.saveActiveFile("manual");
      }
      return;
    }
    if (this.deps.activeTab()?.untitled) {
      await this.deps.saveUntitledDocumentAs();
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
    if (this.deps.activeTab()?.untitled) {
      await this.deps.saveUntitledDocumentAs();
      return;
    }
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
      this.deps.setLspStatus({ kind: "preview-ready", message: t("File saved as a new document") });
    } catch (error) {
      const failure = `Save As failed: ${String(error)}`;
      console.error(failure);
      this.deps.setLspStatus({ kind: "error", message: failure });
      alert(failure);
    }
  }

  private async runAutoSaveCycle(): Promise<void> {
    if (this.saveInProgress || !this.deps.workspaceRootPath() || !this.deps.autoSaveAllowed()) return;
    this.deps.flushEditorContentMutation();
    const dirtyTabs = this.deps.openTabs().filter(tab =>
      tab.contentLoaded
      && tab.isDirty
      && !tab.untitled
      && !tab.recoveredUnsaved
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
    const savedTabs: EditorTab[] = [];
    try {
      for (const tab of tabs) {
        const content = tab.content;
        const recoveryRevision = this.deps.recoveryRevision(tab);
        await invoke("save_workspace_file", { path: tab.path, contents: content });
        if (tab.content !== content) continue;
        tab.savedContent = content;
        tab.isDirty = false;
        tab.recoveredUnsaved = undefined;
        tab.externalContent = undefined;
        this.deps.clearExternalConflict(tab.path);
        await this.deps.recoverySaved(tab, recoveryRevision);
        savedTabs.push(tab);
      }
    } catch (error) {
      const message = `Auto-save failed: ${String(error)}`;
      console.error(message);
      this.deps.setLspStatus({ kind: "error", message });
    } finally {
      if (savedTabs.length > 0) {
        this.deps.renderEditorTabs();
        this.deps.log(
          "info",
          "workspace",
          `Auto-saved ${savedTabs.length} file${savedTabs.length === 1 ? "" : "s"}.`,
        );
        const activePath = this.deps.activeFilePath();
        const activeTab = this.deps.openTabs().find(tab => activePath && filePathKey(tab.path) === filePathKey(activePath));
        if (activeTab && isTypstDocumentPath(activeTab.path) && this.deps.previewRenderMode() === "on-save") {
          const ownerKey = filePathKey(activeTab.previewMainPath ?? activeTab.previewRootPath ?? activeTab.path);
          const savedSources = savedTabs.filter(tab => isTypstDocumentPath(tab.path)
            && !tab.previewDisabled
            && filePathKey(tab.previewMainPath ?? tab.previewRootPath ?? tab.path) === ownerKey);
          if (savedSources.length > 0) {
            // Compile once after the entire batch, including inactive includes.
            const savedContents = savedSources.map(tab => ({ tab, content: tab.content }));
            void this.deps.refreshPreviewAfterSave(activeTab.path, this.currentContent()).then(() => {
              for (const saved of savedContents) {
                if (saved.tab.content === saved.content) saved.tab.externalPreviewPending = false;
              }
            }).catch(error => {
              this.deps.log("error", "preview scheduler", `Preview refresh after auto-save failed: ${String(error)}`);
            });
          }
        }
        void Promise.resolve(this.deps.cachePreviewAfterSave()).catch(error => {
          this.deps.log("info", "preview scheduler", `Could not cache the auto-saved preview: ${String(error)}`);
        });
      }
    }
  }

  private async performSaveActiveFile(intent: SaveIntent): Promise<void> {
    const activeFilePath = this.deps.activeFilePath();
    if (!activeFilePath || !this.canPersistPath(activeFilePath)) return;

    try {
      const saveDiagnosticId = ++this.saveMemoryDiagnosticGeneration;
      await this.deps.logMemoryDiagnostics(`save ${saveDiagnosticId}: before write`);
      const activeTab = this.deps.openTabs().find(tab => filePathKey(tab.path) === filePathKey(activeFilePath)) ?? null;
      const contentBeforeSave = this.currentContent();
      const savedContentBeforeSave = activeTab?.savedContent ?? contentBeforeSave;
      const hasUnsavedContent = activeTab?.isDirty || contentBeforeSave !== savedContentBeforeSave;
      // Do not let Format on Save mutate an already-clean document. Formatter
      // edits are document changes and would otherwise trigger render-on-type
      // even though the user only asked to save an unchanged file.
      if (intent === "manual" && hasUnsavedContent
        && this.deps.activeMode() === "CODE" && this.deps.formatOnSave()) {
        await this.deps.formatActiveDocument({ silent: true });
        this.deps.removeTrailingSpaces();
      }

      const content = this.currentContent();
      const previewOwner = activeTab?.previewMainPath ?? activeTab?.previewRootPath ?? activeFilePath;
      const pendingExternalTabs = this.deps.openTabs().filter(tab => tab.externalPreviewPending && (
        filePathKey(tab.previewMainPath ?? tab.previewRootPath ?? tab.path) === filePathKey(previewOwner)
      ));
      const pendingExternalContents = pendingExternalTabs.map(tab => ({ tab, content: tab.content }));
      const contentChanged = pendingExternalTabs.length > 0 || activeTab?.externalContent !== undefined || content !== savedContentBeforeSave;
      const recoveryRevision = activeTab ? this.deps.recoveryRevision(activeTab) : 0;
      await invoke("save_workspace_file", { path: activeFilePath, contents: content });
      await this.deps.logMemoryDiagnostics(`save ${saveDiagnosticId}: after workspace write`);

      if (intent === "manual" && this.deps.lspReady()) {
        await this.deps.flushPendingLspSync();
        await this.deps.notifyLspSave(activeFilePath, content);
      }
      await this.deps.logMemoryDiagnostics(`save ${saveDiagnosticId}: after LSP save notification`);

      if (activeTab) {
        activeTab.content = content;
        activeTab.savedContent = content;
        activeTab.isDirty = false;
        activeTab.recoveredUnsaved = undefined;
        activeTab.externalContent = undefined;
        this.deps.clearExternalConflict(activeTab.path);
        await this.deps.recoverySaved(activeTab, recoveryRevision);
        this.deps.renderEditorTabs();
      }
      this.deps.setLspStatus({ kind: "preview-ready", message: t("File saved") });
      void Promise.resolve(this.deps.cachePreviewAfterSave()).catch(error => {
        this.deps.log("info", "preview scheduler", `Could not cache the saved preview: ${String(error)}`);
      });
      if (contentChanged && isTypstDocumentPath(activeFilePath)
        && this.deps.previewRenderMode() === "on-save") {
        // Saving has already succeeded. Start preview refresh separately so a
        // compiler/indexing failure is reported by the preview without
        // incorrectly presenting the successful file write as a save failure.
        void this.deps.refreshPreviewAfterSave(activeFilePath, content).then(() => {
          for (const pending of pendingExternalContents) {
            if (pending.tab.content === pending.content) pending.tab.externalPreviewPending = false;
          }
        }).catch(error => {
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
    return !isUntitledDocumentPath(path)
      && this.deps.isInternallySupportedPath(path)
      && !isBinaryImagePath(path)
      && fileExtension(path) !== "pdf";
  }

  private currentContent(): string {
    return this.deps.activeMode() === "WYSIWYM"
      ? this.deps.wysiwymMarkup()
      : this.deps.editorText();
  }
}
