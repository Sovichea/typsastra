import { invoke } from "@tauri-apps/api/core";
import type { EditorTab } from "../editor/editorTab";
import { fileExtension, isBinaryImagePath, isTypstDocumentPath } from "../platform/fileTypes";
import { filePathKey } from "../platform/paths";
import type { PreviewFrame } from "../preview/previewFrame";
import type { PreviewSessionController } from "../preview/previewSessionController";
import type { PreviewTarget } from "../preview/previewPolicy";
import {
  largeFileOpeningNotice,
  largeMainPreviewOpeningNotice,
  type LargeFileOpeningNotice,
} from "./largeFileOpening";

export interface LargePreviewGuardDependencies {
  previewSession: PreviewSessionController;
  previewFrame(): PreviewFrame;
  workspaceRootPath(): string | null;
  pinnedMainFilePath(): string | null;
  pinnedLspMainPath(): string | null;
  lspReady(): boolean;
  activeTab(): EditorTab | null;
  isInternallySupportedPath(path: string): boolean;
  showLargeFileConfirmation(tab: EditorTab, notice: LargeFileOpeningNotice): void;
  setWorkspaceServicesDeferred(deferred: boolean): void;
  logPreview(message: string): void;
}

/** Owns large-file and aggregate preview approval policy/state. */
export class LargePreviewGuardController {
  readonly approvedRoots = new Set<string>();
  readonly inspectedRoots = new Set<string>();
  private blockedRootValue: string | null = null;

  constructor(private readonly deps: LargePreviewGuardDependencies) {}

  get blockedRoot(): string | null { return this.blockedRootValue; }
  set blockedRoot(value: string | null) { this.blockedRootValue = value; }

  async noticeForTab(tab: EditorTab): Promise<LargeFileOpeningNotice | null> {
    if (tab.sizeBytes === undefined) {
      try {
        tab.sizeBytes = await invoke<number>("workspace_file_size", { path: tab.path });
      } catch {
        return null;
      }
    }
    const sizeBytes = tab.sizeBytes;
    if (sizeBytes === undefined) return null;
    const sizeNotice = largeFileOpeningNotice(tab.path, sizeBytes);
    if (
      sizeNotice?.kind === "pdf"
      || fileExtension(tab.path) === "pdf"
      || isBinaryImagePath(tab.path)
      || !this.deps.isInternallySupportedPath(tab.path)
    ) return sizeNotice;

    if (!sizeNotice && tab.lineCount === undefined) {
      try {
        tab.lineCount = await invoke<number>("workspace_text_line_count", { path: tab.path });
      } catch {
        return null;
      }
    }
    const textNotice = sizeNotice ?? largeFileOpeningNotice(tab.path, sizeBytes, tab.lineCount);
    if (!isTypstDocumentPath(tab.path)) return textNotice;

    // A Typst include is opened as part of its effective main preview, not as
    // an independent compiler session. Resolve that relationship before
    // applying the file-size guard so one approval for the main also approves
    // every included file for this workspace session.
    const target = await this.previewTargetForUnloadedTab(tab);
    if (target?.rootPath && !target.disabled) {
      const rootKey = filePathKey(target.rootPath);
      if (this.approvedRoots.has(rootKey) || this.inspectedRoots.has(rootKey)) return null;
      const rootNotice = await this.noticeForRoot(target.rootPath);
      if (rootNotice) return rootNotice;
    }

    return textNotice;
  }

  async previewTargetForUnloadedTab(tab: EditorTab): Promise<PreviewTarget | null> {
    if (!isTypstDocumentPath(tab.path)) return null;
    try {
      return await invoke<PreviewTarget>("resolve_preview_main", {
        filePath: tab.path,
        workspaceRootPath: this.deps.workspaceRootPath(),
        fileContents: tab.contentLoaded ? tab.content : null,
        pinnedMainPath: this.deps.pinnedMainFilePath(),
      });
    } catch {
      return null;
    }
  }

  async approveForTab(tab: EditorTab, notice: LargeFileOpeningNotice): Promise<void> {
    const target = notice.previewRootPath
      ? { rootPath: notice.previewRootPath }
      : await this.previewTargetForUnloadedTab(tab);
    const rootPath = target?.rootPath;
    if (!rootPath) {
      this.deps.logPreview(`Large-preview approval could not resolve a root: tab=${tab.path}; noticeRoot=${notice.previewRootPath ?? "none"}.`);
      return;
    }
    const rootKey = filePathKey(rootPath);
    this.approvedRoots.add(rootKey);
    this.inspectedRoots.add(rootKey);
    if (!this.blockedRootValue) return;
    const blockedKey = filePathKey(this.blockedRootValue);
    if (blockedKey === rootKey || blockedKey === filePathKey(tab.path)) {
      this.blockedRootValue = null;
    }
    this.deps.logPreview(`Large-preview root approved: tab=${tab.path}; root=${rootPath}; blocked=${this.blockedRootValue ?? "none"}; approvedRoots=${this.approvedRoots.size}.`);
  }

  activeCompilerPreviewMatchesRoot(rootPath: string): boolean {
    const session = this.deps.previewSession;
    const activeRootMatches = [session.rootPath, session.mainPath]
      .some(path => path !== null && filePathKey(path) === filePathKey(rootPath));
    const previewFrame = this.deps.previewFrame();
    const mountedSessionMatches = Boolean(
      session.sessionKey
      && previewFrame.currentSessionKey === session.sessionKey
      && previewFrame.currentUrl
    );
    const pinnedLspMainPath = this.deps.pinnedLspMainPath();
    const lspAlreadyOwnsRoot = Boolean(
      this.deps.lspReady()
      && pinnedLspMainPath
      && filePathKey(pinnedLspMainPath) === filePathKey(rootPath)
    );
    return lspAlreadyOwnsRoot || (activeRootMatches && mountedSessionMatches);
  }

  async noticeForRoot(rootPath: string): Promise<LargeFileOpeningNotice | null> {
    try {
      const stats = await invoke<{ sizeBytes: number; lineCount: number; fileCount: number }>(
        "typst_preview_source_stats",
        { rootPath },
      );
      return largeMainPreviewOpeningNotice(
        rootPath,
        stats.sizeBytes,
        stats.lineCount,
        stats.fileCount,
      );
    } catch {
      return null;
    }
  }

  async ensureApproved(rootPath: string | null): Promise<boolean> {
    if (!rootPath) {
      this.deps.logPreview("Large-preview approval bypassed: no preview root.");
      return true;
    }
    if (this.activeCompilerPreviewMatchesRoot(rootPath)) {
      this.deps.logPreview(`Large-preview approval bypassed: active session already owns root=${rootPath}.`);
      return true;
    }
    const rootKey = filePathKey(rootPath);
    if (this.approvedRoots.has(rootKey) || this.inspectedRoots.has(rootKey)) {
      this.deps.logPreview(`Large-preview approval reused: root=${rootPath}; approved=${this.approvedRoots.has(rootKey)}; inspected=${this.inspectedRoots.has(rootKey)}.`);
      return true;
    }
    if (this.blockedRootValue && filePathKey(this.blockedRootValue) === rootKey) {
      this.deps.logPreview(`Large-preview approval remains blocked: root=${rootPath}; blocked=${this.blockedRootValue}.`);
      return false;
    }
    const notice = await this.noticeForRoot(rootPath);
    if (!notice) {
      this.inspectedRoots.add(rootKey);
      this.deps.logPreview(`Large-preview approval not required: root=${rootPath}.`);
      return true;
    }

    const activeTab = this.deps.activeTab();
    this.blockedRootValue = rootPath;
    this.deps.logPreview(`Large-preview approval requested: root=${rootPath}; activeTab=${activeTab?.path ?? "none"}; lines=${notice.lineCount ?? "unknown"}; bytes=${notice.sizeBytes}.`);
    this.deps.setWorkspaceServicesDeferred(true);
    if (activeTab) {
      this.deps.showLargeFileConfirmation(activeTab, notice);
    } else {
      this.deps.previewFrame().setMessage(
        `<div class="preview-disabled-placeholder guardrail-paired-placeholder">` +
        `<div class="guardrail-placeholder-content">` +
        `<div class="preview-disabled-title">Preview Waiting for File Approval</div>` +
        `<div class="preview-disabled-msg">Open the large Typst file in the editor to start its compiler preview.</div>` +
        `</div></div>`,
      );
    }
    return false;
  }
}
