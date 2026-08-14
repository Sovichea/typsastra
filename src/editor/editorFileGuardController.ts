import { invoke } from "@tauri-apps/api/core";
import { message } from "@tauri-apps/plugin-dialog";
import { fileExtension, isTypstDocumentPath } from "../platform/fileTypes";
import { fileNameFromPath } from "../platform/paths";
import type { PreviewFrame } from "../preview/previewFrame";
import { formatFileSize, type LargeFileOpeningNotice } from "../workspace/largeFileOpening";
import type { EditorTab } from "./editorTab";

type EditorFileGuardDependencies = {
  previewFrame: () => PreviewFrame;
  onPdfBlocked: (path: string) => void;
  onPdfUnblocked: (path: string) => void;
  onPdfReblocked: (path: string) => void;
  onTypstPreviewBlocked: (rootPath: string) => void;
  approveLargePreview: (tab: EditorTab, notice: LargeFileOpeningNotice) => Promise<void>;
  activateConfirmedTab: (path: string) => Promise<void>;
  startConfirmedTypstPreview(): Promise<void>;
  onGuardedTabSelected: (path: string) => void;
  logPreview(message: string): void;
};

export class EditorFileGuardController {
  private alignmentObserver: ResizeObserver | null = null;

  constructor(private readonly deps: EditorFileGuardDependencies) {}

  renderNonTextPlaceholder(path: string, unsupported: boolean): void {
    const info = document.getElementById("image-viewer-info");
    if (!info) return;

    const placeholder = document.createElement("div");
    placeholder.className = "preview-disabled-placeholder editor-file-placeholder";
    const isPdf = fileExtension(path) === "pdf";

    const icon = document.createElement("div");
    icon.className = "preview-disabled-icon";
    icon.textContent = isPdf ? "\u{1F4C4}" : (unsupported ? "\u{1F4C4}" : "\u{1F4BE}");

    const title = document.createElement("div");
    title.className = "preview-disabled-title";
    title.textContent = isPdf ? "PDF Document" : (unsupported ? "Unsupported File" : "Binary File");

    const fileName = document.createElement("div");
    fileName.className = "editor-file-placeholder-name";
    fileName.textContent = fileNameFromPath(path);

    const description = document.createElement("div");
    description.className = "preview-disabled-msg";
    description.textContent = isPdf
      ? "This document is displayed in the live preview pane."
      : unsupported
        ? "This file format cannot be displayed in Typsastra."
        : "Cannot load raw binary in the text editor.";

    placeholder.append(icon, title, fileName, description);
    if (unsupported || isPdf) {
      const openButton = document.createElement("button");
      openButton.type = "button";
      openButton.className = "editor-file-placeholder-action";
      openButton.textContent = "Open Externally";
      openButton.addEventListener("click", () => void this.openFileExternally(path, openButton));
      placeholder.appendChild(openButton);
    }
    info.replaceChildren(placeholder);
  }

  showLargeFileConfirmation(tab: EditorTab, notice: LargeFileOpeningNotice): void {
    const path = tab.path;
    const codeRenderPane = document.getElementById("code-render-pane");
    const imageViewerPane = document.getElementById("image-viewer-pane");
    const imageViewerImg = document.getElementById("image-viewer-img") as HTMLImageElement | null;
    const info = document.getElementById("image-viewer-info");

    codeRenderPane?.classList.add("hidden");
    imageViewerPane?.classList.remove("hidden");
    if (imageViewerImg) imageViewerImg.style.display = "none";
    document.getElementById("wysiwym-editor-pane")?.classList.add("hidden");

    const previewFrame = this.deps.previewFrame();
    if (notice.kind === "pdf") {
      this.deps.onPdfBlocked(path);
    } else if (isTypstDocumentPath(path)) {
      this.deps.onTypstPreviewBlocked(notice.previewRootPath ?? path);
      previewFrame.setMessage(
        `<div class="preview-disabled-placeholder guardrail-paired-placeholder guardrail-preview-placeholder">` +
        `<div class="guardrail-placeholder-content">` +
        `<div class="preview-disabled-title">Preview Not Started</div>` +
        `<div class="preview-disabled-msg">The compiler preview will start after you confirm opening the large Typst file.</div>` +
        `</div></div>`,
      );
    } else {
      previewFrame.setMessage(
        `<div class="preview-disabled-placeholder">` +
        `<div class="preview-disabled-title">Preview Unavailable</div>` +
        `<div class="preview-disabled-msg">Live preview is not supported for this text file.</div>` +
        `</div>`,
      );
    }

    if (info) this.renderLargeFileEditorConfirmation(info, tab, notice);
    this.observeAlignment();
    this.deps.onGuardedTabSelected(path);
  }

  clearAlignment(): void {
    this.alignmentObserver?.disconnect();
    this.alignmentObserver = null;
  }

  private renderLargeFileEditorConfirmation(
    info: HTMLElement,
    tab: EditorTab,
    notice: LargeFileOpeningNotice,
  ): void {
    const path = tab.path;
    const placeholder = document.createElement("div");
    placeholder.className = "preview-disabled-placeholder editor-file-placeholder guardrail-paired-placeholder";
    const content = document.createElement("div");
    content.className = "guardrail-placeholder-content";

    const icon = document.createElement("div");
    icon.className = "preview-disabled-icon";
    icon.textContent = "📄";

    const title = document.createElement("div");
    title.className = "preview-disabled-title";
    title.textContent = notice.kind === "pdf"
      ? "Large PDF Document"
      : isTypstDocumentPath(path)
        ? "Large Typst Document"
        : "Large Text File";

    const fileName = document.createElement("div");
    fileName.className = "editor-file-placeholder-name";
    fileName.textContent = fileNameFromPath(path);

    const description = document.createElement("div");
    description.className = "preview-disabled-msg";
    const work = notice.kind === "pdf"
      ? "Confirm in the preview pane before Typsastra decodes and renders it."
      : notice.kind === "main-preview"
        ? `This file belongs to a large preview rooted at ${fileNameFromPath(notice.previewRootPath ?? "the configured main file")}. Opening it will initialize the editor and start that compiler preview.`
        : isTypstDocumentPath(path)
          ? "Opening it will initialize the editor and start its compiler preview."
          : "Opening it will initialize the editor, folding, outline, and language tools.";
    const scale = notice.lineCount !== undefined
      ? `${notice.lineCount.toLocaleString()} lines, ${formatFileSize(notice.sizeBytes)}`
      : formatFileSize(notice.sizeBytes);
    description.textContent = notice.kind === "main-preview"
      ? `The effective preview contains ${scale}. ${work}`
      : `This file is ${scale}. ${work}`;

    const openConfirmedFile = async () => {
      this.deps.logPreview(`Large-file confirmation accepted: tab=${path}; kind=${notice.kind}; noticeRoot=${notice.previewRootPath ?? "none"}.`);
      if (notice.kind === "pdf") {
        this.deps.onPdfUnblocked(path);
      } else if (isTypstDocumentPath(path)) {
        await this.deps.approveLargePreview(tab, notice);
      }
      try {
        await this.deps.activateConfirmedTab(path);
        this.deps.logPreview(`Large-file confirmed tab activated: tab=${path}; kind=${notice.kind}.`);
        // Activation owns editor/LSP preparation. Start the confirmed
        // low-memory/live preview explicitly afterward so an earlier
        // guardrail result cannot leave the preview waiting for a tab switch.
        if (isTypstDocumentPath(path)) {
          this.deps.logPreview(`Large-file confirmation requests explicit preview refresh: tab=${path}.`);
          await this.deps.startConfirmedTypstPreview();
          this.deps.logPreview(`Large-file explicit preview refresh completed: tab=${path}.`);
        }
      } catch (error) {
        if (notice.kind === "pdf") this.deps.onPdfReblocked(path);
        throw error;
      }
    };

    content.append(icon, title, fileName, description);
    if (notice.kind === "pdf") {
      this.deps.previewFrame().setConfirmationMessage({
        title: "Large PDF Preview Not Started",
        message: `${fileNameFromPath(path)} is ${formatFileSize(notice.sizeBytes)}. Opening it will decode the PDF and begin rendering visible pages.`,
        confirmLabel: "Open Large PDF",
        pairedGuardrail: true,
        onConfirm: openConfirmedFile,
      });
    } else {
      const confirmButton = document.createElement("button");
      confirmButton.type = "button";
      confirmButton.className = "editor-file-placeholder-action";
      const confirmLabel = isTypstDocumentPath(path) ? "Open and Compile Preview" : "Open Large File";
      confirmButton.textContent = confirmLabel;
      confirmButton.addEventListener("click", () => {
        confirmButton.disabled = true;
        confirmButton.textContent = "Opening…";
        void openConfirmedFile().catch(error => {
          console.error("Failed to open large file:", error);
          confirmButton.disabled = false;
          confirmButton.textContent = confirmLabel;
          void message(`Could not open ${fileNameFromPath(path)}: ${String(error)}`, {
            title: "Unable to Open File",
            kind: "error",
          });
        });
      });
      content.append(confirmButton);
    }
    placeholder.append(content);
    info.replaceChildren(placeholder);
  }

  private observeAlignment(): void {
    this.alignmentObserver?.disconnect();
    const editorHost = document.getElementById("image-viewer-pane");
    const previewHost = document.getElementById("preview-render-pane");
    const previewContent = previewHost?.querySelector<HTMLElement>(
      ".guardrail-preview-placeholder .guardrail-placeholder-content",
    );
    if (!editorHost || !previewHost || !previewContent) return;

    const align = () => {
      const editorRect = editorHost.getBoundingClientRect();
      const previewRect = previewHost.getBoundingClientRect();
      const editorCenter = editorRect.top + editorRect.height / 2;
      const previewCenter = previewRect.top + previewRect.height / 2;
      previewContent.style.setProperty("--guardrail-center-offset", `${editorCenter - previewCenter}px`);
    };
    align();
    this.alignmentObserver = new ResizeObserver(align);
    this.alignmentObserver.observe(editorHost);
    this.alignmentObserver.observe(previewHost);
    const editorToolbar = document.getElementById("editor-visual-toolbar");
    if (editorToolbar) this.alignmentObserver.observe(editorToolbar);
  }

  async openFileExternally(path: string, button?: HTMLButtonElement): Promise<void> {
    if (button) button.disabled = true;
    try {
      await invoke("open_file_externally", { path });
    } catch (error) {
      console.error("Failed to open file externally:", error);
      await message(`The file could not be opened externally.\n\n${String(error)}`, {
        title: "Open External File Failed",
        kind: "error",
      });
    } finally {
      if (button?.isConnected) button.disabled = false;
    }
  }
}
