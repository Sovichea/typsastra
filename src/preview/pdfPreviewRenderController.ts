import { invoke } from "@tauri-apps/api/core";
import type { TinymistLspClient, LspStatus } from "../compiler/lsp";
import { isTinymistStoppedRequestError } from "../compiler/lsp";
import {
  parsePreviewCompilerFailure,
  relocatePreviewCompilerFailurePaths,
} from "../compiler/previewError";
import type { LogConsoleController } from "../diagnostics/logConsoleController";
import type { PreviewFailureController } from "../diagnostics/previewFailureController";
import type { PerformanceController } from "../performance/performanceController";
import { isTypstDocumentPath } from "../platform/fileTypes";
import {
  fileNameFromPath,
  filePathKey,
  filePathToUri,
  nativeFilePath,
  relativeFilePath,
} from "../platform/paths";
import type { PreviewRenderMode } from "../settings";
import type { TypographyController } from "../typography/typographyController";
import type { WorkspaceResumeController } from "../platform/workspaceResumeController";
import type { DraftImageAsset, DraftPreviewController, PreviewContentMode } from "./draftPreviewController";
import type { PreviewFrame, PreviewSurface } from "./previewFrame";
import {
  PdfPreviewPreparationController,
  PreviewPreparationInterrupted,
  type PreparedPdfPreview,
} from "./pdfPreviewPreparationController";
import { RenderCacheCopyCancelled } from "./renderCacheCopyGuard";
import {
  activeFileCanRenderPreview,
  previewRefreshStyle,
  previewSessionIdentity,
} from "./previewPolicy";

const PDF_TRANSPORT_MODE = (
  import.meta as ImportMeta & { env?: Record<string, string | boolean | undefined> }
).env?.VITE_PDF_TRANSPORT === "full"
  ? "full-buffer"
  : "range";

export type PdfUpdatePayload = {
  path: string;
  identity: string;
  sessionKey: string;
  surface: PreviewSurface;
  contentMode?: PreviewContentMode;
  draftAssets?: DraftImageAsset[];
  draftAssetRootPath?: string;
  draftThumbnailGeneration?: number;
};

type OneShotCompileResult = {
  pdfPath: string;
  diagnostics: string;
};

export interface PdfPreviewRenderDependencies {
  previewFrame: PreviewFrame;
  preparation: PdfPreviewPreparationController;
  draftPreview: DraftPreviewController;
  typography: TypographyController;
  performance: PerformanceController;
  workspaceResume: WorkspaceResumeController;
  previewFailure: PreviewFailureController;
  logConsole: LogConsoleController;
  getLspClient(): TinymistLspClient | null;
  isLspReady(): boolean;
  getActiveFilePath(): string | null;
  getPinnedMainFilePath(): string | null;
  isPreviewImported(): boolean;
  isPreviewDisabled(): boolean;
  getPreviewRootPath(): string | null;
  getPreviewSessionKey(): string | null;
  getWorkspaceRootPath(): string | null;
  getPreviewRenderMode(): PreviewRenderMode;
  isLowMemoryMode(): boolean;
  canRestoreLowMemoryPreviewCache(): boolean;
  restoreLowMemoryPreviewCache(): Promise<{ pdfPath: string; indexJson: string } | null>;
  captureLowMemoryPreviewSignature(): Promise<string | null>;
  buildLowMemorySyncIndex(
    preparedRootPath: string,
    generation: number,
    pdfPath: string,
    sourceSignature: string | null,
  ): Promise<void>;
  ensureLargePreviewApproved(rootPath: string | null): Promise<boolean>;
  isPdfBlocked(path: string): boolean;
  getCacheRootPath(): string | null;
  getEditorText(): string;
  cancelManualForwardSync(): void;
  updateManualForwardSyncAction(): void;
  setLspStatus(status: LspStatus): void;
  scheduleSourceMapWarmup(generation: number): void;
  recoverTinymistPreviewAfterUnexpectedStop(contents: string, failedGeneration: number): Promise<boolean>;
  isRenderCachePath(path: string): boolean;
  mapToOriginalPath(path: string): string;
  navigateToCompilerLocation(filePath: string, line: number, column: number): void;
  log(kind: "info" | "warning" | "error", source: string, message: string): void;
  onRenderSucceeded(): void;
  onRenderFailed(contents: string): void;
}

/** Owns PDF preview render serialization, scheduling, transport, and generation state. */
export class PdfPreviewRenderController {
  private generationValue = 0;
  private loadRequestGeneration = 0;
  private scheduleGeneration = 0;
  private preparationRevisionValue = 0;
  private runningValue = false;
  private timer: number | null = null;
  private queuedContents: string | null = null;
  private queuedForced = false;
  private sourceMapRootPathValue: string | null = null;
  private sourceMapTaskIdValue: string | null = null;
  private lastPdfPathValue = "";
  private lastPdfIdentityValue = "";
  private lastPdfSessionKeyValue = "";
  private lastPdfSurfaceValue: PreviewSurface = "live";
  private previewFailureAt: number | null = null;
  private readonly managedPdfPathKeysValue = new Set<string>();

  public constructor(private readonly deps: PdfPreviewRenderDependencies) {}

  public get generation(): number { return this.generationValue; }
  public get preparationRevision(): number { return this.preparationRevisionValue; }
  public get running(): boolean { return this.runningValue; }
  public get queued(): boolean { return this.queuedContents !== null; }
  public get sourceMapRootPath(): string | null { return this.sourceMapRootPathValue; }
  public get sourceMapTaskId(): string | null { return this.sourceMapTaskIdValue; }
  public get lastPdfPath(): string { return this.lastPdfPathValue; }
  public get lastPdfIdentity(): string { return this.lastPdfIdentityValue; }
  public get lastPdfSessionKey(): string { return this.lastPdfSessionKeyValue; }
  public get lastPdfSurface(): PreviewSurface { return this.lastPdfSurfaceValue; }
  public get managedPdfPathKeys(): ReadonlySet<string> { return this.managedPdfPathKeysValue; }

  public cancelPendingPdfLoad(): void {
    this.loadRequestGeneration += 1;
  }

  public resetSourceMapIdentity(): void {
    this.sourceMapRootPathValue = null;
    this.sourceMapTaskIdValue = null;
  }

  public cancelOnTypeSchedule(): void {
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = null;
    this.queuedContents = null;
    this.queuedForced = false;
  }

  public invalidatePreparationScheduleOnly(): void {
    this.preparationRevisionValue += 1;
    this.scheduleGeneration += 1;
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = null;
  }

  public resetForMainFileChange(): void {
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = null;
    this.scheduleGeneration += 1;
    this.preparationRevisionValue += 1;
    this.generationValue += 1;
    this.queuedContents = null;
    this.queuedForced = false;
    void invoke("cancel_render_preparation").catch(() => {});
  }

  /**
   * Release every project-scoped preview identity before another workspace is
   * opened. Render state is owned here, so lifecycle code must reset it
   * through this boundary rather than assigning the controller's read-only
   * projections on the root application controller.
   */
  public resetForWorkspaceClose(): void {
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = null;
    this.scheduleGeneration += 1;
    this.preparationRevisionValue += 1;
    this.generationValue += 1;
    this.loadRequestGeneration += 1;
    this.queuedContents = null;
    this.queuedForced = false;
    this.runningValue = false;
    this.sourceMapRootPathValue = null;
    this.sourceMapTaskIdValue = null;
    this.lastPdfPathValue = "";
    this.lastPdfIdentityValue = "";
    this.lastPdfSessionKeyValue = "";
    this.lastPdfSurfaceValue = "live";
    this.previewFailureAt = null;
    this.managedPdfPathKeysValue.clear();
    void invoke("cancel_render_preparation").catch(() => {});
  }

  public noteContentMutation(canRenderPreview: boolean): number {
    if (canRenderPreview) {
      this.preparationRevisionValue += 1;
      if (this.deps.getPreviewRenderMode() === "on-type") {
        void invoke("cancel_render_preparation").catch(() => {});
      }
    }
    return this.preparationRevisionValue;
  }

  public queueRecovery(contents: string): void {
    this.queuedContents ??= contents;
    this.queuedForced = true;
  }

  public invalidate(reason: string): void {
    this.preparationRevisionValue += 1;
    this.scheduleGeneration += 1;
    this.generationValue += 1;
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = null;
    this.queuedContents = null;
    this.queuedForced = false;
    void invoke("cancel_render_preparation").catch(() => {});
    this.deps.log("info", "preview scheduler", `Preview work invalidated: ${reason}.`);
  }

  public async render(contents: string, force = false): Promise<void> {
    this.deps.log(
      "info",
      "preview scheduler",
      `Render requested: force=${force}; lowMemory=${this.deps.isLowMemoryMode()}; active=${this.deps.getActiveFilePath() ?? "none"}; pinned=${this.deps.getPinnedMainFilePath() ?? "none"}; root=${this.deps.getPreviewRootPath() ?? "none"}; session=${this.deps.getPreviewSessionKey() ?? "none"}; imported=${this.deps.isPreviewImported()}; disabled=${this.deps.isPreviewDisabled()}; sourceUtf16=${contents.length}.`,
    );
    if (this.deps.isPreviewDisabled()) {
      this.deps.log("info", "preview scheduler", "Render skipped: preview is disabled.");
      return;
    }
    if (!activeFileCanRenderPreview(
      this.deps.getActiveFilePath(),
      this.deps.getPinnedMainFilePath(),
      this.deps.isPreviewImported(),
      this.deps.isPreviewDisabled(),
    )) {
      this.deps.log(
        "info",
        "preview scheduler",
        `Render skipped: ${this.deps.getActiveFilePath() ?? "no active file"} does not participate in the configured main preview.`,
      );
      return;
    }
    if (!await this.deps.ensureLargePreviewApproved(this.deps.getPreviewRootPath())) {
      this.deps.log(
        "info",
        "preview scheduler",
        `Render deferred until the large preview is approved: ${this.deps.getPreviewRootPath() ?? "unknown root"}.`,
      );
      return;
    }
    const imageProfile = await this.deps.draftPreview.inspectImageProfile(this.deps.getPreviewRootPath());
    this.deps.draftPreview.updateImageHeavyWarning(imageProfile);
    if (this.deps.typography.fontUpdateInProgress) {
      this.deps.typography.deferPreview(contents);
      this.deps.log(
        "info",
        "preview scheduler",
        `Render deferred while typography fonts are updating: sourceUtf16=${contents.length}; forced=${force}.`,
      );
      return;
    }
    const lowMemoryMode = this.deps.isLowMemoryMode();
    if (!this.deps.getActiveFilePath() || (!lowMemoryMode && (!this.deps.isLspReady() || !this.deps.getLspClient()))) {
      this.deps.log(
        "info",
        "preview scheduler",
        `Render skipped: active=${this.deps.getActiveFilePath() ?? "none"}; lspReady=${this.deps.isLspReady()}; client=${!!this.deps.getLspClient()}.`,
      );
      return;
    }
    const reportRenderStatus = force || !this.deps.previewFrame.currentUrl;
    if (force) this.deps.previewFrame.setLoading("Recompiling live preview…");
    if (this.runningValue) {
      this.queuedContents = contents;
      this.queuedForced ||= force;
      this.deps.log(
        "info",
        "preview scheduler",
        `Render queued behind active generation ${this.generationValue}: sourceUtf16=${contents.length}; forced=${this.queuedForced}.`,
      );
      return;
    }

    this.deps.cancelManualForwardSync();
    this.runningValue = true;
    const compileStartedAt = performance.now();
    const generation = ++this.generationValue;
    const generationActivePath = this.deps.getActiveFilePath();
    const generationContentMode = this.deps.draftPreview.mode;
    const preparationRevision = this.preparationRevisionValue;
    let renderSucceeded = false;
    let preparedPreview: PreparedPdfPreview | null = null;

    try {
    // A low-memory preview is a durable snapshot of the complete workspace.
    // Reopen it before preparation/compilation when the active source is clean.
    // This keeps switching between the main and an included file, and reopening
    // an unchanged project, entirely Tinymist-free.
    if (
      lowMemoryMode
      && !force
      && generationContentMode === "normal"
      && this.deps.canRestoreLowMemoryPreviewCache()
    ) {
      try {
        const cached = await this.deps.restoreLowMemoryPreviewCache();
        if (cached && generation === this.generationValue) {
          this.lastPdfPathValue = cached.pdfPath;
          this.managedPdfPathKeysValue.add(filePathKey(cached.pdfPath));
          await this.loadPdfPath(
            cached.pdfPath,
            this.deps.getPreviewRootPath() ?? cached.pdfPath,
            this.deps.getPreviewSessionKey() ?? this.deps.getPreviewRootPath() ?? cached.pdfPath,
            "live",
            false,
          );
          this.deps.log("info", "preview scheduler", "Reused cached low-memory PDF and sync index for an unchanged workspace snapshot.");
          this.deps.setLspStatus({ kind: "preview-ready", message: "Preview ready · cached" });
          this.deps.onRenderSucceeded();
          renderSucceeded = true;
          return;
        }
      } catch (error) {
        this.deps.log("warning", "preview scheduler", `Unable to restore low-memory preview cache; compiling normally: ${String(error)}`);
      }
    }
    await this.deps.performance.logMemoryDiagnostics(`render ${generation}: before preparation`);
    this.deps.log(
      "info",
      "preview scheduler",
      `Render generation ${generation} started: refresh=${this.deps.getPreviewRenderMode()}; content=${generationContentMode}; active=${this.deps.getActiveFilePath()}; sourceUtf16=${contents.length}.`,
    );
    if (reportRenderStatus) this.deps.setLspStatus({ kind: "syncing", message: "Compiling preview" });
    if (!force && !this.deps.previewFrame.currentUrl) {
      this.deps.previewFrame.setLoading("Compiling live preview…");
    }

      const lowMemorySourceSignature = lowMemoryMode
        ? await this.deps.captureLowMemoryPreviewSignature().catch(() => null)
        : null;

      this.deps.preparation.ensureCurrent(preparationRevision);
      const draftPreparationStartedAt = performance.now();
      const useEditorOverlays = this.deps.getPreviewRenderMode() === "on-type" || force;
      preparedPreview = await this.deps.preparation.prepare(
        contents,
        preparationRevision,
        generationContentMode,
        useEditorOverlays,
      );
      if (!preparedPreview) throw new Error("No PDF preview root is available.");
      const previewPath = preparedPreview.path;
      this.deps.performance.record({
        name: "preview.draft-prepare",
        milliseconds: performance.now() - draftPreparationStartedAt,
        detail: {
          contentMode: generationContentMode,
          replacedAssets: preparedPreview.draftAssets.size,
          unresolvedCalls: preparedPreview.draftDiagnostics.length,
          projectManifestCacheHits: preparedPreview.draftProjectCacheHits,
          overlayManifestCacheHits: preparedPreview.draftOverlayCacheHits,
          overlayPreparations: preparedPreview.draftOverlayPreparations,
          projectMs: Math.round(preparedPreview.projectPreparationMs * 10) / 10,
          overlayMs: Math.round(preparedPreview.overlayPreparationMs * 10) / 10,
          backendSetupMs: Math.round(preparedPreview.backendTimings.setupMs * 10) / 10,
          backendCleanupMs: Math.round(preparedPreview.backendTimings.cleanupMs * 10) / 10,
          backendDiscoveryMs: Math.round(preparedPreview.backendTimings.discoveryMs * 10) / 10,
          backendTypMs: Math.round(preparedPreview.backendTimings.typProcessingMs * 10) / 10,
          backendAssetMs: Math.round(preparedPreview.backendTimings.assetSyncMs * 10) / 10,
          discoveredFiles: preparedPreview.backendTimings.discoveredFiles,
          typFiles: preparedPreview.backendTimings.typFiles,
          assetFiles: preparedPreview.backendTimings.assetFiles,
        },
      });
      this.deps.preparation.ensureCurrent(preparationRevision);
      this.deps.log("info", "preview scheduler", `Render generation ${generation}: preview root prepared at ${previewPath}.`);
      const preparedPaths = [...new Set([
        previewPath,
        ...preparedPreview.changedPaths,
        ...[...this.deps.preparation.generatedFiles.values()].map(file => file.generatedPath),
      ].map(nativeFilePath))];
      if (!lowMemoryMode && preparedPaths.length > 0) {
        const closedPreparedDocuments = await this.deps.preparation.closePreparedDocuments();
        this.deps.preparation.ensureCurrent(preparationRevision);
        await this.deps.getLspClient()!.notifyWorkspaceFilesChanged(
          preparedPaths.map(path => ({ uri: filePathToUri(path), type: 2 as const })),
        );
        this.deps.preparation.ensureCurrent(preparationRevision);
        this.deps.log(
          "info",
          "preview scheduler",
          `Render generation ${generation}: invalidated ${preparedPaths.length} disk-backed mirror file(s) and closed ${closedPreparedDocuments} legacy mirror document(s) before export.`,
        );
      }
      const synchronizedPreparedDocuments = lowMemoryMode
        ? 0
        : await this.deps.preparation.openPreparedDocumentsForExport(preparedPaths);
      const cacheRoot = this.deps.getCacheRootPath();
      if (!cacheRoot) throw new Error("No PDF preview cache is available.");
      const previewPdfName = fileNameFromPath(previewPath).replace(/\.typ$/i, ".pdf");
      const anticipatedPdfPath = `${cacheRoot}/preview/${previewPdfName}`;
      const anticipatedPdfPathKey = filePathKey(anticipatedPdfPath);
      this.managedPdfPathKeysValue.add(anticipatedPdfPathKey);
      let pdfPath: string;
      let oneShotDiagnostics = "";
      try {
        this.deps.preparation.ensureCurrent(preparationRevision);
        if (lowMemoryMode) {
          const workspaceRootPath = this.deps.getWorkspaceRootPath();
          if (!workspaceRootPath) throw new Error("No workspace is available for low-memory compilation.");
          const result = await invoke<OneShotCompileResult>("compile_tinymist_pdf_once", {
            workspaceRootPath,
            inputPath: previewPath,
            outputPath: anticipatedPdfPath,
          });
          pdfPath = result.pdfPath;
          oneShotDiagnostics = relocatePreviewCompilerFailurePaths(
            result.diagnostics,
            path => this.deps.isRenderCachePath(path) ? this.deps.mapToOriginalPath(path) : path,
          );
        } else {
          // Tinymist's watched-file invalidation can complete after its
          // notification handler returns. Keep the exact prepared revision open
          // only for this RPC so export cannot observe the previous disk cache.
          pdfPath = await this.deps.getLspClient()!.exportPdfToFile(previewPath);
        }
      } finally {
        const closedPreparedDocuments = await this.deps.preparation.closePreparedDocuments();
        this.deps.log(
          "info",
          "preview scheduler",
          `Render generation ${generation}: released ${closedPreparedDocuments}/${synchronizedPreparedDocuments} transient mirror document(s) after export.`,
        );
      }
      const actualPdfPathKey = filePathKey(pdfPath);
      this.managedPdfPathKeysValue.add(actualPdfPathKey);
      if (actualPdfPathKey !== anticipatedPdfPathKey) {
        window.setTimeout(() => {
          if (filePathKey(this.lastPdfPathValue) !== anticipatedPdfPathKey) {
            this.managedPdfPathKeysValue.delete(anticipatedPdfPathKey);
          }
        }, 60_000);
      }
      this.deps.preparation.ensureCurrent(preparationRevision);
      this.deps.log("info", "preview scheduler", lowMemoryMode
        ? `Render generation ${generation}: one-shot Tinymist compilation complete and compiler memory released.`
        : `Render generation ${generation}: Tinymist PDF export complete.`);
      await this.deps.workspaceResume.waitForHorizontalResizeEnd();
      this.deps.preparation.ensureCurrent(preparationRevision);
      await this.deps.performance.logMemoryDiagnostics(
        `render ${generation}: after Tinymist export`,
        { transport: "binary-file" },
      );
      this.deps.performance.record({
        name: "preview.compile",
        milliseconds: performance.now() - compileStartedAt,
        detail: { sourceUtf16: contents.length },
      });
      if (
        this.queuedContents !== null
        && (this.queuedForced || this.queuedContents !== contents)
      ) {
        this.deps.log(
          "info",
          "preview scheduler",
          `Render generation ${generation} discarded: a newer queued request exists (queuedUtf16=${this.queuedContents.length}; forced=${this.queuedForced}).`,
        );
        return;
      }
      if (generation !== this.generationValue) {
        this.deps.log(
          "info",
          "preview scheduler",
          `Render generation ${generation} discarded: current generation is ${this.generationValue}.`,
        );
        return;
      }
      const sourceMapTaskId = previewSessionIdentity(
        previewPath,
        previewRefreshStyle(this.deps.getPreviewRenderMode()),
      ).taskId;
      this.sourceMapRootPathValue = previewPath;
      this.sourceMapTaskIdValue = sourceMapTaskId;
      const stagedPdfPath = await invoke<string>("stage_pdf_preview_generation", {
        path: pdfPath,
        generation,
      });
      this.managedPdfPathKeysValue.add(filePathKey(stagedPdfPath));
      this.lastPdfPathValue = stagedPdfPath;
      await this.loadPdfPath(
        stagedPdfPath,
        previewPath,
        this.deps.getPreviewSessionKey() ?? previewPath,
        "live",
        true,
      );
      if (lowMemoryMode) {
        void this.deps.buildLowMemorySyncIndex(
          previewPath,
          generation,
          stagedPdfPath,
          lowMemorySourceSignature,
        );
      }
      await this.deps.draftPreview.presentGeneration({
        generation,
        mode: generationContentMode,
        assets: preparedPreview.draftAssets,
        diagnostics: preparedPreview.draftDiagnostics,
        assetRootPath: this.deps.getWorkspaceRootPath(),
        documentRootPath: preparedPreview.documentRootPath,
      });
      this.deps.logConsole.clearLogsBySource(["compiler", "package compatibility"]);
      this.deps.previewFailure.clear();
      if (lowMemoryMode && oneShotDiagnostics.trim()) {
        this.deps.previewFailure.publishSuccessfulDiagnostics(oneShotDiagnostics);
      }
      this.deps.setLspStatus({ kind: "preview-ready", message: "Preview ready" });
      this.deps.log("info", "preview scheduler", `Render generation ${generation}: PDF presentation complete.`);
      renderSucceeded = true;
      this.deps.onRenderSucceeded();
      this.deps.scheduleSourceMapWarmup(generation);
      await this.deps.performance.logMemoryDiagnostics(`render ${generation}: after PDF presentation`);
      window.setTimeout(() => {
        void this.deps.performance.logMemoryDiagnostics(`render ${generation}: settled after page rendering`);
      }, 1000);
      if (this.previewFailureAt !== null) {
        this.deps.performance.record({
          name: "preview.recovery",
          milliseconds: performance.now() - this.previewFailureAt,
        });
        this.previewFailureAt = null;
      }
      const memory = (performance as Performance & { memory?: { usedJSHeapSize?: number } }).memory;
      if (typeof memory?.usedJSHeapSize === "number") {
        this.deps.performance.record({ name: "memory.heap", bytes: memory.usedJSHeapSize });
      }
      import("@tauri-apps/api/event").then(({ emit }) => {
        emit("pdf-update", {
          path: stagedPdfPath,
          identity: previewPath,
          sessionKey: this.deps.getPreviewSessionKey() ?? previewPath,
          surface: "live",
          contentMode: generationContentMode,
          draftAssets: generationContentMode === "draft"
            ? [...this.deps.draftPreview.assets.values()]
            : [],
          draftAssetRootPath: generationContentMode === "draft"
            ? this.deps.draftPreview.assetRootPath ?? undefined
            : undefined,
          draftThumbnailGeneration: generationContentMode === "draft"
            ? this.deps.draftPreview.thumbnailGeneration
            : undefined,
        } satisfies PdfUpdatePayload);
      }).catch(err => console.error("Error emitting pdf-update", err));
    } catch (error) {
      if (this.deps.typography.fontUpdateInProgress) {
        this.deps.log(
          "info",
          "preview scheduler",
          `Render generation ${generation} interrupted for typography font replacement.`,
        );
        return;
      }
      if (
        error instanceof PreviewPreparationInterrupted
        || error instanceof RenderCacheCopyCancelled
        || (
          this.deps.getPreviewRenderMode() === "on-type"
          && preparationRevision !== this.preparationRevisionValue
        )
      ) {
        this.deps.log("info", "preview scheduler", error instanceof RenderCacheCopyCancelled
          ? `Render generation ${generation} cancelled because preview-cache copies were not approved.`
          : `Render generation ${generation} interrupted by editor input; waiting for the next debounce.`);
        return;
      }
      if (generation !== this.generationValue) {
        this.deps.log(
          "warning",
          "preview scheduler",
          `Render generation ${generation} failed after becoming stale: ${String(error)}`,
        );
        return;
      }
      if (
        isTinymistStoppedRequestError(error)
        && await this.deps.recoverTinymistPreviewAfterUnexpectedStop(contents, generation)
      ) {
        return;
      }
      console.error("PDF Preview compilation failed:", JSON.stringify(error, null, 2));
      const failure = parsePreviewCompilerFailure(error);
      const packageHint = await this.deps.previewFailure.packageFailureHint(
        failure,
        preparedPreview?.reachableSourcePaths ?? [],
      );
      const displayedFailureMessage = relocatePreviewCompilerFailurePaths(
        failure.message,
        path => this.deps.isRenderCachePath(path) ? this.deps.mapToOriginalPath(path) : path,
      );
      const failureMessage = packageHint
        ? `${displayedFailureMessage}\n\nPackage compatibility hint\n${packageHint.message}`
        : displayedFailureMessage;
      this.deps.onRenderFailed(contents);
      const workspaceRootPath = this.deps.getWorkspaceRootPath();
      this.deps.previewFrame.setCompilerError("Preview Render Failed", failureMessage, {
        displayPath: path => {
          const relative = workspaceRootPath ? relativeFilePath(workspaceRootPath, path) : null;
          return (relative ?? path).replace(/\\/g, "/");
        },
        navigate: location => this.deps.navigateToCompilerLocation(
          location.filePath,
          location.line,
          location.column,
        ),
      });
      this.deps.previewFailure.publish(failure, packageHint, displayedFailureMessage);
      this.deps.draftPreview.updateControl(false);
      this.deps.setLspStatus({ kind: "preview-error", message: "PDF compile failed" });
      this.previewFailureAt ??= performance.now();
    } finally {
      this.runningValue = false;
      let queued = this.queuedContents;
      const queuedForced = this.queuedForced;
      this.queuedContents = null;
      this.queuedForced = false;
      if (
        this.deps.getPreviewRenderMode() === "on-type"
        && generationActivePath
        && filePathKey(this.deps.getActiveFilePath() ?? "") === filePathKey(generationActivePath)
        && activeFileCanRenderPreview(
          this.deps.getActiveFilePath(),
          this.deps.getPinnedMainFilePath(),
          this.deps.isPreviewImported(),
          this.deps.isPreviewDisabled(),
        )
      ) {
        const latestContents = this.deps.getEditorText();
        if (latestContents !== contents) queued = latestContents;
      }
      this.deps.log(
        "info",
        "preview scheduler",
        `Render generation ${generation} released: succeeded=${renderSucceeded}; queued=${queued !== null}; queuedChanged=${queued !== null && queued !== contents}; queuedForced=${queuedForced}.`,
      );
      if (queued !== null && (queuedForced || queued !== contents || !renderSucceeded)) {
        void this.render(queued, queuedForced);
      }
      this.deps.updateManualForwardSyncAction();
    }
  }

  public recompileManually(): void {
    const activeFilePath = this.deps.getActiveFilePath();
    if (!activeFilePath?.toLowerCase().endsWith(".typ")) return;
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
    const contents = this.deps.getEditorText();
    this.deps.log(
      "info",
      "preview scheduler",
      `Manual preview recompile requested: active=${activeFilePath}; sourceUtf16=${contents.length}.`,
    );
    void this.render(contents, true);
  }

  public schedule(contents: string, delayMs: number): void {
    if (this.deps.isPreviewDisabled()) {
      this.deps.log("info", "preview scheduler", "On-type schedule skipped: preview is disabled.");
      return;
    }
    if (!activeFileCanRenderPreview(
      this.deps.getActiveFilePath(),
      this.deps.getPinnedMainFilePath(),
      this.deps.isPreviewImported(),
      this.deps.isPreviewDisabled(),
    )) {
      this.deps.log(
        "info",
        "preview scheduler",
        `On-type schedule skipped: ${this.deps.getActiveFilePath() ?? "no active file"} does not participate in the configured main preview.`,
      );
      return;
    }
    if (this.deps.getPreviewRenderMode() !== "on-type") {
      this.deps.log(
        "info",
        "preview scheduler",
        `On-type schedule skipped: mode=${this.deps.getPreviewRenderMode()}.`,
      );
      return;
    }
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.deps.log(
        "info",
        "preview scheduler",
        `On-type timer ${this.scheduleGeneration} replaced by a newer edit.`,
      );
    }
    const scheduleGeneration = ++this.scheduleGeneration;
    const scheduledPath = this.deps.getActiveFilePath();
    this.deps.log(
      "info",
      "preview scheduler",
      `On-type timer ${scheduleGeneration} scheduled: active=${scheduledPath ?? "none"}; sourceUtf16=${contents.length}; delay=${delayMs}ms.`,
    );
    this.timer = window.setTimeout(() => {
      this.timer = null;
      const activeFilePath = this.deps.getActiveFilePath();
      if (
        activeFilePath
        && filePathKey(activeFilePath) === filePathKey(scheduledPath ?? "")
        && activeFileCanRenderPreview(
          activeFilePath,
          this.deps.getPinnedMainFilePath(),
          this.deps.isPreviewImported(),
          this.deps.isPreviewDisabled(),
        )
      ) {
        this.deps.log("info", "preview scheduler", `On-type timer ${scheduleGeneration} fired.`);
        void this.render(contents);
      } else {
        this.deps.log(
          "info",
          "preview scheduler",
          `On-type timer ${scheduleGeneration} discarded: active path changed from ${scheduledPath ?? "none"} to ${activeFilePath ?? "none"}.`,
        );
      }
    }, delayMs);
  }

  public async loadPdfPath(
    path: string,
    identity: string,
    sessionKey = identity,
    surface: PreviewSurface = isTypstDocumentPath(identity) ? "live" : "pdf",
    deleteOnClose = false,
  ): Promise<number> {
    if (this.deps.isPdfBlocked(path)) return 0;
    if (surface === "pdf") {
      this.deps.previewFrame.setLoading("Preparing PDF preview…", false);
    }
    const requestGeneration = ++this.loadRequestGeneration;
    if (PDF_TRANSPORT_MODE === "range") {
      const byteLength = await this.deps.previewFrame.loadPdfPath(
        path,
        identity,
        sessionKey,
        surface,
        deleteOnClose,
      );
      if (
        requestGeneration !== this.loadRequestGeneration
        || this.deps.isPdfBlocked(path)
      ) return 0;
      if (this.deps.previewFrame.currentUrl === identity) {
        this.lastPdfPathValue = path;
        this.lastPdfIdentityValue = identity;
        this.lastPdfSessionKeyValue = sessionKey;
        this.lastPdfSurfaceValue = surface;
      }
      return byteLength;
    }
    await this.deps.performance.logMemoryDiagnostics("PDF full-buffer before IPC read", {
      transport: PDF_TRANSPORT_MODE,
    });
    const response = await invoke<ArrayBuffer | Uint8Array | number[]>("read_binary_file", { path });
    await this.deps.performance.logMemoryDiagnostics("PDF full-buffer after IPC read", {
      transport: PDF_TRANSPORT_MODE,
    });
    if (
      requestGeneration !== this.loadRequestGeneration
      || this.deps.isPdfBlocked(path)
    ) return 0;
    const bytes = response instanceof Uint8Array
      ? response
      : response instanceof ArrayBuffer
        ? new Uint8Array(response)
        : new Uint8Array(response);
    const byteLength = bytes.byteLength;
    await this.deps.previewFrame.loadPdfBytes(bytes, identity, sessionKey, surface);
    if (deleteOnClose) {
      await invoke("remove_preview_generation_file", { path }).catch(() => {});
    }
    if (this.deps.previewFrame.currentUrl === identity) {
      this.lastPdfPathValue = path;
      this.lastPdfIdentityValue = identity;
      this.lastPdfSessionKeyValue = sessionKey;
      this.lastPdfSurfaceValue = surface;
    }
    return byteLength;
  }
}
