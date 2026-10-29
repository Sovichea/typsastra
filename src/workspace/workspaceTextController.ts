import { invoke } from "@tauri-apps/api/core";
import type { TinymistLspClient } from "../compiler/lsp";
import type { EditorTabPresentationController } from "../editor/editorTabPresentationController";
import type { EditorTab } from "../editor/editorTab";
import type { LspDocumentController, LspDocumentResolution } from "../session/lspDocumentController";
import { filePathKey, isUntitledDocumentPath } from "../platform/paths";

export interface WorkspaceTextDependencies {
  openTabs(): EditorTab[];
  activeFilePath(): string | null;
  presentation(): EditorTabPresentationController;
  renderEditorTabs(): void;
  lspReady(): boolean;
  lspClient(): TinymistLspClient | undefined;
  lspDocuments(): LspDocumentController;
  resolveLspDocument(path: string, content: string): Promise<LspDocumentResolution>;
  currentDocumentVersion(): number;
}

/** Owns workspace text reads/writes and keeps open editor/LSP state synchronized. */
export class WorkspaceTextController {
  constructor(private readonly deps: WorkspaceTextDependencies) {}

  read(path: string): Promise<string> {
    const tab = this.findTab(path);
    return tab?.contentLoaded
      ? Promise.resolve(tab.content)
      : invoke<string>("read_workspace_file", { path });
  }

  async write(path: string, content: string): Promise<void> {
    if (isUntitledDocumentPath(path)) return;
    await invoke("save_workspace_file", { path, contents: content });
    const tab = this.findTab(path);
    if (tab) {
      tab.content = content;
      tab.savedContent = content;
      tab.contentLoaded = true;
      tab.isDirty = false;
      tab.version += 1;
      tab.latestVersion = tab.version;
      tab.undoHistory = undefined;
      const activeFilePath = this.deps.activeFilePath();
      if (activeFilePath && filePathKey(activeFilePath) === filePathKey(path)) {
        this.deps.presentation().replaceActiveTextContents(tab, content);
      }
      this.deps.renderEditorTabs();
    }

    const client = this.deps.lspClient();
    if (!this.deps.lspReady() || !client) return;
    const resolved = await this.deps.resolveLspDocument(path, content);
    if (!resolved) return;
    const version = tab?.version ?? this.deps.currentDocumentVersion();
    await this.deps.lspDocuments().openIfNeeded(resolved.uri, resolved.content, version);
    await client.notifyTextChange(resolved.uri, resolved.content, version);
    await client.notifyTextSave(resolved.uri, resolved.content);
  }

  private findTab(path: string): EditorTab | undefined {
    return this.deps.openTabs().find(candidate => filePathKey(candidate.path) === filePathKey(path));
  }
}
