import type { LspStatus } from "../compiler/lsp";
import type { EditorTab } from "../editor/editorTab";
import type { EditorTabPresentationController } from "../editor/editorTabPresentationController";
import { fileExtension, isBinaryImagePath } from "../platform/fileTypes";
import { fileNameFromPath, filePathKey } from "../platform/paths";
import { LatestRequestGuard } from "./latestRequestGuard";

export interface ExternalFileReloadDependencies {
  presentation: EditorTabPresentationController;
  openTabs(): EditorTab[];
  activeFilePath(): string | null;
  isInternallySupportedPath(path: string): boolean;
  flushEditorContentMutation(): void;
  isSaving(): boolean;
  pathExists(path: string): Promise<boolean>;
  readText(path: string): Promise<string>;
  readImage(path: string): Promise<string>;
  closeTab(path: string): Promise<void>;
  loadPdfPath(path: string): void;
  renderTabs(): void;
  sourceChanged(tab: EditorTab): void;
  externalConflictDetected?(path: string): void;
  confirmReload(path: string): Promise<boolean>;
  setLspStatus(status: LspStatus): void;
  appendWorkspaceWarning(message: string): void;
  invalidateLazyLoad(path: string): void;
}

/** Reconciles disk contents with editor tabs; compilation belongs to sourceChanged. */
export class ExternalFileReloadController {
  readonly conflictPaths = new Set<string>();
  private readonly conflictContents = new Map<string, string>();
  private readonly reloadRequests = new LatestRequestGuard<string>();

  constructor(private readonly deps: ExternalFileReloadDependencies) {}

  // Routine polling reads text only. Explicit paths also refresh changed assets.
  async reloadOpenFiles(paths?: readonly string[]): Promise<boolean> {
    if (this.deps.isSaving()) return false;
    this.deps.flushEditorContentMutation();
    const pathKeys = paths && new Set(paths.map(filePathKey));
    let changed = false;
    for (const tab of [...this.deps.openTabs()]) {
      const path = tab.path;
      const pathKey = filePathKey(path);
      const isAsset = isBinaryImagePath(path) || fileExtension(path) === "pdf";
      if (pathKeys ? !pathKeys.has(pathKey) : isAsset) continue;
      if (!this.deps.isInternallySupportedPath(path)) continue;
      const request = this.reloadRequests.begin(pathKey);
      const contentBeforeRead = tab.content;
      const savedBeforeRead = tab.savedContent;
      const externalBeforeRead = tab.externalContent;
      const isCurrent = () => (
        !this.deps.isSaving()
        && this.reloadRequests.isCurrent(request)
        && this.deps.openTabs().includes(tab)
        && filePathKey(tab.path) === pathKey
        && tab.content === contentBeforeRead
        && tab.savedContent === savedBeforeRead
        && tab.externalContent === externalBeforeRead
      );
      try {
        const exists = await this.deps.pathExists(path);
        this.deps.flushEditorContentMutation();
        if (!isCurrent()) continue;
        if (!exists) {
          if (tab.isDirty) this.reportConflict(path, "was removed outside Typsastra");
          else await this.deps.closeTab(path);
          continue;
        }
        if (!tab.contentLoaded) {
          // A routine poll is not evidence of a disk change. Invalidating here
          // repeatedly cancels the read/inspection that opens a restored tab.
          if (pathKeys) {
            this.deps.invalidateLazyLoad(path);
            tab.prefetchedContent = undefined;
            tab.sizeBytes = undefined;
            tab.lineCount = undefined;
          }
          continue;
        }
        if (fileExtension(path) === "pdf") {
          if (this.isActive(tab)) this.deps.loadPdfPath(path);
          continue;
        }
        const contents = isBinaryImagePath(path)
          ? await this.deps.readImage(path)
          : (await this.deps.readText(path)).replace(/\r\n?/g, "\n");
        this.deps.flushEditorContentMutation();
        if (!isCurrent()) continue;
        // Adopted disk revisions are already saved. Only local divergence
        // should require Save or conflict resolution.
        if (contents === (tab.externalContent ?? tab.savedContent)) continue;
        if (contents === tab.content) continue; // Includes our own writes.
        if (tab.isDirty && tab.content !== tab.externalContent) {
          if (this.conflictContents.get(pathKey) === contents) continue;
          this.conflictContents.set(pathKey, contents);
          this.reportConflict(path, "changed outside Typsastra");
          const reload = await this.deps.confirmReload(path);
          this.deps.flushEditorContentMutation();
          if (!reload || !isCurrent()) continue;
        }
        this.clearConflict(path);
        tab.content = contents;
        tab.contentLoaded = true;
        tab.externalContent = undefined;
        tab.savedContent = contents;
        tab.isDirty = false;
        tab.externalPreviewPending = false;
        tab.undoHistory = undefined;
        tab.editorState = undefined;
        tab.editorStateLanguage = undefined;
        tab.version += 1;
        tab.latestVersion = tab.version;
        if (this.isActive(tab)) {
          if (isBinaryImagePath(path)) {
            const img = document.getElementById("image-viewer-img") as HTMLImageElement | null;
            if (img) img.src = contents;
          } else {
            this.deps.presentation.replaceActiveTextContents(tab, contents);
          }
        }
        this.deps.renderTabs();
        if (!isAsset) this.deps.sourceChanged(tab);
        changed = true;
      } catch (error) {
        console.warn(`Unable to reload ${path}:`, error);
      }
    }
    return changed;
  }

  clearConflict(path: string): void {
    const key = filePathKey(path);
    this.conflictPaths.delete(key);
    this.conflictContents.delete(key);
  }

  reportConflict(path: string, reason: string): void {
    const pathKey = filePathKey(path);
    if (this.conflictPaths.has(pathKey)) return;
    this.conflictPaths.add(pathKey);
    this.deps.externalConflictDetected?.(path);
    this.deps.appendWorkspaceWarning(
      `${fileNameFromPath(path)} ${reason}; unsaved editor content was preserved.`,
    );
    this.deps.setLspStatus({ kind: "error", message: "External change conflicts with unsaved edits" });
  }

  private isActive(tab: EditorTab): boolean {
    const path = this.deps.activeFilePath();
    return path !== null && filePathKey(path) === filePathKey(tab.path);
  }
}
