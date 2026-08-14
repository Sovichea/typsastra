import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { invoke } from "@tauri-apps/api/core";
import type { LspInverseSyncResult, LspSourcePosition } from "../compiler/lsp";
import type { LogConsoleEntryInput } from "../diagnostics/logConsoleController";
import type { EditorTab, PreviewSessionState } from "../editor/editorTab";
import { isTypstDocumentPath } from "../platform/fileTypes";
import { fileNameFromPath, filePathFromUri, filePathKey } from "../platform/paths";
import {
  TYPSASTRA_GREEN,
  TYPSASTRA_GREEN_RIPPLE_FILL,
  TYPSASTRA_GREEN_RIPPLE_SHADOW,
} from "../ui/brandColors";
import type { DraftPreviewController } from "./draftPreviewController";
import type { PdfPreviewPreparationController } from "./pdfPreviewPreparationController";
import type { PreviewClickPoint } from "./previewFrame";
import {
  allowsStandalonePreview,
  tinymistPreviewPreferredSourceColumn,
  usesTemplateAwareStandaloneRoot,
} from "./previewPolicy";
import type { PreviewSyncController } from "./previewSyncController";

function ensureEditorCaretRippleStyle(): void {
  if (document.getElementById("typsastra-editor-caret-ripple-style")) return;
  const style = document.createElement("style");
  style.id = "typsastra-editor-caret-ripple-style";
  style.textContent = `
    @keyframes typsastra-editor-caret-ripple {
      0% { opacity: 0; transform: scale(.55); box-shadow: 0 0 0 0 rgba(61,180,137,.38); }
      12% { opacity: 1; }
      100% { opacity: 0; transform: scale(3.1); box-shadow: 0 0 0 14px rgba(61,180,137,0); }
    }
  `;
  document.head.appendChild(style);
}

function nextAnimationFrame(): Promise<void> {
  return new Promise(resolve => requestAnimationFrame(() => resolve()));
}

export interface PreviewSourceNavigationDependencies {
  previewSync: PreviewSyncController;
  draftPreview: DraftPreviewController;
  preparation: PdfPreviewPreparationController;
  getEditor(): EditorView;
  getActiveFilePath(): string | null;
  getOpenTabs(): readonly EditorTab[];
  getWorkspaceRootPath(): string | null;
  getPreviewRootPath(): string | null;
  isPreviewStandalone(): boolean;
  getSourceMapRootPath(): string | null;
  getActiveMode(): "CODE" | "WYSIWYM";
  switchViewLayoutMode(): void;
  loadFile(path: string, options: { preservePreviewSession?: PreviewSessionState }): Promise<void>;
  capturePreviewSession(): PreviewSessionState;
  getActiveTab(): EditorTab | null;
  mapToOriginalPath(path: string): string;
  isRenderCachePath(path: string): boolean;
  pdfGeneratedPreviewText(path: string): Promise<string>;
  mapCacheLspPositionToOriginalEditorOffset(
    relativePath: string,
    position: LspSourcePosition,
    cacheContent: string,
  ): Promise<number | null>;
  editorPositionFromLspPosition(position: LspSourcePosition): number | null;
  navigateToLogEntry(entry: LogConsoleEntryInput): Promise<void>;
  getCacheRootPath(): string | null;
  utf8ByteOffsetToStringOffset(text: string, byteOffset: number): number;
  isPreviewOnlyWindow(): boolean;
  isLowMemoryMode(): boolean;
  setPreviewReadyStatus(message: string): void;
  log(kind: "info" | "warning", source: string, message: string): void;
}

/** Owns source navigation between editor positions and the PDF preview. */
export class PreviewSourceNavigationController {
  public constructor(private readonly deps: PreviewSourceNavigationDependencies) {}

  public async handleInverseSync(
    uri: string | undefined,
    position: LspSourcePosition,
  ): Promise<LspInverseSyncResult> {
    this.deps.log(
      "info",
      "inverse sync",
      `Compiler source response: uri=${uri ?? "n/a"}, line=${position.line}, character=${position.character ?? 0}.`,
    );
    if (!this.deps.previewSync.hasRecentPreviewClick()) {
      this.deps.log(
        "warning",
        "inverse sync",
        "Ignored inverse sync because it did not originate from Typsastra's docked DOM-intercepted preview.",
      );
      return { handled: true };
    }

    const rawTargetPath = uri ? filePathFromUri(uri) : null;
    const targetPath = rawTargetPath ? this.deps.mapToOriginalPath(rawTargetPath) : null;
    const existingTargetTab = targetPath
      ? this.deps.getOpenTabs().find(tab => filePathKey(tab.path) === filePathKey(targetPath))
      : null;
    const resolvedTargetPath = existingTargetTab?.path ?? targetPath;
    if (
      resolvedTargetPath
      && filePathKey(resolvedTargetPath) !== filePathKey(this.deps.getActiveFilePath() ?? "")
    ) {
      let isStandalone = false;
      if (existingTargetTab) {
        isStandalone = allowsStandalonePreview(existingTargetTab.content);
      } else {
        try {
          const contents = await invoke<string>("read_workspace_file", { path: resolvedTargetPath });
          isStandalone = allowsStandalonePreview(contents);
        } catch {
          // Preserve the previous best-effort behavior when the target cannot be read.
        }
      }
      await this.deps.loadFile(resolvedTargetPath, {
        preservePreviewSession: isStandalone ? undefined : this.deps.capturePreviewSession(),
      });
      if (!this.deps.getActiveTab()?.contentLoaded) return { handled: true };
    }

    if (this.deps.getActiveMode() === "WYSIWYM") this.deps.switchViewLayoutMode();
    this.deps.previewSync.clearForward();

    let cursor = 0;
    if (rawTargetPath && targetPath && this.deps.isRenderCachePath(rawTargetPath)) {
      const workspaceRootPath = this.deps.getWorkspaceRootPath();
      if (!workspaceRootPath) return { handled: true };
      const relativePath = targetPath.startsWith(workspaceRootPath)
        ? targetPath.substring(workspaceRootPath.length).replace(/^[/\\]+/, "")
        : targetPath;
      const cacheContent = await this.deps.pdfGeneratedPreviewText(targetPath);
      cursor = await this.deps.mapCacheLspPositionToOriginalEditorOffset(
        relativePath,
        position,
        cacheContent,
      ) ?? 0;
    } else {
      cursor = this.deps.editorPositionFromLspPosition(position) ?? 0;
      this.deps.log(
        "info",
        "inverse sync",
        `Compiler inverse position mapped directly: line=${position.line + 1}, character=${position.character ?? 0}, offset=${cursor}.`,
      );
    }

    await this.applyInverseSyncSelection(cursor);
    return { handled: true };
  }

  public revealCursorInPreviewManually(): void {
    const path = this.deps.getActiveFilePath();
    if (!path?.toLowerCase().endsWith(".typ")) {
      this.deps.setPreviewReadyStatus("Open a Typst file to reveal it in preview");
      return;
    }
    this.deps.previewSync.requestManual(path, this.deps.getEditor().state.selection.main.head);
  }

  public cancelManualForwardSync(): void {
    this.deps.previewSync.cancelManual();
  }

  public updateManualForwardSyncAction(): void {
    this.deps.previewSync.refreshManualAction();
  }

  public renderManualForwardSyncAction(busy: boolean, available: boolean): void {
    const button = document.getElementById("preview-forward-sync-btn") as HTMLButtonElement | null;
    if (!button) return;
    const shortcut = navigator.userAgent.toLowerCase().includes("mac") ? "Option+Enter" : "Alt+Enter";
    button.disabled = busy || !available;
    button.setAttribute("aria-busy", String(busy));
    button.title = busy
      ? "Locating cursor in preview..."
      : available
        ? `Reveal Cursor in Preview (${shortcut})`
        : "Reveal cursor is available when a compiled preview is ready";
  }

  public async forwardSyncTarget(
    path: string,
    cursor: number,
  ): Promise<{ filepath: string; line: number; character: number } | null> {
    const editor = this.deps.getEditor();
    const position = Math.max(0, Math.min(cursor, editor.state.doc.length));
    const keepsOriginalSourceIdentity = usesTemplateAwareStandaloneRoot(
      path,
      this.deps.getPreviewRootPath(),
      this.deps.isPreviewStandalone(),
    );
    let generated = keepsOriginalSourceIdentity
      ? undefined
      : this.deps.preparation.generatedFile(path);
    if (
      !keepsOriginalSourceIdentity
      && !generated
      && this.deps.isRenderCachePath(this.deps.getSourceMapRootPath() ?? "")
    ) {
      await this.deps.pdfGeneratedPreviewText(this.deps.mapToOriginalPath(path));
      generated = this.deps.preparation.generatedFile(path);
      this.deps.log(
        generated ? "info" : "warning",
        "forward sync",
        generated
          ? `Loaded prepared source identity before forward sync: original=${path}, generated=${generated.generatedPath}.`
          : `Could not load prepared source identity before forward sync: ${path}.`,
      );
    }
    if (!generated) {
      const line = editor.state.doc.lineAt(position);
      return {
        filepath: path,
        line: line.number - 1,
        character: tinymistPreviewPreferredSourceColumn(line.text, position - line.from),
      };
    }

    const cacheRoot = this.deps.getCacheRootPath();
    const workspaceRootPath = this.deps.getWorkspaceRootPath();
    if (!cacheRoot || !workspaceRootPath) return null;

    const originalContent = editor.state.doc.toString();
    const sourceByteOffset = new TextEncoder().encode(originalContent.slice(0, position)).length;
    const relativePath = path.startsWith(workspaceRootPath)
      ? path.substring(workspaceRootPath.length).replace(/^[/\\]+/, "")
      : path;
    const generatedByteOffset = await invoke<number | null>("map_source_to_generated", {
      cacheRoot,
      relativePath,
      sourceOffset: sourceByteOffset,
    }).catch(() => null);
    if (generatedByteOffset === null || generatedByteOffset === undefined) return null;

    const generatedOffset = this.deps.utf8ByteOffsetToStringOffset(
      generated.preparedText,
      generatedByteOffset,
    );
    const generatedDoc = EditorState.create({ doc: generated.preparedText }).doc;
    const line = generatedDoc.lineAt(Math.max(0, Math.min(generatedOffset, generatedDoc.length)));
    return {
      filepath: generated.generatedPath,
      line: line.number - 1,
      character: tinymistPreviewPreferredSourceColumn(line.text, generatedOffset - line.from),
    };
  }

  public async handlePdfPreviewClick(point: PreviewClickPoint): Promise<void> {
    if (this.deps.isPreviewOnlyWindow()) {
      import("@tauri-apps/api/event").then(({ emit }) => {
        emit("pdf-click", point);
      }).catch(err => console.error("Error emitting pdf-click", err));
      return;
    }
    if (point.draftImageId) {
      await this.navigateToDraftPreviewImage(point.draftImageId);
      return;
    }
    const activeFilePath = this.deps.getActiveFilePath();
    if (!activeFilePath || !isTypstDocumentPath(activeFilePath)) {
      this.deps.log(
        "info",
        "preview iframe",
        "Ignored source-sync click because the active preview is a direct PDF document.",
      );
      return;
    }
    if (this.deps.isLowMemoryMode()) {
      this.deps.setPreviewReadyStatus("Low memory mode: use the document outline for preview navigation");
      this.deps.log(
        "info",
        "inverse sync",
        "Ignored preview click because low memory mode keeps Tinymist stopped.",
      );
      return;
    }
    await this.deps.previewSync.sendInverse(point);
  }

  private async applyInverseSyncSelection(cursor: number): Promise<void> {
    const editor = this.deps.getEditor();
    const target = Math.max(0, Math.min(cursor, editor.state.doc.length));
    await nextAnimationFrame();
    editor.dispatch({
      selection: { anchor: target },
      effects: EditorView.scrollIntoView(target, { y: "center" }),
    });
    editor.focus();
    window.setTimeout(() => {
      if (this.deps.getEditor() !== editor) return;
      if (editor.state.selection.main.head !== target) return;
      editor.dispatch({
        effects: EditorView.scrollIntoView(target, { y: "center" }),
      });
    }, 60);
    this.scheduleEditorCaretRipple(editor, target);
    this.deps.log("info", "inverse sync", `Editor inverse position applied: offset=${target}.`);
  }

  private scheduleEditorCaretRipple(editor: EditorView, cursor: number): void {
    let shown = false;
    const show = () => {
      if (shown) return;
      if (this.deps.getEditor() !== editor) return;
      if (editor.state.selection.main.head !== cursor) return;
      shown = this.showEditorCaretRipple(editor, cursor);
    };
    window.setTimeout(show, 90);
    window.setTimeout(show, 180);
  }

  private showEditorCaretRipple(editor: EditorView, cursor: number): boolean {
    const coords = editor.coordsAtPos(cursor);
    if (!coords) return false;
    document.querySelectorAll(".typsastra-editor-caret-ripple").forEach(element => element.remove());
    const ripple = document.createElement("div");
    ripple.className = "typsastra-editor-caret-ripple";
    Object.assign(ripple.style, {
      position: "fixed",
      left: `${coords.left}px`,
      top: `${(coords.top + coords.bottom) / 2}px`,
      width: "18px",
      height: "18px",
      margin: "-9px 0 0 -9px",
      border: `2px solid ${TYPSASTRA_GREEN}`,
      borderRadius: "999px",
      background: TYPSASTRA_GREEN_RIPPLE_FILL,
      boxShadow: `0 0 0 0 ${TYPSASTRA_GREEN_RIPPLE_SHADOW}`,
      pointerEvents: "none",
      zIndex: "2147483647",
      animation: "typsastra-editor-caret-ripple 900ms ease-out forwards",
    });
    ensureEditorCaretRippleStyle();
    document.body.appendChild(ripple);
    window.setTimeout(() => {
      if (ripple.isConnected) ripple.remove();
    }, 1000);
    return true;
  }

  private async navigateToDraftPreviewImage(id: string): Promise<void> {
    if (this.deps.draftPreview.presentedMode !== "draft" || !/^[a-f0-9]{24}$/.test(id)) return;
    const asset = this.deps.draftPreview.asset(id);
    if (!asset || asset.references.length === 0) return;
    const activePathKey = filePathKey(this.deps.getActiveFilePath() ?? "");
    const reference = asset.references.find(candidate =>
      filePathKey(candidate.sourcePath) === activePathKey
    ) ?? asset.references[0];
    this.deps.log(
      "info",
      "inverse sync",
      `Draft placeholder resolved directly to ${reference.sourcePath}:${reference.fromUtf16}.`,
    );
    await this.deps.navigateToLogEntry({
      kind: "info",
      source: "inverse sync",
      message: "Draft Preview image",
      filePath: reference.sourcePath,
      fileName: fileNameFromPath(reference.sourcePath),
      offset: reference.fromUtf16,
      toOffset: reference.toUtf16,
    });
  }
}
