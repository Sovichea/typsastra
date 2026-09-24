import type { LspStatus } from "../compiler/lsp";
import { fileExtension, isBinaryImagePath, isMarkdownDocumentPath, isTypstDocumentPath } from "../platform/fileTypes";
import type { DraftPreviewController } from "./draftPreviewController";
import type { ImagePreviewController } from "./imagePreviewController";
import type { MarkdownPreviewFrame } from "./markdownPreviewFrame";
import type { PreviewFrame, PreviewInteractionStatus, PreviewPageStatus } from "./previewFrame";

/** Zoom bridge for the table tool's preview surface. */
export interface TablePreviewZoom {
  zoomIn(): boolean;
  zoomOut(): boolean;
  zoomToFit(): boolean;
  zoomPercent(): number | null;
  isFit(): boolean | null;
}

export interface PreviewUiDependencies {
  previewFrame: PreviewFrame;
  markdownPreviewFrame: MarkdownPreviewFrame;
  draftPreview: DraftPreviewController;
  imagePreview: ImagePreviewController;
  tablePreview: TablePreviewZoom;
  getActiveFilePath(): string | null;
  isInternallySupportedPath(path: string): boolean;
  setMarkdownPreviewActive(active: boolean): void;
  isDeveloperMode(): boolean;
  setLspStatus(status: LspStatus): void;
  log(kind: "info" | "warning", source: string, message: string): void;
}

/** Owns PDF preview toolbar, page controls, zoom controls, and interaction status UI. */
export class PreviewUiController {
  private pageStatusValue: PreviewPageStatus = { currentPage: 0, pageCount: 0 };

  public constructor(private readonly deps: PreviewUiDependencies) {}

  public get pageStatus(): PreviewPageStatus { return this.pageStatusValue; }

  public updateZoomLabel(zoomPercent?: number): void {
    const label = document.getElementById("preview-zoom-label");
    if (!label) return;

    const imageZoomPercent = this.deps.imagePreview.zoomPercent;
    const imageIsFit = this.deps.imagePreview.isFit;
    const tableZoomPercent = this.deps.tablePreview.zoomPercent();
    const tableIsFit = this.deps.tablePreview.isFit();
    if (imageZoomPercent !== null && imageIsFit !== null) {
      const pct = Math.round((zoomPercent ?? imageZoomPercent) * 100);
      label.textContent = imageIsFit ? "Fit" : `${pct}%`;
    } else if (tableZoomPercent !== null && tableIsFit !== null) {
      const pct = Math.round((zoomPercent ?? tableZoomPercent) * 100);
      label.textContent = tableIsFit ? "Fit" : `${pct}%`;
    } else {
      const pct = zoomPercent ?? this.deps.previewFrame.currentZoomPercent;
      label.textContent = this.deps.previewFrame.isFitMode ? "Fit" : `${pct}%`;
    }
  }

  public initializePageControls(): void {
    const input = document.getElementById("preview-page-input") as HTMLInputElement | null;
    if (!input || input.dataset.initialized === "true") return;
    input.dataset.initialized = "true";
    input.addEventListener("keydown", event => {
      if (event.key === "Enter") {
        event.preventDefault();
        this.commitPageInput();
        input.blur();
      } else if (event.key === "Escape") {
        event.preventDefault();
        input.value = String(this.pageStatusValue.currentPage || 1);
        input.blur();
      }
    });
    input.addEventListener("change", () => this.commitPageInput());
    input.addEventListener("wheel", event => {
      if (document.activeElement === input) event.preventDefault();
    }, { passive: false });
    this.updatePageStatus(this.pageStatusValue);
  }

  public updatePageStatus(status: PreviewPageStatus): void {
    this.pageStatusValue = status;
    const input = document.getElementById("preview-page-input") as HTMLInputElement | null;
    const count = document.getElementById("preview-page-count");
    if (input) {
      input.disabled = status.pageCount < 1;
      if (document.activeElement !== input) input.value = String(status.currentPage || 1);
      input.setAttribute("aria-valuemin", "1");
      input.setAttribute("aria-valuemax", String(Math.max(1, status.pageCount)));
      input.setAttribute("aria-valuenow", String(status.currentPage || 1));
    }
    if (count) count.textContent = String(status.pageCount);
  }

  public updateActionsToolbar(path: string | null): void {
    const previewActions = document.querySelector(".preview-actions");
    if (!previewActions) return;

    if (!path) {
      previewActions.classList.add("hidden");
      previewActions.classList.remove("markdown-preview-toolbar");
      this.deps.markdownPreviewFrame.deactivate();
      this.deps.setMarkdownPreviewActive(false);
      return;
    }

    const ext = fileExtension(path);
    const isImage = isBinaryImagePath(path);
    const isPdf = ext === "pdf";
    const isMarkdown = isMarkdownDocumentPath(path);
    const isUnsupported = !this.deps.isInternallySupportedPath(path);

    if (isUnsupported && !isImage && !isPdf) {
      previewActions.classList.add("hidden");
      return;
    }

    previewActions.classList.remove("hidden");
    previewActions.classList.toggle("markdown-preview-toolbar", isMarkdown);

    const showTypstOnly = isTypstDocumentPath(path);
    const contentModeToggle = document.getElementById("preview-content-mode-toggle");
    const recompileBtn = document.getElementById("preview-recompile-btn");
    const searchBtn = document.getElementById("preview-search-btn");
    const menuBtn = document.getElementById("preview-menu-btn");
    const imageWarningBtn = document.getElementById("preview-image-warning-btn");
    document.querySelector<HTMLElement>(".preview-page-controls")?.classList.toggle("hidden", isImage || isMarkdown);


    if (recompileBtn) {
      if (showTypstOnly) recompileBtn.classList.remove("hidden");
      else recompileBtn.classList.add("hidden");
    }
    searchBtn?.classList.toggle("hidden", !isPdf);
    if (menuBtn) {
      if (showTypstOnly || isPdf) menuBtn.classList.remove("hidden");
      else menuBtn.classList.add("hidden");
    }
    imageWarningBtn?.classList.toggle(
      "hidden",
      !showTypstOnly || imageWarningBtn.dataset.active !== "true",
    );
    contentModeToggle?.classList.toggle("hidden", !showTypstOnly);
    this.deps.draftPreview.updateControl();
  }

  public zoomIn(): void {
    if (!this.deps.imagePreview.zoomIn() && !this.deps.tablePreview.zoomIn()) {
      this.deps.previewFrame.zoomIn();
      this.updateZoomLabel();
    }
  }

  public zoomOut(): void {
    if (!this.deps.imagePreview.zoomOut() && !this.deps.tablePreview.zoomOut()) {
      this.deps.previewFrame.zoomOut();
      this.updateZoomLabel();
    }
  }

  public zoomToFit(): void {
    if (!this.deps.imagePreview.zoomToFit() && !this.deps.tablePreview.zoomToFit()) {
      this.deps.previewFrame.zoomToFit();
      this.updateZoomLabel();
    }
  }

  public reportInteractionStatus(status: PreviewInteractionStatus): void {
    if (!this.deps.isDeveloperMode()) return;
    const activeFilePath = this.deps.getActiveFilePath();
    if (!activeFilePath || !isTypstDocumentPath(activeFilePath)) {
      if (status.kind === "installed") {
        this.deps.log(
          "info",
          "preview iframe",
          `PDF interaction listener installed for ${status.url}; source synchronization is disabled for direct PDF documents.`,
        );
      }
      return;
    }
    if (status.kind === "debug") {
      this.deps.log("info", "preview iframe", status.reason ?? `Debug event for ${status.url}`);
      return;
    }
    if (status.kind === "installed") {
      this.deps.setLspStatus({ kind: "preview-ready", message: "Inverse sync source-map active" });
      this.deps.log(
        "info",
        "inverse sync",
        `Preview source-map click interception installed for ${status.url}`,
      );
      return;
    }
    this.deps.setLspStatus({ kind: "preview-ready", message: "Inverse sync source-map blocked" });
    this.deps.log(
      "warning",
      "inverse sync",
      `Preview source-map click interception blocked for ${status.url}: ${status.reason ?? "unknown reason"}. Inverse sync will use Tinymist's raw source position only.`,
    );
  }

  public commitPageInput(): void {
    const input = document.getElementById("preview-page-input") as HTMLInputElement | null;
    if (!input || this.pageStatusValue.pageCount < 1) return;
    const value = input.value.trim();
    if (!/^\d+$/.test(value)) {
      input.value = String(this.pageStatusValue.currentPage || 1);
      return;
    }
    const requested = Number.parseInt(value, 10);
    const pageNo = Math.max(1, Math.min(requested, this.pageStatusValue.pageCount));
    input.value = String(pageNo);
    this.deps.previewFrame.scrollToPage(pageNo);
  }
}
