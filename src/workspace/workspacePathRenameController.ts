import { invoke } from "@tauri-apps/api/core";
import type { LspLogEntry } from "../compiler/lsp";
import type { ImageToolsController } from "../components/imageTools";
import type { EditorTab } from "../editor/editorTab";
import { remapFilePath } from "../platform/paths";
import type { PdfPreviewPreparationController } from "../preview/pdfPreviewPreparationController";
import type { PdfPreviewRenderController } from "../preview/pdfPreviewRenderController";
import type { PreviewSessionController } from "../preview/previewSessionController";
import type { DocumentSessionController } from "../session/documentSessionController";
import type { LspDocumentController } from "../session/lspDocumentController";
import type { TypographyController } from "../typography/typographyController";
import type { WorkspaceController } from "./workspaceController";
import type { NavigationHistoryController } from "../navigation/navigationHistoryController";

export interface WorkspacePathRenameDependencies {
  workspaceRootPath(): string | null;
  workspace(): WorkspaceController;
  imageTools(): ImageToolsController;
  typography(): TypographyController;
  documentSession(): DocumentSessionController;
  previewSession(): PreviewSessionController;
  previewPreparation(): PdfPreviewPreparationController;
  previewRender(): PdfPreviewRenderController;
  lspDocuments(): LspDocumentController;
  openTabs(): EditorTab[];
  activeFilePath(): string | null;
  setActiveFilePath(path: string | null): void;
  pinnedMainFilePath(): string | null;
  setPinnedMainFilePath(path: string | null): void;
  setExplorerActiveFile(path: string): void;
  activateSpellcheckDocument(path: string): void;
  sortPinnedMainFirst(path: string | null): void;
  renderTabs(): void;
  saveWorkspaceState(): Promise<void>;
  reloadOpenFilesFromDisk(): Promise<boolean>;
  handleImageToolFilesWritten(paths: string[], phase: "before" | "after"): Promise<void>;
  prepareRenderProjectIfNeeded(): Promise<void>;
  refreshActivePreviewRoot(force: boolean): Promise<void>;
  appendLog(entry: LspLogEntry): void;
  navigationHistory?(): NavigationHistoryController;
}

/** Owns workspace-path rename propagation across open editor and preview sessions. */
export class WorkspacePathRenameController {
  constructor(private readonly deps: WorkspacePathRenameDependencies) {}

  async rename(oldPath: string, newPath: string, updateImageReferences = false): Promise<void> {
    const workspaceRoot = this.deps.workspaceRootPath();
    const imageReferenceSourcePaths = updateImageReferences
      ? this.deps.imageTools().referenceSourcePathsForImage(oldPath)
      : [];
    if (workspaceRoot) this.deps.workspace().stopWatching();
    if (imageReferenceSourcePaths.length > 0) {
      await this.deps.handleImageToolFilesWritten(imageReferenceSourcePaths, "before");
    }

    try {
      await invoke("rename_workspace_file", { oldPath, newPath });
      this.deps.navigationHistory?.().rename(oldPath, newPath);

      if (workspaceRoot && imageReferenceSourcePaths.length > 0) {
        try {
          await invoke<number>("image_tool_update_references", {
            workspaceRootPath: workspaceRoot,
            originalImagePath: oldPath,
            replacementImagePath: newPath,
            sourcePaths: imageReferenceSourcePaths,
          });
          // Keep open source tabs synchronized before preparing the next
          // preview generation, otherwise it can briefly compile the stale
          // image path that existed before the rename.
          await this.deps.reloadOpenFilesFromDisk();
        } catch (error) {
          this.deps.appendLog({
            kind: "error",
            source: "image tools",
            message: `The image was renamed, but its static Typst references could not be updated: ${String(error)}`,
          });
        }
      }

      const renamedTabs: Array<{ oldPath: string; tab: EditorTab }> = [];
      for (const tab of this.deps.openTabs()) {
        const renamedPath = remapFilePath(tab.path, oldPath, newPath);
        if (renamedPath === tab.path) continue;

        renamedTabs.push({ oldPath: tab.path, tab });
        this.deps.typography().renameDocument(tab.path, renamedPath);
        tab.path = renamedPath;
      }

      const activeFilePath = this.deps.activeFilePath();
      this.deps.setActiveFilePath(activeFilePath
        ? remapFilePath(activeFilePath, oldPath, newPath)
        : null);
      const pinnedMainFilePath = this.deps.pinnedMainFilePath();
      this.deps.setPinnedMainFilePath(pinnedMainFilePath
        ? remapFilePath(pinnedMainFilePath, oldPath, newPath)
        : null);
      this.deps.documentSession().remapPendingSyncPath(path =>
        remapFilePath(path, oldPath, newPath)
      );

      // Preview roots and task identities include the source path. Keeping any
      // of them after a rename lets stale and current sessions alternate.
      for (const tab of this.deps.openTabs()) {
        tab.previewRootPath = null;
        tab.previewMainPath = null;
        tab.previewTaskId = null;
        tab.previewSessionKey = null;
        tab.previewImported = false;
        tab.previewStandalone = true;
        tab.previewDisabled = false;
      }
      this.deps.previewSession().reset();
      this.deps.lspDocuments().pinnedMainPath = null;
      this.deps.previewPreparation().clearGeneratedFiles();
      this.deps.previewRender().invalidatePreparationScheduleOnly();

      const updatedActiveFilePath = this.deps.activeFilePath();
      if (updatedActiveFilePath) {
        this.deps.setExplorerActiveFile(updatedActiveFilePath);
        this.deps.activateSpellcheckDocument(updatedActiveFilePath);
      }
      this.deps.sortPinnedMainFirst(this.deps.pinnedMainFilePath());
      this.deps.renderTabs();
      await this.deps.saveWorkspaceState();

      await this.deps.lspDocuments().transferRenamedDocuments(renamedTabs, oldPath, newPath);

      await this.deps.prepareRenderProjectIfNeeded();
      await this.deps.refreshActivePreviewRoot(true);
      if (imageReferenceSourcePaths.length > 0) {
        await this.deps.handleImageToolFilesWritten(imageReferenceSourcePaths, "after");
      }
    } finally {
      if (workspaceRoot && this.deps.workspaceRootPath() === workspaceRoot) {
        await this.deps.workspace().startWatching(workspaceRoot);
      }
    }
  }
}
