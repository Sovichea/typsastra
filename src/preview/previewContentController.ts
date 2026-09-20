import { invoke } from "@tauri-apps/api/core";
import type { EditorTab } from "../editor/editorTab";
import {
  fileExtension,
  isBinaryImagePath,
  isMarkdownDocumentPath,
  isTypstDocumentPath,
} from "../platform/fileTypes";
import type { PreviewRenderMode } from "../settings";
import { LatestRequestGuard } from "../workspace/latestRequestGuard";
import type { ImagePreviewController } from "./imagePreviewController";
import type { MarkdownPreviewFrame } from "./markdownPreviewFrame";
import type { PreviewFrame } from "./previewFrame";
import {
  previewLspMainPath,
  previewRefreshStyle,
  previewSessionIdentity,
  researchDocumentIdentity,
  type PreviewTarget,
} from "./previewPolicy";

function normalizeEditorText(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

export interface PreviewContentDependencies {
  previewFrame: PreviewFrame;
  imagePreview: ImagePreviewController;
  markdownPreview: MarkdownPreviewFrame;
  setMarkdownPreviewActive(active: boolean): void;
  isImageToolActive(): boolean;
  isTableToolActive(): boolean;
  getActiveFilePath(): string | null;
  getPinnedMainFilePath(): string | null;
  getWorkspaceRootPath(): string | null;
  getPreviewSessionKey(): string | null;
  getPreviewRenderMode(): PreviewRenderMode;
  getActiveTab(): EditorTab | null;
  getEditorText(): string;
  isInternallySupportedPath(path: string): boolean;
  updateActionsToolbar(path: string): void;
  prepareTemplateAwarePreview(
    target: PreviewTarget,
    activePath: string,
    contents: string,
  ): Promise<PreviewTarget>;
  ensureLargePreviewApproved(rootPath: string | null): Promise<boolean>;
  updatePinnedMain(path: string | null): Promise<boolean>;
  applyPreviewTargetToTab(tab: EditorTab, target: PreviewTarget): void;
  configureDocumentLanguageTools(contents: string): void;
  invalidatePreviewWork(reason: string): void;
  renderPdfPreview(contents: string): Promise<void>;
  loadPdfPath(path: string, identity: string): Promise<number>;
  setPreviewPaneHtml(html: string): void;
}

/** Owns selection of the active preview surface and restoration of document preview content. */
export class PreviewContentController {
  private readonly refreshRequests = new LatestRequestGuard<"preview">();

  public constructor(private readonly deps: PreviewContentDependencies) {}

  public suspendDocumentPreviewForImageTools(): void {
    this.deps.markdownPreview.deactivate();
    this.deps.setMarkdownPreviewActive(false);
  }

  public restoreMarkdownPreviewIfActive(): boolean {
    const tab = this.deps.getActiveTab();
    if (!tab || !isMarkdownDocumentPath(tab.path)) return false;
    this.deps.imagePreview.clear();
    this.deps.setMarkdownPreviewActive(true);
    this.deps.markdownPreview.activate(tab.path, tab.content);
    this.deps.updateActionsToolbar(tab.path);
    return true;
  }

  public noMainFileMessage(): string {
    return (
      `<div class="preview-disabled-placeholder">` +
      `<div class="preview-disabled-title preview-accent-title" style="font-size:18px;margin-bottom:12px;">No Main File Selected</div>` +
      `<div class="preview-disabled-msg">Right-click any <code style="background:var(--ui-hover);padding:1px 5px;border-radius:3px;">.typ</code> file in the Explorer and choose <strong>Set as Main File</strong> to enable live preview and export.</div>` +
      `</div>`
    );
  }

  public disabledPreviewMessage(): string {
    return (
      `<div class="preview-disabled-placeholder">` +
      `<div class="preview-disabled-icon">🚫</div>` +
      `<div class="preview-disabled-title">Preview Unavailable</div>` +
      `<div class="preview-disabled-msg">This file is not imported or included by the main document. Only the main file and its dependencies are previewed.</div>` +
      `<div class="preview-disabled-msg" style="margin-top: 8px; font-size: 12px; opacity: 0.75;">Include this file from the configured main document to preview it.</div>` +
      `</div>`
    );
  }

  public renderImageToolPreview(source: string | null, imagePath?: string): void {
    if (!this.deps.isImageToolActive()) return;
    if (!source) {
      this.deps.imagePreview.clear();
      this.deps.updateActionsToolbar(imagePath ?? "image-tools.png");
      if (imagePath) {
        this.deps.previewFrame.setLoading("Preparing image preview…", false);
        return;
      }
      this.deps.previewFrame.setMessage(
        `<div class="preview-disabled-placeholder">` +
        `<div class="guardrail-placeholder-content">` +
        `<div class="preview-disabled-title preview-accent-title">Image Preview</div>` +
        `<div class="preview-disabled-msg">Select an image in the sidebar to preview it.</div>` +
        `</div></div>`,
      );
      return;
    }
    this.renderInteractiveImageViewer(source, imagePath);
  }

  public renderInteractiveImageViewer(
    src: string,
    previewPath = this.deps.getActiveFilePath() ?? "preview.png",
  ): void {
    this.deps.imagePreview.render(src, previewPath);
  }

  public async refreshActivePreviewRoot(forceRender = false): Promise<void> {
    const request = this.refreshRequests.begin("preview");
    // A tool surface owns the preview pane; the document must not reclaim it.
    if (this.deps.isImageToolActive() || this.deps.isTableToolActive()) return;
    const path = this.deps.getActiveFilePath();
    if (!path) return;
    const activeTab = this.deps.getActiveTab();
    const workspaceRootPath = this.deps.getWorkspaceRootPath();
    const pinnedMainPath = this.deps.getPinnedMainFilePath();
    const previewRenderMode = this.deps.getPreviewRenderMode();
    const isCurrent = () => (
      this.refreshRequests.isCurrent(request)
      && this.deps.getActiveFilePath() === path
      && this.deps.getActiveTab() === activeTab
      && this.deps.getWorkspaceRootPath() === workspaceRootPath
    );
    const ext = fileExtension(path);
    const unsupportedFile = !this.deps.isInternallySupportedPath(path);
    const isPdf = ext === "pdf";

    this.deps.imagePreview.clear();
    this.deps.updateActionsToolbar(path);

    if (unsupportedFile || isBinaryImagePath(path) || isPdf) {
      if (!activeTab) return;
      if (isBinaryImagePath(path)) {
        this.renderInteractiveImageViewer(activeTab.content);
      } else if (isPdf) {
        void this.deps.loadPdfPath(path, path);
      } else {
        this.deps.previewFrame.setMessage(
          `<div class="preview-disabled-placeholder">` +
          `<div class="preview-disabled-title">Preview Unavailable</div>` +
          `<div class="preview-disabled-msg">Open this file with its system application to view it.</div>` +
          `</div>`,
        );
      }
      return;
    }

    if (ext === "svg") {
      this.deps.previewFrame.setMessageOverlay(
        `<div style="display:flex;align-items:center;justify-content:center;height:100%;width:100%;background:var(--ui-bg);box-sizing:border-box;padding:20px;overflow:auto;">` +
        this.deps.getEditorText() +
        `</div>`,
      );
      return;
    }
    if (!isTypstDocumentPath(path)) {
      this.deps.previewFrame.setMessageOverlay(
        `<div class="preview-disabled-placeholder">` +
        `<div class="preview-disabled-title">Preview Unavailable</div>` +
        `<div class="preview-disabled-msg">Live preview is not supported for ${ext.toUpperCase() || "this"} files.</div>` +
        `</div>`,
      );
      return;
    }
    if (!pinnedMainPath) {
      this.deps.previewFrame.setMessage(this.noMainFileMessage());
      return;
    }
    const contents = activeTab?.contentLoaded
      ? this.deps.getEditorText()
      : normalizeEditorText(await invoke<string>("read_workspace_file", { path }));
    if (!isCurrent()) return;
    let target = await invoke<PreviewTarget>("resolve_preview_main", {
      filePath: path,
      workspaceRootPath,
      fileContents: contents,
      pinnedMainPath,
    });
    if (!isCurrent()) return;
    if (target.disabled) {
      if (activeTab) {
        this.deps.applyPreviewTargetToTab(activeTab, target);
        this.deps.configureDocumentLanguageTools(contents);
      }
      this.deps.invalidatePreviewWork(`${path} does not participate in the configured main preview`);
      this.deps.previewFrame.setMessage(this.disabledPreviewMessage());
      return;
    }
    target = await this.deps.prepareTemplateAwarePreview(target, path, contents);
    if (!isCurrent()) return;
    const approved = await this.deps.ensureLargePreviewApproved(target.rootPath);
    if (!isCurrent()) return;
    if (!approved) {
      if (activeTab) {
        this.deps.applyPreviewTargetToTab(activeTab, target);
        this.deps.configureDocumentLanguageTools(contents);
      }
      return;
    }
    await this.deps.updatePinnedMain(previewLspMainPath(target));
    if (!isCurrent()) return;
    const docIdentity = target.rootPath
      ? researchDocumentIdentity(
          workspaceRootPath ?? target.rootPath,
          target.mainPath,
          path,
        )
      : null;
    const identity = target.rootPath
      ? previewSessionIdentity(
          target.rootPath,
          previewRefreshStyle(previewRenderMode),
          docIdentity ?? undefined,
        )
      : null;
    const unchanged = identity?.key === this.deps.getPreviewSessionKey();
    if (!activeTab) return;
    this.deps.applyPreviewTargetToTab(activeTab, target);
    this.deps.configureDocumentLanguageTools(contents);
    // A tool surface can temporarily replace and unmount the preview without
    // changing the underlying document session. Only reuse an unchanged
    // session while its preview is still mounted; otherwise restore it.
    if (unchanged && !forceRender && this.deps.previewFrame.currentUrl) return;

    if (!target.rootPath) {
      this.deps.setPreviewPaneHtml(`<div style="padding: 20px; color: var(--ui-header-text); font-family: var(--font-family-sans);">No preview root found for this library/template file. Diagnostics are still active.</div>`);
      return;
    }

    if (!isCurrent()) return;
    await this.deps.renderPdfPreview(contents);
  }
}
