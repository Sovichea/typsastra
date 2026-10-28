import type { TinymistLspClient } from "../compiler/lsp";
import type { EditorTab } from "../editor/editorTab";
import { fileNameFromPath, filePathFromUri, filePathKey, filePathToUri } from "../platform/paths";

export type LspDocumentResolution = { uri: string; content: string } | null;

export interface LspDocumentDependencies {
  client(): TinymistLspClient | undefined;
  ready(): boolean;
  activeFilePath(): string | null;
  activeTab(): EditorTab | null;
  resolveDocument(path: string, text: string): Promise<LspDocumentResolution>;
  clearDiagnostics(): void;
  clearDiagnosticsFor(path: string): void;
  log(kind: "info" | "warning", source: string, message: string): void;
}

/** Owns Tinymist document registration, main-file pinning, and document versions. */
export class LspDocumentController {
  private readonly openedUris = new Set<string>();
  private pinnedMainValue: string | null = null;
  private currentVersionValue = 1;
  private latestVersionValue = 1;

  constructor(private readonly deps: LspDocumentDependencies) {}

  get currentVersion(): number { return this.currentVersionValue; }
  set currentVersion(value: number) { this.currentVersionValue = value; }
  get latestVersion(): number { return this.latestVersionValue; }
  set latestVersion(value: number) { this.latestVersionValue = value; }
  get pinnedMainPath(): string | null { return this.pinnedMainValue; }
  set pinnedMainPath(value: string | null) { this.pinnedMainValue = value; }

  nextVersion(): number {
    this.currentVersionValue += 1;
    return this.currentVersionValue;
  }

  listOpenedUris(): string[] {
    return [...this.openedUris];
  }

  hasOpenedUri(uri: string): boolean {
    return this.openedUris.has(uri);
  }

  addOpenedUri(uri: string): void {
    this.openedUris.add(uri);
  }

  removeOpenedUri(uri: string): void {
    this.openedUris.delete(uri);
  }

  resetSessionState(): void {
    this.pinnedMainValue = null;
    this.openedUris.clear();
  }

  async openIfNeeded(uri: string, text: string, version: number): Promise<void> {
    if (this.openedUris.has(uri)) return;
    const client = this.deps.client();
    if (!client) return;
    await client.openTextDocument(uri, text, version);
    this.openedUris.add(uri);
    // The server can publish diagnostics for stale on-disk content before the
    // opened document is analyzed. Discard that revision's cached problems.
    this.deps.clearDiagnosticsFor(filePathFromUri(uri));
  }

  async closeIfOpened(path: string): Promise<void> {
    const client = this.deps.client();
    if (!client) return;
    const uri = filePathToUri(path);
    if (!this.openedUris.delete(uri)) return;
    try {
      await client.closeTextDocument(uri);
    } catch (error) {
      this.openedUris.add(uri);
      this.deps.log(
        "warning",
        "lsp",
        `Failed to close ${fileNameFromPath(path)} in Tinymist: ${String(error)}`,
      );
    }
  }

  async updatePinnedMain(path: string | null, force = false): Promise<boolean> {
    const client = this.deps.client();
    if (!this.deps.ready() || !client) return false;
    if (!force && filePathKey(this.pinnedMainValue ?? "") === filePathKey(path ?? "")) return false;
    try {
      await client.pinMain(path);
      this.pinnedMainValue = path;
      return true;
    } catch (error) {
      this.deps.log(
        "warning",
        "lsp",
        `Unable to set Tinymist main-file context: ${String(error)}`,
      );
      return false;
    }
  }

  async recheckActiveAfterPin(text: string): Promise<void> {
    const activePath = this.deps.activeFilePath();
    const client = this.deps.client();
    if (!activePath || !this.deps.ready() || !client) return;

    this.deps.clearDiagnostics();
    const lspRes = await this.deps.resolveDocument(activePath, text);
    if (!lspRes) return;

    const { uri: lspUri, content: lspContent } = lspRes;
    const activeTab = this.deps.activeTab();
    if (!this.openedUris.has(lspUri)) {
      const openVersion = this.nextVersion();
      this.latestVersionValue = openVersion;
      if (activeTab && activeTab.path === activePath) {
        activeTab.version = openVersion;
        activeTab.latestVersion = openVersion;
      }
      await client.openTextDocument(lspUri, lspContent, openVersion);
      this.openedUris.add(lspUri);
      this.deps.clearDiagnosticsFor(activePath);
      this.deps.log(
        "info",
        "lsp lifecycle",
        `Reopened Tinymist document after restart: ${lspUri}; version=${openVersion}`,
      );
      return;
    }

    const changeVersion = this.nextVersion();
    this.latestVersionValue = changeVersion;
    if (activeTab && activeTab.path === activePath) {
      activeTab.version = changeVersion;
      activeTab.latestVersion = changeVersion;
    }
    await client.notifyTextChange(lspUri, lspContent, changeVersion);
    this.deps.clearDiagnosticsFor(activePath);
    this.deps.log(
      "info",
      "lsp lifecycle",
      `Resynchronized open Tinymist document: ${lspUri}; version=${changeVersion}`,
    );
  }

  async transferRenamedDocuments(
    renamedTabs: readonly { oldPath: string; tab: EditorTab }[],
    oldPath: string,
    newPath: string,
  ): Promise<void> {
    const client = this.deps.client();
    if (!this.deps.ready() || !client) return;
    try {
      for (const renamed of renamedTabs) {
        const oldUri = filePathToUri(renamed.oldPath);
        if (this.openedUris.delete(oldUri)) {
          await client.closeTextDocument(oldUri).catch(() => {});
        }
        const resolved = await this.deps.resolveDocument(renamed.tab.path, renamed.tab.content);
        if (!resolved) continue;
        await client.openTextDocument(resolved.uri, resolved.content, renamed.tab.version);
        this.openedUris.add(resolved.uri);
      }
      await client.notifyWorkspaceFilesChanged([
        { uri: filePathToUri(oldPath), type: 3 },
        { uri: filePathToUri(newPath), type: 1 },
      ]);
    } catch (error) {
      this.deps.log(
        "warning",
        "workspace",
        `The file was renamed, but Tinymist's document state could not be transferred: ${String(error)}`,
      );
    }
  }
}
