import { invoke } from "@tauri-apps/api/core";
import { confirm } from "@tauri-apps/plugin-dialog";
import { isBinaryImagePath } from "../platform/fileTypes";
import { fileNameFromPath, filePathKey, isUntitledDocumentPath } from "../platform/paths";
import type { PreviewSessionController } from "../preview/previewSessionController";
import type { LspDocumentController } from "../session/lspDocumentController";
import type { TypographyController } from "../typography/typographyController";
import type { EditorSessionController } from "./editorSessionController";
import type { EditorTab, PreviewSessionState } from "./editorTab";
import type { EditorTabPresentationController } from "./editorTabPresentationController";

export interface EditorTabLoadOptions {
  temporary?: boolean;
  preservePreviewSession?: PreviewSessionState;
  skipPreviewActivation?: boolean;
  preservePreviewViewport?: boolean;
  focusEditor?: boolean;
}

interface ActivationOptions {
  preservePreviewSession?: PreviewSessionState;
  skipPreviewActivation?: boolean;
  preservePreviewViewport?: boolean;
  focusEditor?: boolean;
}

export interface EditorTabLifecycleDependencies {
  session: EditorSessionController;
  presentation: EditorTabPresentationController;
  previewSession: PreviewSessionController;
  lspDocuments: LspDocumentController;
  typography(): TypographyController;
  pinnedMainFilePath(): string | null;
  persistActiveTabState(): void;
  discardRecoverySnapshot(tab: EditorTab): void | Promise<void>;
  promoteToPermanent(tab: EditorTab): void | Promise<void>;
  activateTab(path: string, persistCurrent: boolean, options?: ActivationOptions): Promise<void>;
  classifyUnknownTextPath(path: string): Promise<boolean>;
  renderTabs(): void;
  setExplorerActiveFile(path: string | null): void;
  activateSpellcheckDocument(path: string | null): void;
  clearDiagnostics(): void;
  clearPendingLspSync(): void;
  clearForwardSync(): void;
  updateWorkspaceViewportVisibility(): void;
  saveWorkspaceState(): void;
}

/** Owns tab opening/closing lifecycle while activation remains a separate workflow. */
export class EditorTabLifecycleController {
  constructor(private readonly dependencies: EditorTabLifecycleDependencies) {}

  async close(path: string, skipDirtyCheck = false): Promise<void> {
    const pinnedMainFilePath = this.dependencies.pinnedMainFilePath();
    if (pinnedMainFilePath && filePathKey(path) === filePathKey(pinnedMainFilePath)) return;

    const tabs = this.dependencies.session.tabs;
    const tabIndex = tabs.findIndex(tab => tab.path === path);
    if (tabIndex === -1) return;

    if (this.dependencies.session.activeFilePath === path) {
      this.dependencies.persistActiveTabState();
    }

    const tab = tabs[tabIndex];
    if (!skipDirtyCheck && tab.isDirty) {
      const shouldClose = await confirm(
        `Close ${tab.title ?? fileNameFromPath(tab.path)} without saving?`,
        { title: "Unsaved Changes", kind: "warning" },
      );
      if (!shouldClose) return;
      await this.dependencies.discardRecoverySnapshot(tab);
    }

    const wasActive = this.dependencies.session.activeFilePath === path;
    tabs.splice(tabIndex, 1);
    this.dependencies.typography().closeDocument(path);
    await this.dependencies.lspDocuments.closeIfOpened(path);

    if (wasActive) {
      const nextTab = tabs[Math.min(tabIndex, tabs.length - 1)] ?? null;
      this.dependencies.session.activeFilePath = null;
      this.dependencies.previewSession.reset();
      this.dependencies.clearDiagnostics();
      this.dependencies.clearPendingLspSync();
      this.dependencies.clearForwardSync();

      if (nextTab) {
        await this.dependencies.activateTab(nextTab.path, false);
      } else {
        this.dependencies.setExplorerActiveFile(null);
        this.dependencies.activateSpellcheckDocument(null);
        this.dependencies.presentation.presentEmpty();
      }
    }

    this.dependencies.renderTabs();
    this.dependencies.updateWorkspaceViewportVisibility();
    this.dependencies.saveWorkspaceState();
  }

  async load(path: string, options: EditorTabLoadOptions = {}): Promise<void> {
    const tabs = this.dependencies.session.tabs;
    const existingTab = tabs.find(tab => filePathKey(tab.path) === filePathKey(path));
    if (!existingTab && isUntitledDocumentPath(path)) return;
    if (existingTab) {
      if (!options.temporary) void this.dependencies.promoteToPermanent(existingTab);
      await this.dependencies.activateTab(existingTab.path, true, this.activationOptions(options));
      return;
    }
    if (
      this.dependencies.session.activeFilePath
      && filePathKey(this.dependencies.session.activeFilePath) === filePathKey(path)
    ) {
      this.dependencies.session.activeFilePath = null;
    }

    try {
      const internallySupported = await this.dependencies.classifyUnknownTextPath(path);
      const deferredContent = internallySupported && !isBinaryImagePath(path);
      const contents = isBinaryImagePath(path)
        ? await invoke<string>("read_workspace_file_as_base64", { path })
        : "";
      const newTab: EditorTab = {
        path,
        content: contents,
        savedContent: contents,
        contentLoaded: !deferredContent,
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
        selectionAnchor: 0,
        selectionHead: 0,
        foldRanges: [],
        foldStateExplicit: false,
        temporary: options.temporary,
      };

      if (options.temporary) {
        const existingTempIndex = tabs.findIndex(tab => tab.temporary && !tab.isDirty);
        if (existingTempIndex >= 0) tabs.splice(existingTempIndex, 1);
      }

      tabs.push(newTab);
      this.dependencies.renderTabs();
      await this.dependencies.activateTab(path, true, this.activationOptions(options));
    } catch (error) {
      console.error("Failed to load file:", error);
      alert("Failed to load file: " + error);
    }
  }

  private activationOptions(options: EditorTabLoadOptions): ActivationOptions {
    return {
      preservePreviewSession: options.preservePreviewSession,
      skipPreviewActivation: options.skipPreviewActivation,
      preservePreviewViewport: options.preservePreviewViewport,
      focusEditor: options.focusEditor,
    };
  }
}
