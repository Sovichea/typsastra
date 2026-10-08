import type { LspDiagnostic } from "../compiler/lsp";
import type { PreviewFrame } from "../preview/previewFrame";
import { activeFileCanRenderPreview } from "../preview/previewPolicy";
import type { PreviewRenderMode } from "../settings";
import { fileNameFromPath } from "../platform/paths";

export interface PreviewDiagnosticsRecoveryDependencies {
  activeFilePath(): string | null;
  pinnedMainFilePath(): string | null;
  previewImported(): boolean;
  previewDisabled(): boolean;
  renderMode(): PreviewRenderMode;
  editorText(): string;
  previewFrame(): PreviewFrame;
  previewRenderPending(): boolean;
  previewRenderQueued(): boolean;
  navigateToCompilerLocation(filePath: string, line: number, column: number): void;
  renderPdfPreview(contents: string): void;
  log(message: string): void;
}

/** Owns preview failure bookkeeping and recovery after accepted LSP diagnostics. */
export class PreviewDiagnosticsRecoveryController {
  private failedContents: string | null = null;
  private lastRequestedContents: string | null = null;
  private acceptedErrorRecoveryPending = false;
  private acceptedErrorFilePath: string | null = null;
  private acceptedErrors: readonly LspDiagnostic[] = [];

  constructor(private readonly deps: PreviewDiagnosticsRecoveryDependencies) {}

  onRenderSucceeded(): void {
    this.failedContents = null;
    this.lastRequestedContents = null;
    // Installing a freshly presented PDF clears PreviewFrame's overlay. The
    // PDF can still be the last successful revision while the active editor
    // revision has accepted LSP errors, so restore that diagnostic until the
    // language server explicitly accepts an error-free revision.
    if (!this.deps.previewRenderQueued()) {
      if (this.acceptedErrors.length === 0) this.acceptedErrorRecoveryPending = false;
      this.showAcceptedErrors();
    }
  }

  onRenderFailed(contents: string): void {
    this.failedContents = contents;
    this.lastRequestedContents = null;
  }

  needsExternalPreviewRecovery(): boolean {
    return this.acceptedErrorRecoveryPending || this.failedContents !== null;
  }

  recoverAfterAcceptedDiagnostics(diagnostics: readonly LspDiagnostic[]): void {
    const errors = diagnostics.filter(diagnostic => diagnostic.severity === 1);
    this.acceptedErrorFilePath = this.deps.activeFilePath();
    this.acceptedErrors = errors;
    const canRenderActiveFile = this.canRenderActiveFile();
    if (errors.length > 0) {
      this.acceptedErrorRecoveryPending = true;
      if (
        canRenderActiveFile
        && this.failedContents === null
        && !this.deps.previewRenderPending()
      ) {
        this.showAcceptedErrors();
      }
      return;
    }

    // Diagnostic overlays are provisional and may be removed as soon as the
    // active revision is valid. Compiler failures are owned by the render
    // pipeline and must remain visible until a later PDF presents successfully.
    if (canRenderActiveFile && this.failedContents === null) {
      this.deps.previewFrame().clearErrorOverlay();
    }

    if (this.deps.renderMode() !== "on-type" || this.failedContents === null) return;

    const latestContents = this.deps.editorText();
    if (
      latestContents === this.failedContents
      || latestContents === this.lastRequestedContents
      || !this.canRenderActiveFile()
    ) return;

    this.lastRequestedContents = latestContents;
    this.deps.log(
      `LSP accepted a corrected revision after preview failure; requeueing ${latestContents.length} UTF-16 code unit(s).`,
    );
    this.deps.renderPdfPreview(latestContents);
  }

  private canRenderActiveFile(): boolean {
    return activeFileCanRenderPreview(
      this.deps.activeFilePath(),
      this.deps.pinnedMainFilePath(),
      this.deps.previewImported(),
      this.deps.previewDisabled(),
    );
  }

  private showAcceptedErrors(): void {
    if (
      this.acceptedErrors.length === 0
      || this.acceptedErrorFilePath === null
      || this.acceptedErrorFilePath !== this.deps.activeFilePath()
      || this.failedContents !== null
      || !this.canRenderActiveFile()
    ) return;

    this.deps.previewFrame().setCompilerError(
      "Preview Render Failed",
      this.failureMessage(this.acceptedErrors),
      {
        displayPath: fileNameFromPath,
        navigate: location => this.deps.navigateToCompilerLocation(
          location.filePath,
          location.line,
          location.column,
        ),
      },
    );
  }

  private failureMessage(diagnostics: readonly LspDiagnostic[]): string {
    // Preserve the absolute source path in the payload so PreviewFrame keeps
    // a navigable location. The display callback shortens it in the UI.
    const activeFilePath = this.deps.activeFilePath() ?? "document";
    const visible = diagnostics.slice(0, 8).map(diagnostic => {
      const line = diagnostic.range.start.line + 1;
      const column = (diagnostic.range.start.character ?? 0) + 1;
      const [summary, ...details] = diagnostic.message.split(/\r?\n/);
      return [
        `error: ${summary || "Compilation failed"}`,
        `  └─ ${activeFilePath}:${line}:${column}`,
        ...details,
      ].join("\n");
    });
    if (diagnostics.length > visible.length) {
      visible.push(`…and ${diagnostics.length - visible.length} more error(s).`);
    }
    return visible.join("\n\n");
  }
}
