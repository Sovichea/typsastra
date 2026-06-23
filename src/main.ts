import "./style.css";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { getEditorExtensions } from "./editor/extensions";
import { WorkspaceExplorer } from "./components/explorer";
import { TinymistLspClient } from "./compiler/lsp";
import type { LspSourcePosition, LspStatus } from "./compiler/lsp";

type EditorMode = "CODE" | "WYSIWYM";

type PreviewHighlightMapping = {
  lineNumber: number;
  lineFrom: number;
  originalStart: number;
  originalEnd: number;
  highlightedStart: number;
  highlightedEnd: number;
  wrapperEnd: number;
  highlightedLineText: string;
};

class TypstryWorkspaceController {
  private readonly previewTaskId = "default_preview";
  private readonly previewHighlightPrefix = "#highlight[";
  private readonly previewHighlightSuffix = "]";
  private activeMode: EditorMode = "CODE";
  private activeFilePath: string | null = null;
  private currentVersion = 1;
  private isLoadingFile = false;
  private lspReady = false;
  private readonly lspSyncDebounceMs = 350;
  private readonly forwardSyncDebounceMs = 120;
  private pendingLspSyncTimer: number | null = null;
  private pendingLspSyncPath: string | null = null;
  private pendingLspSyncText: string | null = null;
  private pendingForwardSyncTimer: number | null = null;
  private suppressNextForwardSync = false;
  private previewHighlightMapping: PreviewHighlightMapping | null = null;

  private editorInstance!: EditorView;
  private explorer!: WorkspaceExplorer;
  private lspClient!: TinymistLspClient;

  private codePane = document.getElementById("code-editor-pane")!;
  private wysiwymPane = document.getElementById("wysiwym-editor-pane")!;
  private wysiwymContainer = this.wysiwymPane.querySelector(".wysiwym-container")!;
  private previewPane = document.getElementById("preview-render-pane")!;
  private previewIframe: HTMLIFrameElement | null = null;
  private lspStatus = document.getElementById("lsp-status")!;
  private lspStatusDot = this.lspStatus.querySelector(".status-dot") as HTMLElement;
  private lspStatusText = this.lspStatus.querySelector(".status-text") as HTMLElement;

  public async bootstrap() {
    this.setLspStatus({ kind: "starting", message: "Preparing toolchain" });
    await this.ensureDependencies();
    this.initCodeMirror();
    this.initExplorer();
    await this.initLsp();
    this.bindGlobalEvents();
  }

  private async ensureDependencies() {
    this.previewPane.innerHTML = `<div style="padding: 20px; color: #007acc; font-family: sans-serif; text-align: center;">
      <h3>Initializing Typstry Editor</h3>
      <p>Checking and downloading required compiler toolchains (Typst, Tinymist). This may take a minute...</p>
    </div>`;

    try {
      await invoke("ensure_toolchain");
    } catch (e) {
      console.error("Toolchain setup failed:", e);
      this.previewPane.innerHTML = `<div style="padding: 20px; color: red;">Failed to download toolchain: ${e}</div>`;
      return;
    }

    this.previewPane.innerHTML = `<div style="padding: 20px; color: #008000; font-family: sans-serif; text-align: center;">Toolchain Ready.</div>`;
  }

  private initCodeMirror() {
    this.editorInstance = new EditorView({
      state: EditorState.create({
        doc: "= Welcome to Typstry\nSelect a file from the explorer to begin configuration editing.",
        extensions: [
          getEditorExtensions(),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              this.handleContentMutation(update.state.doc.toString());
            } else if (update.selectionSet) {
              this.scheduleForwardSync(this.forwardSyncDebounceMs);
            }
          })
        ]
      }),
      parent: this.codePane
    });
  }

  private initExplorer() {
    this.explorer = new WorkspaceExplorer(document.getElementById("explorer-sidebar")!, (path) => this.loadFile(path));
  }

  private async initLsp() {
    this.lspClient = new TinymistLspClient(
      () => {},
      (status) => this.setLspStatus(status),
      (position, defaultCursorPos) => this.handleInverseSync(position, defaultCursorPos)
    );
    try {
      await this.lspClient.connect();
      this.lspReady = true;
    } catch (e) {
      this.lspReady = false;
      console.warn("Tinymist LSP instance offline.", e);
    }
    this.lspClient.setEditorView(this.editorInstance);
  }

  private async loadFile(path: string) {
    try {
      const contents: string = await invoke("read_workspace_file", { path });
      this.currentVersion = 1;
      this.previewHighlightMapping = null;

      this.isLoadingFile = true;
      try {
        this.editorInstance.dispatch({
          changes: { from: 0, to: this.editorInstance.state.doc.length, insert: contents }
        });
      } finally {
        this.isLoadingFile = false;
      }

      this.activeFilePath = path;
      this.clearPendingLspSync();
      this.clearPendingForwardSync();

      if (this.lspReady && this.lspClient) {
        this.previewPane.innerHTML = `<div style="padding: 20px; color: #007acc; font-family: sans-serif;">Starting live preview server...</div>`;
        const uri = this.filePathToUri(path);
        const previewUrl = await this.lspClient.notifyTextOpen(uri, path, contents, this.currentVersion);
        if (previewUrl) {
          this.mountPreviewFrame(previewUrl);
        } else {
          this.previewPane.innerHTML = `<div style="padding: 20px; color: red; font-family: sans-serif;">Failed to start live preview server. Check the developer console or LSP log for details.</div>`;
        }
      } else {
        this.previewPane.innerHTML = `<div style="padding: 20px; color: red; font-family: sans-serif;">Tinymist LSP is offline. Live preview is unavailable.</div>`;
      }

      if (this.activeMode === "WYSIWYM") {
        this.mapMarkupToWysiwym(contents);
      }
    } catch (e) {
      console.error("Failed to load file:", e);
      alert("Failed to load file: " + e);
    }
  }

  private handleContentMutation(rawText: string) {
    if (!this.isLoadingFile && this.activeFilePath && this.lspReady && this.lspClient) {
      this.pendingLspSyncPath = this.activeFilePath;
      this.pendingLspSyncText = rawText;
      this.setLspStatus({ kind: "sync-pending", message: "Preview update queued" });

      if (this.pendingLspSyncTimer) {
        window.clearTimeout(this.pendingLspSyncTimer);
      }

      this.pendingLspSyncTimer = window.setTimeout(
        () => this.flushPendingLspSync(),
        this.lspSyncDebounceMs
      );
    }
  }

  private flushPendingLspSync() {
    if (this.pendingLspSyncTimer) {
      window.clearTimeout(this.pendingLspSyncTimer);
      this.pendingLspSyncTimer = null;
    }

    if (!this.pendingLspSyncPath || this.pendingLspSyncText === null || !this.lspReady || !this.lspClient) {
      return;
    }

    const path = this.pendingLspSyncPath;
    const text = this.pendingLspSyncText;
    this.pendingLspSyncPath = null;
    this.pendingLspSyncText = null;

    this.setLspStatus({ kind: "syncing", message: "Syncing preview" });
    this.previewHighlightMapping = null;
    this.lspClient.notifyTextChange(this.filePathToUri(path), text, ++this.currentVersion);
    this.scheduleForwardSync(450);
    window.setTimeout(() => {
      if (this.lspReady && !this.pendingLspSyncTimer && this.pendingLspSyncText === null) {
        this.setLspStatus({ kind: "preview-ready", message: "Preview update sent" });
      }
    }, 250);
  }

  private clearPendingLspSync() {
    if (this.pendingLspSyncTimer) {
      window.clearTimeout(this.pendingLspSyncTimer);
      this.pendingLspSyncTimer = null;
    }
    this.pendingLspSyncPath = null;
    this.pendingLspSyncText = null;
  }

  private scheduleForwardSync(delayMs: number) {
    if (!this.activeFilePath || !this.lspReady || !this.lspClient) {
      return;
    }

    if (this.suppressNextForwardSync) {
      this.suppressNextForwardSync = false;
      this.clearPendingForwardSync();
      return;
    }

    if (this.pendingForwardSyncTimer) {
      window.clearTimeout(this.pendingForwardSyncTimer);
    }

    this.pendingForwardSyncTimer = window.setTimeout(
      () => { void this.flushForwardSync(); },
      delayMs
    );
  }

  private async flushForwardSync() {
    if (this.pendingForwardSyncTimer) {
      window.clearTimeout(this.pendingForwardSyncTimer);
      this.pendingForwardSyncTimer = null;
    }

    const cursor = this.editorInstance.state.selection.main.head;
    await this.renderHighlightedPreviewAtCursor(cursor);
  }

  private async renderHighlightedPreviewAtCursor(cursor: number) {
    if (!this.activeFilePath || !this.lspReady || !this.lspClient) {
      return;
    }

    const previewHighlight = this.buildHighlightedPreviewSource(cursor);
    if (!previewHighlight) return;

    this.previewHighlightMapping = previewHighlight.mapping;
    await this.lspClient.notifyTextChange(
      this.filePathToUri(this.activeFilePath),
      previewHighlight.text,
      ++this.currentVersion
    );
    window.setTimeout(() => {
      if (!this.activeFilePath || !this.lspReady || !this.lspClient) return;
      void this.lspClient.scrollPreview(this.previewTaskId, {
        event: "panelScrollTo",
        filepath: this.activeFilePath,
        line: previewHighlight.scrollLine,
        character: previewHighlight.scrollCharacter
      });
    }, 220);
  }

  private clearPendingForwardSync() {
    if (this.pendingForwardSyncTimer) {
      window.clearTimeout(this.pendingForwardSyncTimer);
      this.pendingForwardSyncTimer = null;
    }
  }

  private suppressForwardSyncOnce() {
    this.suppressNextForwardSync = true;
    this.clearPendingForwardSync();
  }

  private handleInverseSync(position: LspSourcePosition, defaultCursorPos: number): number {
    this.suppressForwardSyncOnce();
    const cursor = this.previewSourcePositionToEditorCursor(position, defaultCursorPos);
    window.setTimeout(() => {
      void this.renderHighlightedPreviewAtCursor(cursor);
    }, 0);
    return cursor;
  }

  private previewSourcePositionToEditorCursor(position: LspSourcePosition, defaultCursorPos: number): number {
    const mapping = this.previewHighlightMapping;
    if (!mapping || position.line + 1 !== mapping.lineNumber) {
      return defaultCursorPos;
    }

    const highlightedOffset = this.utf8ByteOffsetToStringOffset(mapping.highlightedLineText, position.character ?? 0);
    let originalOffset: number;

    if (highlightedOffset < mapping.originalStart) {
      originalOffset = highlightedOffset;
    } else if (highlightedOffset < mapping.highlightedStart) {
      originalOffset = mapping.originalStart;
    } else if (highlightedOffset <= mapping.highlightedEnd) {
      originalOffset = mapping.originalStart + highlightedOffset - mapping.highlightedStart;
    } else if (highlightedOffset <= mapping.wrapperEnd) {
      originalOffset = mapping.originalEnd;
    } else {
      originalOffset = highlightedOffset - this.previewHighlightPrefix.length - this.previewHighlightSuffix.length;
    }

    const line = this.editorInstance.state.doc.line(mapping.lineNumber);
    return Math.max(line.from, Math.min(mapping.lineFrom + originalOffset, line.to));
  }

  private mountPreviewFrame(previewUrl: string) {
    this.previewPane.innerHTML = "";
    const iframe = document.createElement("iframe");
    iframe.src = previewUrl;
    iframe.className = "preview-frame";
    iframe.addEventListener("load", () => this.suppressPreviewRippleStyles());
    this.previewPane.appendChild(iframe);
    this.previewIframe = iframe;
  }

  private suppressPreviewRippleStyles() {
    try {
      const doc = this.previewIframe?.contentDocument;
      if (!doc || doc.getElementById("typstry-disable-preview-ripple")) return;

      const style = doc.createElement("style");
      style.id = "typstry-disable-preview-ripple";
      style.textContent = ".typst-jump-ripple{display:none!important;animation:none!important;}";
      doc.head.appendChild(style);
    } catch {
      // The preview server may be cross-origin; in that case Tinymist owns its internals.
    }
  }

  private buildHighlightedPreviewSource(cursor: number): { text: string; scrollLine: number; scrollCharacter: number; mapping: PreviewHighlightMapping } | null {
    const range = this.wordRangeAtCursor(cursor);
    if (!range) return null;

    const text = this.editorInstance.state.doc.toString();
    const prefix = this.previewHighlightPrefix;
    const suffix = this.previewHighlightSuffix;
    const line = this.editorInstance.state.doc.lineAt(range.from);
    const cursorInWord = Math.max(0, Math.min(cursor - range.from, range.to - range.from));
    const originalStart = range.from - line.from;
    const originalEnd = range.to - line.from;
    const linePrefix = line.text.slice(0, originalStart);
    const word = line.text.slice(originalStart, originalEnd);
    const highlightedLinePrefix = `${linePrefix}${prefix}${line.text.slice(originalStart, originalStart + cursorInWord)}`;
    const highlightedLineText = `${linePrefix}${prefix}${word}${suffix}${line.text.slice(originalEnd)}`;

    return {
      text: `${text.slice(0, range.from)}${prefix}${text.slice(range.from, range.to)}${suffix}${text.slice(range.to)}`,
      scrollLine: line.number - 1,
      scrollCharacter: this.utf8ByteLength(highlightedLinePrefix),
      mapping: {
        lineNumber: line.number,
        lineFrom: line.from,
        originalStart,
        originalEnd,
        highlightedStart: originalStart + prefix.length,
        highlightedEnd: originalStart + prefix.length + word.length,
        wrapperEnd: originalEnd + prefix.length + suffix.length,
        highlightedLineText
      }
    };
  }

  private wordRangeAtCursor(cursor: number): { from: number; to: number } | null {
    const doc = this.editorInstance.state.doc;
    if (!doc.length) return null;

    const line = doc.lineAt(Math.min(cursor, doc.length));
    const lineText = line.text;
    let index = Math.max(0, Math.min(cursor - line.from, lineText.length));

    if (index === lineText.length || !this.isWordChar(lineText[index])) {
      const previousIndex = this.previousCodePointIndex(lineText, index);
      if (previousIndex === null || !this.isWordChar(lineText[previousIndex])) {
        return null;
      }
      index = previousIndex;
    }

    let start = index;
    while (true) {
      const previousIndex = this.previousCodePointIndex(lineText, start);
      if (previousIndex === null || !this.isWordChar(lineText[previousIndex])) break;
      start = previousIndex;
    }

    let end = index;
    while (end < lineText.length && this.isWordChar(lineText[end])) {
      end += lineText.codePointAt(end)! > 0xffff ? 2 : 1;
    }

    return end > start ? { from: line.from + start, to: line.from + end } : null;
  }

  private previousCodePointIndex(text: string, index: number): number | null {
    if (index <= 0) return null;
    const previous = index - 1;
    return previous > 0 && /[\uDC00-\uDFFF]/.test(text[previous]) ? previous - 1 : previous;
  }

  private isWordChar(char: string | undefined): boolean {
    return !!char && /[\p{L}\p{N}\p{M}_-]/u.test(char);
  }

  private utf8ByteLength(text: string): number {
    return new TextEncoder().encode(text).length;
  }

  private filePathToUri(path: string): string {
    const normalizedPath = path.replace(/\\/g, "/");
    const encodedPath = normalizedPath
      .split("/")
      .map((part, index) => index === 0 && /^[A-Za-z]:$/.test(part) ? part : encodeURIComponent(part))
      .join("/");

    return `file:///${encodedPath}`;
  }

  private setLspStatus(status: LspStatus) {
    this.lspStatus.dataset.state = status.kind;
    this.lspStatusDot.setAttribute("aria-label", status.message);
    this.lspStatusText.textContent = status.message;

    if (status.kind === "stopped" || status.kind === "error") {
      this.lspReady = false;
    }
  }

  private switchViewLayoutMode() {
    if (this.activeMode === "CODE") {
      this.activeMode = "WYSIWYM";
      this.mapMarkupToWysiwym(this.editorInstance.state.doc.toString());
      this.codePane.classList.add("hidden");
      this.wysiwymPane.classList.remove("hidden");
    } else {
      this.activeMode = "CODE";
      const markup = this.mapWysiwymToMarkup();
      this.editorInstance.dispatch({
        changes: { from: 0, to: this.editorInstance.state.doc.length, insert: markup }
      });
      this.wysiwymPane.classList.add("hidden");
      this.codePane.classList.remove("hidden");
    }
  }

  private bindGlobalEvents() {
    listen("menu-toggle-layout", () => this.switchViewLayoutMode());
    listen("menu-open-folder", async () => {
      const selected = await open({ directory: true, multiple: false });
      if (typeof selected === "string") this.explorer.loadWorkspace(selected);
    });
    this.wysiwymContainer.addEventListener("input", () => {
      if (this.activeMode === "WYSIWYM") {
        const generatedMarkup = this.mapWysiwymToMarkup();
        this.handleContentMutation(generatedMarkup);
      }
    });

    this.previewPane.addEventListener("click", (e) => {
      const target = e.target as Element;
      // Typst compiler often outputs 'data-source' or 'data-typst-source' containing line mapping
      const srcElement = target.closest("[data-source], [data-typst-source]");
      if (srcElement) {
        const source = srcElement.getAttribute("data-source") || srcElement.getAttribute("data-typst-source");
        if (source) {
          const parts = source.split(":");
          if (parts.length >= 3) {
            try {
              const line = parseInt(parts[parts.length - 2], 10);
              const column = parseInt(parts[parts.length - 1], 10);
              const cursor = this.editorPositionFromSourceLocation(line, column);
              if (this.activeMode === "WYSIWYM") {
                this.switchViewLayoutMode(); // auto switch to code mode to show the line
              }
              this.suppressForwardSyncOnce();
              this.editorInstance.dispatch({
                selection: { anchor: cursor },
                scrollIntoView: true
              });
              this.editorInstance.focus();
              void this.renderHighlightedPreviewAtCursor(cursor);
            } catch (err) { console.warn("Failed to inverse sync:", err); }
          }
        }
      }
    });
  }

  private mapMarkupToWysiwym(markup: string) {
    this.wysiwymContainer.innerHTML = "";
    markup.split("\n").forEach(line => {
      const trimmed = line.trim();
      if (!trimmed) return;
      const block = document.createElement("div");
      block.className = "wysiwym-block " + (trimmed.startsWith("=") ? "heading" : "body");
      block.contentEditable = "true";
      block.textContent = trimmed.startsWith("=") ? trimmed.replace(/^=\s*/, "") : trimmed;
      this.wysiwymContainer.appendChild(block);
    });
  }

  private editorPositionFromSourceLocation(lineNumber: number, columnNumber: number): number {
    const doc = this.editorInstance.state.doc;
    const line = doc.line(Math.max(1, Math.min(lineNumber, doc.lines)));
    const character = this.utf8ByteOffsetToStringOffset(line.text, Math.max(0, columnNumber - 1));
    return line.from + character;
  }

  private utf8ByteOffsetToStringOffset(text: string, byteOffset: number): number {
    const target = Math.max(0, byteOffset);
    let bytes = 0;
    let offset = 0;

    for (const char of text) {
      const size = this.utf8ByteLength(char);
      if (bytes + size > target) break;
      bytes += size;
      offset += char.length;
    }

    return offset;
  }

  private mapWysiwymToMarkup(): string {
    return Array.from(this.wysiwymContainer.querySelectorAll(".wysiwym-block"))
      .map(b => b.classList.contains("heading") ? `= ${b.textContent?.trim()}` : b.textContent?.trim())
      .join("\n");
  }
}

document.addEventListener("DOMContentLoaded", () => { new TypstryWorkspaceController().bootstrap(); });
