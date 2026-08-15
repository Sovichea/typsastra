import { invoke } from "@tauri-apps/api/core";
import { filePathKey } from "../platform/paths";
import { parseDocumentScripts, type DocumentTypography } from "../editor/documentTypography";
import type { EditorTab } from "../editor/editorTab";
import type { LargeFileOpeningNotice } from "./largeFileOpening";

export interface PinnedMainFileDependencies {
  pinnedMainFilePath(): string | null;
  setPinnedMainFilePath(path: string | null): void;
  activeFilePath(): string | null;
  workspaceRootPath(): string | null;
  largePreviewNoticeForRoot(path: string): Promise<LargeFileOpeningNotice | null>;
  isLargePreviewApproved(path: string): boolean;
  prepareTypography(path: string): Promise<DocumentTypography | null | false>;
  synchronizeTypography(typography: DocumentTypography): void;
  setImageWorkspace(root: string, main: string | null): Promise<void>;
  isImageToolActive(): boolean;
  showImageTool(): void;
  clearBlockedLargePreviewRoot(): void;
  setMainDocumentScripts(scripts: DocumentTypography["fonts"]): void;
  configureDocumentLanguageTools(text: string): void;
  activeEditorText(): string;
  saveWorkspaceState(): void;
  setWorkspaceServicesDeferred(deferred: boolean): void;
  setBlockedLargePreviewRoot(path: string): void;
  isLowMemoryMode(): boolean;
  hasLspClient(): boolean;
  stopTinymistSession(message: string): Promise<void>;
  findOpenTab(path: string): EditorTab | undefined;
  showLargeFileConfirmation(tab: EditorTab, notice: LargeFileOpeningNotice): void;
  loadFile(path: string): Promise<void>;
  sortPinnedMainFirst(): void;
  renderEditorTabs(): void;
  reloadExplorer(): Promise<void>;
  resetPdfForMainFileChange(): void;
  prepareRenderProject(): Promise<void>;
  restartTinymistSession(message: string): Promise<void>;
  setLspReady(ready: boolean): void;
  logRestartFailure(message: string): void;
  updatePinnedMain(path: string | null): Promise<boolean>;
  activeTabContentLoaded(): boolean;
  restoreActiveDocumentAfterRestart(forcePreview?: boolean): Promise<void>;
  refreshActivePreviewRoot(forceRender?: boolean): Promise<void>;
}

export class PinnedMainFileController {
  constructor(private readonly deps: PinnedMainFileDependencies) {}

  isPinned(path: string): boolean {
    const pinned = this.deps.pinnedMainFilePath();
    return pinned !== null && filePathKey(pinned) === filePathKey(path);
  }

  async set(path: string | null): Promise<void> {
    const deps = this.deps;
    const currentPinned = deps.pinnedMainFilePath();
    const mainChanged = filePathKey(currentPinned ?? "") !== filePathKey(path ?? "");
    const mainPreviewNotice = path && mainChanged ? await deps.largePreviewNoticeForRoot(path) : null;
    const previewApproved = !mainPreviewNotice || deps.isLargePreviewApproved(path ?? "");
    const typography = path && mainChanged && previewApproved ? await deps.prepareTypography(path) : null;
    if (typography === false) return;
    if (typography) deps.synchronizeTypography(typography);

    const activeFilePath = deps.activeFilePath();
    const mainWasAlreadyActive = path !== null
      && activeFilePath !== null
      && filePathKey(path) === filePathKey(activeFilePath);
    deps.setPinnedMainFilePath(path);

    const workspaceRootPath = deps.workspaceRootPath();
    if (workspaceRootPath) {
      void deps.setImageWorkspace(workspaceRootPath, path).then(() => {
        if (deps.isImageToolActive()) deps.showImageTool();
      });
    }
    if (!path) deps.clearBlockedLargePreviewRoot();

    deps.setMainDocumentScripts(path
      ? parseDocumentScripts(await invoke<string>("read_workspace_text_prefix", { path, maxBytes: 65_536 }))
      : []);
    deps.configureDocumentLanguageTools(activeFilePath ? deps.activeEditorText() : "");
    deps.saveWorkspaceState();

    if (path && mainChanged && !previewApproved && mainPreviewNotice) {
      deps.setWorkspaceServicesDeferred(true);
      deps.setBlockedLargePreviewRoot(path);
      if (deps.hasLspClient()) await deps.stopTinymistSession("Large Typst file waiting for editor approval");
      const tab = deps.findOpenTab(path);
      if (tab) deps.showLargeFileConfirmation(tab, mainPreviewNotice);
      else await deps.loadFile(path);
      deps.sortPinnedMainFirst();
      deps.renderEditorTabs();
      await deps.reloadExplorer();
      return;
    }

    if (mainChanged && previewApproved) {
      deps.resetPdfForMainFileChange();
      try {
        await deps.prepareRenderProject();
        if (deps.hasLspClient()) {
          await deps.restartTinymistSession("Restarting Tinymist for the new main file...");
        }
      } catch (error) {
        deps.setLspReady(false);
        deps.logRestartFailure(`Failed to prepare the compiler after changing the main file: ${String(error)}`);
      }
    }

    if (path && previewApproved) {
      await deps.loadFile(path);
      deps.sortPinnedMainFirst();
    } else if (!mainChanged) {
      await deps.updatePinnedMain(null);
    }

    deps.renderEditorTabs();
    await deps.reloadExplorer();

    if (!previewApproved) {
      deps.renderEditorTabs();
      return;
    }
    if (path && !deps.activeTabContentLoaded()) return;

    if (deps.isLowMemoryMode()) {
      await deps.refreshActivePreviewRoot(true);
      return;
    }

    if (mainChanged && (!path || mainWasAlreadyActive)) {
      await deps.restoreActiveDocumentAfterRestart(mainWasAlreadyActive);
    } else {
      await deps.refreshActivePreviewRoot(mainWasAlreadyActive);
    }
  }
}
