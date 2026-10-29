import { invoke } from "@tauri-apps/api/core";
import type { TinymistLspClient, LspLogEntry } from "../compiler/lsp";
import type { EditorTab } from "../editor/editorTab";
import { isTypstDocumentPath } from "../platform/fileTypes";
import { filePathKey } from "../platform/paths";
import { allowsStandalonePreview, previewLspMainPath, type PreviewTarget } from "../preview/previewPolicy";
import type { PreviewRefreshStyle } from "../preview/previewPolicy";
import type { DocumentSessionController } from "./documentSessionController";
import type { LspDocumentController, LspDocumentResolution } from "./lspDocumentController";

export interface LspSyncDependencies {
  session(): DocumentSessionController;
  documents(): LspDocumentController;
  client(): TinymistLspClient | undefined;
  ready(): boolean;
  activeFilePath(): string | null;
  activeTab(): EditorTab | null;
  workspaceRootPath(): string | null;
  pinnedMainFilePath(): string | null;
  previewImported(): boolean;
  previewStandalone(): boolean;
  previewRenderMode(): PreviewRefreshStyle;
  syncDebounceMs(): number;
  isLoadingFile(): boolean;
  activeEditorText(): string;
  flushEditorContentMutation(): void;
  resetPreviewSync(): void;
  prepareTemplateAwarePreview(target: PreviewTarget, path: string, text: string): Promise<PreviewTarget>;
  resolveLspDocument(path: string, text: string): Promise<LspDocumentResolution>;
  updatePinnedMain(path: string | null, force?: boolean): Promise<boolean>;
  recheckActiveDocumentAfterPin(text: string): Promise<void>;
  refreshActivePreviewRoot(force?: boolean): Promise<void>;
  appendLog(entry: LspLogEntry): void;
}

/** Owns queued Tinymist document synchronization and post-restart restoration. */
export class LspSyncController {
  constructor(private readonly deps: LspSyncDependencies) {}

  queueContentMutation(rawText: string): void {
    const path = this.deps.activeFilePath();
    if (
      this.deps.isLoadingFile()
      || !path
      || !isTypstDocumentPath(path)
      || !this.deps.ready()
      || !this.deps.client()
    ) return;
    const activeTab = this.deps.activeTab();
    if (activeTab?.untitled) return;

    const documents = this.deps.documents();
    const version = documents.nextVersion();
    documents.latestVersion = version;
    if (activeTab && activeTab.path === path) {
      activeTab.version = version;
      activeTab.latestVersion = version;
    }

    if (
      this.deps.previewImported()
      && allowsStandalonePreview(rawText) !== this.deps.previewStandalone()
      && this.deps.previewRenderMode() === "on-type"
    ) {
      void this.deps.refreshActivePreviewRoot();
    }

    this.deps.session().queueDocumentSync(
      path,
      rawText,
      version,
      this.deps.syncDebounceMs(),
      () => void this.flushPending(),
    );
  }

  async flushPending(): Promise<void> {
    // Completion, navigation, save, and other explicit LSP requests must see
    // the latest editor snapshot even when routine on-save synchronization is
    // waiting for an input pause.
    this.deps.flushEditorContentMutation();
    const client = this.deps.client();
    if (!this.deps.ready() || !client) return;
    const session = this.deps.session();
    const pending = session.takePendingSync(filePathKey);
    if (!pending) return;
    const {
      path,
      text,
      version: pendingVersion,
      requestKey,
      generation: expectedGeneration,
    } = pending;

    this.deps.resetPreviewSync();
    const workspaceRootPath = this.deps.workspaceRootPath();
    if (workspaceRootPath && this.deps.previewStandalone() && this.deps.previewRenderMode() === "on-type") {
      let target = await invoke<PreviewTarget>("resolve_preview_main", {
        filePath: path,
        workspaceRootPath,
        fileContents: text,
        pinnedMainPath: this.deps.pinnedMainFilePath(),
      });
      target = await this.deps.prepareTemplateAwarePreview(target, path, text);
    }

    if (!session.isSyncRequestCurrent(requestKey, expectedGeneration)) return;

    const documents = this.deps.documents();
    const version = pendingVersion ?? documents.nextVersion();
    documents.latestVersion = version;
    const activeTab = this.deps.activeTab();
    if (activeTab && activeTab.path === path) {
      activeTab.version = version;
      activeTab.latestVersion = version;
    }
    const lspRes = await this.deps.resolveLspDocument(path, text);
    if (!lspRes || !this.isVersionCurrent(path, version)) return;
    await documents.openIfNeeded(lspRes.uri, lspRes.content, version);
    if (!this.isVersionCurrent(path, version)) return;
    await client.notifyTextChange(lspRes.uri, lspRes.content, version);
  }

  async restoreActiveDocumentAfterRestart(forcePreview = true): Promise<void> {
    const activePath = this.deps.activeFilePath();
    const workspaceRootPath = this.deps.workspaceRootPath();
    const client = this.deps.client();
    if (!activePath || !workspaceRootPath || !this.deps.ready() || !client) return;

    const tab = this.deps.activeTab();
    if (!tab?.contentLoaded || !isTypstDocumentPath(tab.path) || tab.untitled) return;
    const contents = this.deps.activeEditorText();

    try {
      // A Tinymist restart clears its main-file context. Restore the project
      // owner before re-registering the active editor document.
      let target = await invoke<PreviewTarget>("resolve_preview_main", {
        filePath: activePath,
        workspaceRootPath,
        fileContents: contents,
        pinnedMainPath: this.deps.pinnedMainFilePath(),
      });
      target = await this.deps.prepareTemplateAwarePreview(target, activePath, contents);

      if (!target.disabled) {
        const mainPath = previewLspMainPath(target);
        await this.deps.updatePinnedMain(mainPath, true);
        this.deps.appendLog({
          kind: "info",
          source: "lsp lifecycle",
          message: `Restored Tinymist main-file context after restart: ${mainPath ?? "none"}`,
        });
      }

      await this.deps.recheckActiveDocumentAfterPin(contents);
      await this.deps.refreshActivePreviewRoot(forcePreview);
      this.deps.appendLog({
        kind: "info",
        source: "lsp lifecycle",
        message: `Restored Tinymist document context after restart: ${activePath}`,
      });
    } catch (error) {
      this.deps.appendLog({
        kind: "error",
        source: "lsp lifecycle",
        message: `Failed to restore Tinymist document context after restart: ${String(error)}`,
      });
      throw error;
    }
  }

  clearPending(): void {
    this.deps.session().clearPendingSync();
  }

  isVersionCurrent(path: string, version: number): boolean {
    const activeTab = this.deps.activeTab();
    if (activeTab && filePathKey(activeTab.path) === filePathKey(path) && activeTab.latestVersion > version) {
      return false;
    }
    return !this.deps.session().hasNewerPendingSync(path, version, filePathKey);
  }
}
