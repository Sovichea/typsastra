import { invoke } from "@tauri-apps/api/core";
import type { EditorView } from "@codemirror/view";
import { fileNameFromPath, filePathKey } from "../platform/paths";
import { isTypstDocumentPath } from "../platform/fileTypes";
import { formatFileSize } from "../workspace/largeFileOpening";
import type { PreviewRenderMode } from "../settings";
import type { PreviewFrame, PreviewPageStatus } from "./previewFrame";
import type { AppDialogController } from "../ui/appDialog";
import type { ImageOptimizationWarning } from "../editor/imageWarnings";
import type { LogConsoleEntryInput } from "../diagnostics/logConsoleController";

export type PreviewContentMode = "normal" | "draft";

export type PreviewImageReference = {
  sourcePath: string;
  fromUtf16: number;
  toUtf16: number;
  line: number;
  column: number;
};

export type PreviewImageAsset = {
  path: string;
  width: number;
  height: number;
  sourceBytes: number;
  estimatedDecodedBytes: number;
  format: string;
  modifiedMs: number;
  references: PreviewImageReference[];
};

export type PreviewImageProfile = {
  images: PreviewImageAsset[];
  uniqueImageCount: number;
  referenceCount: number;
  totalSourceBytes: number;
  estimatedTotalDecodedBytes: number;
};

export type DraftImageReference = {
  sourcePath: string;
  fromUtf16: number;
  toUtf16: number;
};

export type DraftImageAsset = {
  id: string;
  path: string;
  mimeType: string;
  width: number;
  height: number;
  sourceBytes: number;
  estimatedDecodedBytes: number;
  references: DraftImageReference[];
};

export type DraftImageDiagnostic = DraftImageReference & { reason: string };

type DraftThumbnailStatus = {
  status: "pending" | "generating" | "ready" | "failed";
  path?: string;
  mimeType?: string;
  sourceWidth: number;
  sourceHeight: number;
  sourceBytes: number;
  thumbnailWidth?: number;
  thumbnailHeight?: number;
  thumbnailBytes?: number;
  queueClass: string;
};

type DraftThumbnailQueueSummary = {
  generation: number;
  cacheHits: number;
  queued: number;
};

export type DraftThumbnailQueueMetric = {
  generation: number;
  status: "completed" | "cancelled" | "superseded";
  totalImages: number;
  cacheHits: number;
  generated: number;
  failed: number;
  skipped: number;
  outputBytes: number;
  decodeMs: number;
  resizeMs: number;
  encodeMs: number;
  totalMs: number;
};

export interface DraftPreviewControllerPort {
  activeFilePath(): string | null;
  workspaceRootPath(): string | null;
  editor(): EditorView | null;
  previewFrame(): PreviewFrame;
  previewPageStatus(): PreviewPageStatus;
  previewGeneration(): number;
  renderMode(): PreviewRenderMode;
  saveWorkspaceState(): Promise<void>;
  invalidatePreviewWork(reason: string): void;
  refreshActivePreviewRoot(force: boolean): Promise<void>;
  setPreviewRenderMode(mode: PreviewRenderMode): Promise<void>;
  setImageOptimizationIssues(entries: LogConsoleEntryInput[]): void;
  setEditorWarnings(warnings: ImageOptimizationWarning[]): void;
  showImages(imagePath: string | null): Promise<void>;
  log(kind: "info" | "warning", source: string, message: string): void;
}

const MAX_RECOMMENDED_DECODED_PREVIEW_IMAGE_BYTES = 64 * 1024 * 1024;
const MAX_RECOMMENDED_TOTAL_DECODED_PREVIEW_IMAGE_BYTES = 256 * 1024 * 1024;
const MAX_RECOMMENDED_PREVIEW_IMAGE_SOURCE_BYTES = 64 * 1024 * 1024;
const MAX_RECOMMENDED_UNIQUE_PREVIEW_IMAGES = 50;
const AGGREGATE_IMAGE_CONTRIBUTOR_BYTES = 32 * 1024 * 1024;
const MAX_RECOMMENDED_SINGLE_IMAGE_SOURCE_BYTES = 8 * 1024 * 1024;
const MAX_AGGREGATE_IMAGE_OPTIMIZATION_SUGGESTIONS = 5;

/** Owns Draft Preview state, image warnings, and generation-scoped thumbnails. */
export class DraftPreviewController {
  private profileValue: PreviewImageProfile | null = null;
  private modeValue: PreviewContentMode = "normal";
  private presentedModeValue: PreviewContentMode = "normal";
  private compiling = false;
  private assetsValue = new Map<string, DraftImageAsset>();
  private diagnosticsValue: DraftImageDiagnostic[] = [];
  private assetRootPathValue: string | null = null;
  private thumbnailDocumentRootPath: string | null = null;
  private thumbnailGenerationValue = 0;

  constructor(
    private readonly dialog: AppDialogController,
    private readonly port: DraftPreviewControllerPort,
  ) {}

  get profile(): PreviewImageProfile | null { return this.profileValue; }
  get mode(): PreviewContentMode { return this.modeValue; }
  get presentedMode(): PreviewContentMode { return this.presentedModeValue; }
  get assets(): ReadonlyMap<string, DraftImageAsset> { return this.assetsValue; }
  get diagnostics(): readonly DraftImageDiagnostic[] { return this.diagnosticsValue; }
  get assetRootPath(): string | null { return this.assetRootPathValue; }
  get thumbnailGeneration(): number { return this.thumbnailGenerationValue; }

  setMode(mode: PreviewContentMode, presentedMode?: PreviewContentMode): void {
    this.modeValue = mode;
    if (presentedMode !== undefined) this.presentedModeValue = presentedMode;
    this.updateControl();
  }

  installPresentedState(input: {
    mode: PreviewContentMode;
    assets?: readonly DraftImageAsset[];
    assetRootPath?: string | null;
    documentRootPath?: string | null;
    generation?: number;
  }): void {
    this.modeValue = input.mode;
    this.presentedModeValue = input.mode;
    this.assetsValue = new Map((input.assets ?? []).map(asset => [asset.id, asset]));
    this.diagnosticsValue = [];
    this.assetRootPathValue = input.assetRootPath ?? null;
    this.thumbnailDocumentRootPath = input.documentRootPath ?? null;
    this.thumbnailGenerationValue = input.generation ?? 0;
    this.updateControl(false);
  }

  async presentGeneration(input: {
    generation: number;
    mode: PreviewContentMode;
    assets: Map<string, DraftImageAsset>;
    diagnostics: DraftImageDiagnostic[];
    assetRootPath: string | null;
    documentRootPath: string | null;
  }): Promise<void> {
    this.presentedModeValue = input.mode;
    this.assetsValue = input.mode === "draft" ? input.assets : new Map();
    this.diagnosticsValue = input.mode === "draft" ? input.diagnostics : [];
    this.assetRootPathValue = input.mode === "draft" ? input.assetRootPath : null;
    this.thumbnailDocumentRootPath = input.mode === "draft" ? input.documentRootPath : null;
    if (input.mode === "draft") {
      this.thumbnailGenerationValue = input.generation;
      await this.startThumbnailQueue(input.generation);
    } else {
      this.thumbnailGenerationValue = 0;
      void invoke("cancel_draft_thumbnail_generation").catch(() => {});
    }
    this.updateControl(false);
  }

  reset(): void {
    this.profileValue = null;
    this.modeValue = "normal";
    this.presentedModeValue = "normal";
    this.compiling = false;
    this.assetsValue.clear();
    this.diagnosticsValue = [];
    this.assetRootPathValue = null;
    this.thumbnailDocumentRootPath = null;
    this.thumbnailGenerationValue = 0;
    void invoke("cancel_draft_thumbnail_generation").catch(() => {});
    this.updateControl();
    this.updateImageHeavyWarning(null);
    this.publishWarnings(null);
  }

  asset(id: string): DraftImageAsset | undefined {
    return this.assetsValue.get(id);
  }

  acceptsThumbnailMetric(generation: number): boolean {
    return generation === this.thumbnailGenerationValue;
  }

  async inspectImageProfile(rootPath: string | null): Promise<PreviewImageProfile | null> {
    if (!rootPath) {
      this.profileValue = null;
      this.publishWarnings(null);
      return null;
    }
    try {
      const activePath = this.port.activeFilePath();
      const activeSourcePath = activePath && isTypstDocumentPath(activePath) ? activePath : null;
      const editor = this.port.editor();
      const profile = await invoke<PreviewImageProfile>("typst_preview_image_profile", {
        rootPath,
        activeSourcePath,
        activeSourceContents: activeSourcePath && editor ? editor.state.doc.toString() : null,
      });
      this.profileValue = profile;
      this.publishWarnings(profile);
      return profile;
    } catch (error) {
      this.port.log("warning", "preview scheduler", `Could not inspect preview image dimensions: ${String(error)}`);
      return null;
    }
  }

  publishWarnings(profile = this.profileValue): void {
    const candidates = profile ? this.recommendedAssets(profile) : [];
    this.port.setImageOptimizationIssues(candidates.map(image => ({
      kind: "warning",
      channel: "images",
      counted: true,
      source: "image optimization",
      filePath: image.path,
      fileName: fileNameFromPath(image.path),
      message: this.optimizationMessage(image, profile!),
      locations: image.references.map(reference => ({
        filePath: reference.sourcePath,
        fileName: fileNameFromPath(reference.sourcePath),
        line: reference.line,
        column: reference.column,
        offset: reference.fromUtf16,
        toOffset: reference.toUtf16,
      })),
    })));

    const activePath = this.port.activeFilePath();
    if (!profile || !activePath || !isTypstDocumentPath(activePath)) {
      this.port.setEditorWarnings([]);
      return;
    }
    const activeKey = filePathKey(activePath);
    const recommendedKeys = new Set(candidates.map(image => filePathKey(image.path)));
    const warnings: ImageOptimizationWarning[] = [];
    // Every referenced image gets a clickable gutter icon. Recommended images
    // keep the optimizer warning; ordinary images get an informational marker
    // that still opens Image Tools so authors can shrink the exported PDF.
    for (const image of profile.images) {
      const recommended = recommendedKeys.has(filePathKey(image.path));
      const severity: ImageOptimizationWarning["severity"] = recommended ? "warning" : "info";
      const message = recommended
        ? this.optimizationMessage(image, profile)
        : this.imageToolMessage(image);
      for (const reference of image.references) {
        if (filePathKey(reference.sourcePath) !== activeKey) continue;
        warnings.push({
          from: reference.fromUtf16,
          to: reference.toUtf16,
          message,
          imagePath: image.path,
          severity,
        });
      }
    }
    this.port.setEditorWarnings(warnings);
  }

  updateImageHeavyWarning(profile: PreviewImageProfile | null = this.profileValue): void {
    const button = document.getElementById("preview-image-warning-btn") as HTMLButtonElement | null;
    if (!button) return;
    if (!profile) {
      button.dataset.active = "false";
      button.classList.add("hidden");
      return;
    }
    const candidates = this.recommendedAssets(profile);
    const imageHeavy = candidates.length > 0
      || profile.estimatedTotalDecodedBytes > MAX_RECOMMENDED_TOTAL_DECODED_PREVIEW_IMAGE_BYTES
      || profile.totalSourceBytes > MAX_RECOMMENDED_PREVIEW_IMAGE_SOURCE_BYTES
      || profile.uniqueImageCount >= MAX_RECOMMENDED_UNIQUE_PREVIEW_IMAGES;
    if (!imageHeavy) {
      button.dataset.active = "false";
      button.classList.add("hidden");
      return;
    }
    const timing = this.port.renderMode() === "on-type"
      ? "Live preview may update slowly while typing."
      : "Preview may take longer to update after each save.";
    const summary = `${timing} ${profile.uniqueImageCount.toLocaleString()} raster image${profile.uniqueImageCount === 1 ? "" : "s"} may use about ${formatFileSize(profile.estimatedTotalDecodedBytes)} when decoded. Click for details.`;
    button.dataset.active = "true";
    button.title = summary;
    button.setAttribute("aria-label", `Image-heavy document warning. ${summary}`);
    button.classList.remove("hidden");
  }

  updateControl(compiling?: boolean): void {
    if (compiling !== undefined) this.compiling = compiling;
    const toggle = document.getElementById("preview-content-mode-toggle") as HTMLButtonElement | null;
    if (!toggle) return;
    const draftActive = this.modeValue === "draft";
    toggle.dataset.compiling = String(this.compiling);
    toggle.classList.toggle("active", draftActive);
    toggle.setAttribute("aria-checked", String(draftActive));
    const label = toggle.querySelector<HTMLElement>(".preview-content-mode-label");
    if (label) label.textContent = draftActive ? "Draft" : "Normal";
    toggle.setAttribute("aria-label", draftActive
      ? "Draft Preview active; switch to Normal Preview"
      : "Normal Preview active; switch to Draft Preview");
    const mismatch = this.presentedModeValue !== this.modeValue;
    toggle.title = this.compiling || mismatch
      ? `Preparing ${this.modeValue === "draft" ? "Draft" : "Normal"} Preview. The last successful ${this.presentedModeValue === "draft" ? "Draft" : "Normal"} Preview remains visible.`
      : this.modeValue === "draft"
        ? `Draft Preview is active. Click to return to Normal Preview. ${this.assetsValue.size} image asset(s) use ratio-preserving placeholders; ${this.diagnosticsValue.length} call(s) remain unchanged.`
        : "Normal Preview is active. Click to switch to Draft Preview.";
  }

  async changeMode(mode: PreviewContentMode): Promise<void> {
    if (!this.port.workspaceRootPath()) return;
    if (mode === this.modeValue) {
      if (mode === "draft" && this.presentedModeValue === "draft") await this.showDraftDetails();
      return;
    }
    this.modeValue = mode;
    this.updateControl(true);
    await this.port.saveWorkspaceState();
    this.port.invalidatePreviewWork(`preview content mode changed to ${mode}`);
    await this.port.refreshActivePreviewRoot(true);
  }

  async showImageHeavyDetails(): Promise<void> {
    const profile = this.profileValue;
    if (!profile) return;
    const candidates = this.recommendedAssets(profile);
    const visibleItems = profile.images.slice(0, 3).map(image =>
      `${fileNameFromPath(image.path)} (${image.width.toLocaleString()} × ${image.height.toLocaleString()}, about ${formatFileSize(image.estimatedDecodedBytes)} decoded from ${formatFileSize(image.sourceBytes)})`
    );
    const additional = profile.images.length > visibleItems.length
      ? ` and ${profile.images.length - visibleItems.length} more`
      : "";
    const renderMode = this.port.renderMode();
    const actions = [{ id: "close", label: "Close", primary: false }];
    if (candidates.length > 0) actions.push({ id: "view-images", label: "View Images", primary: false });
    if (renderMode === "on-type") actions.push({ id: "switch-on-save", label: "Use On Save", primary: true });
    if (this.modeValue !== "draft" && actions.length < 3) {
      actions.push({ id: "use-draft", label: "Use Draft Preview", primary: renderMode !== "on-type" });
    }
    const action = await this.dialog.show({
      title: "Image-heavy Document",
      subtitle: `${profile.uniqueImageCount} raster image${profile.uniqueImageCount === 1 ? "" : "s"} · ${formatFileSize(profile.estimatedTotalDecodedBytes)} estimated decoded`,
      description: `This preview references ${profile.referenceCount.toLocaleString()} supported raster image${profile.referenceCount === 1 ? "" : "s"} across ${profile.uniqueImageCount.toLocaleString()} unique file${profile.uniqueImageCount === 1 ? "" : "s"}, totaling ${formatFileSize(profile.totalSourceBytes)} on disk.\n\nLargest assets: ${visibleItems.join("; ")}${additional}.\n\n${renderMode === "on-type" ? "Repeated on-type compilation may make editing less responsive." : "The preview may take longer to update after each save."} Compilation will continue normally, and Typsastra will not modify the images.`,
      actions,
      cancelAction: "close",
    });
    if (action === "view-images") {
      await this.port.showImages(candidates[0]?.path ?? null);
      return;
    }
    if (action === "use-draft") {
      await this.changeMode("draft");
      return;
    }
    if (action !== "switch-on-save") return;
    await this.port.setPreviewRenderMode("on-save");
    this.updateImageHeavyWarning(profile);
    this.port.log("info", "preview scheduler", `Switched to render on save for an image-heavy document: unique=${profile.uniqueImageCount}; references=${profile.referenceCount}; source=${formatFileSize(profile.totalSourceBytes)}; decoded=${formatFileSize(profile.estimatedTotalDecodedBytes)}.`);
  }

  async loadImage(id: string) {
    if (this.presentedModeValue !== "draft" || !/^[a-f0-9]{24}$/.test(id)) return null;
    const asset = this.assetsValue.get(id);
    const workspaceRoot = this.port.workspaceRootPath();
    if (!asset || !workspaceRoot || this.thumbnailGenerationValue < 1) return null;
    const status = await invoke<DraftThumbnailStatus>("get_draft_thumbnail_status", {
      generation: this.thumbnailGenerationValue,
      workspaceRoot,
      id,
    }).catch(() => null);
    if (!status) return null;
    if (status.status === "failed") return { status: "failed" as const, message: "Image preview could not be prepared." };
    if (status.status === "pending" || status.status === "generating") return { status: status.status } as const;
    if (!status.path || !status.mimeType) {
      return { status: "failed" as const, message: "The prepared image preview is unavailable." };
    }
    const response = await invoke<ArrayBuffer | Uint8Array | number[]>("read_binary_file", { path: status.path });
    const bytes = response instanceof Uint8Array
      ? response
      : response instanceof ArrayBuffer
        ? new Uint8Array(response)
        : new Uint8Array(response);
    return {
      status: "ready" as const,
      bytes,
      mimeType: status.mimeType,
      filename: fileNameFromPath(asset.path),
      width: status.sourceWidth,
      height: status.sourceHeight,
      sourceBytes: status.sourceBytes,
    };
  }

  async startThumbnailQueue(generation: number): Promise<void> {
    const workspaceRoot = this.port.workspaceRootPath();
    if (
      generation !== this.port.previewGeneration()
      || this.presentedModeValue !== "draft"
      || !workspaceRoot
      || !this.thumbnailDocumentRootPath
      || this.assetsValue.size === 0
    ) return;
    const displayedPage = Math.max(1, this.port.previewPageStatus().currentPage || 1);
    const displayedPageAssetIds = await this.port.previewFrame().draftImageIdsForPage(displayedPage);
    if (generation !== this.port.previewGeneration() || this.presentedModeValue !== "draft") return;
    const summary = await invoke<DraftThumbnailQueueSummary>("start_draft_thumbnail_generation", {
      request: {
        generation,
        workspaceRoot,
        documentRootPath: this.thumbnailDocumentRootPath,
        assets: [...this.assetsValue.values()],
        displayedPageAssetIds,
      },
    }).catch(error => {
      this.port.log("warning", "draft thumbnails", `Could not start Draft thumbnail generation: ${String(error)}`);
      return null;
    });
    if (!summary || generation !== this.port.previewGeneration()) return;
    this.port.log("info", "draft thumbnails", `Draft thumbnail queue ${generation} started: ${summary.cacheHits} cache hit(s), ${summary.queued} queued, ${displayedPageAssetIds.length} image(s) on page ${displayedPage}.`);
  }

  private recommendedAssets(profile: PreviewImageProfile): PreviewImageAsset[] {
    const selected = new Map<string, PreviewImageAsset>();
    const select = (image: PreviewImageAsset) => selected.set(filePathKey(image.path), image);
    for (const image of profile.images) {
      if (image.estimatedDecodedBytes > MAX_RECOMMENDED_DECODED_PREVIEW_IMAGE_BYTES
        || image.sourceBytes > MAX_RECOMMENDED_SINGLE_IMAGE_SOURCE_BYTES) select(image);
    }
    if (profile.estimatedTotalDecodedBytes > MAX_RECOMMENDED_TOTAL_DECODED_PREVIEW_IMAGE_BYTES) {
      const remaining = Math.max(0, MAX_AGGREGATE_IMAGE_OPTIMIZATION_SUGGESTIONS - selected.size);
      profile.images
        .filter(image => image.estimatedDecodedBytes > AGGREGATE_IMAGE_CONTRIBUTOR_BYTES
          && !selected.has(filePathKey(image.path)))
        .sort((left, right) => right.estimatedDecodedBytes - left.estimatedDecodedBytes)
        .slice(0, remaining)
        .forEach(select);
    }
    return [...selected.values()].sort((left, right) => right.estimatedDecodedBytes - left.estimatedDecodedBytes);
  }

  private imageToolMessage(image: PreviewImageAsset): string {
    return [
      `${fileNameFromPath(image.path)} is ${image.width.toLocaleString()} × ${image.height.toLocaleString()} pixels`,
      `and uses ${formatFileSize(image.sourceBytes)} on disk (about ${formatFileSize(image.estimatedDecodedBytes)} when decoded).`,
      "Open Image Tools to compress or re-encode it and reduce the exported PDF size.",
    ].join(" ");
  }

  private optimizationMessage(image: PreviewImageAsset, profile: PreviewImageProfile): string {
    const reasons: string[] = [];
    if (image.estimatedDecodedBytes > MAX_RECOMMENDED_DECODED_PREVIEW_IMAGE_BYTES) {
      reasons.push("Its decoded size exceeds the recommended per-image preview budget.");
    } else if (profile.estimatedTotalDecodedBytes > MAX_RECOMMENDED_TOTAL_DECODED_PREVIEW_IMAGE_BYTES
      && image.estimatedDecodedBytes > AGGREGATE_IMAGE_CONTRIBUTOR_BYTES) {
      reasons.push(`It is a major contributor to the document's estimated ${formatFileSize(profile.estimatedTotalDecodedBytes)} decoded image total.`);
    }
    if (image.sourceBytes > MAX_RECOMMENDED_SINGLE_IMAGE_SOURCE_BYTES) {
      reasons.push(`Its ${formatFileSize(image.sourceBytes)} source file is unusually large.`);
    }
    return [
      `${fileNameFromPath(image.path)} is ${image.width.toLocaleString()} × ${image.height.toLocaleString()} pixels`,
      `and may require about ${formatFileSize(image.estimatedDecodedBytes)} when decoded.`,
      ...reasons,
      "Downscale its pixel dimensions to reduce live-preview memory and compilation work.",
      "Compressing or re-encoding it can reduce the source file and may reduce the exported PDF size.",
    ].join(" ");
  }

  private async showDraftDetails(): Promise<void> {
    const assets = [...this.assetsValue.values()];
    const sourceBytes = assets.reduce((total, asset) => total + asset.sourceBytes, 0);
    const decodedBytes = assets.reduce((total, asset) => total + asset.estimatedDecodedBytes, 0);
    const unresolved = this.diagnosticsValue.slice(0, 5).map(diagnostic =>
      `${fileNameFromPath(diagnostic.sourcePath)}: ${diagnostic.reason}`);
    const unresolvedSummary = this.diagnosticsValue.length === 0
      ? "All statically detectable local image calls were replaced."
      : `${this.diagnosticsValue.length} image call(s) remain unchanged.\n\n${unresolved.join("\n")}${this.diagnosticsValue.length > unresolved.length ? `\n…and ${this.diagnosticsValue.length - unresolved.length} more.` : ""}`;
    await this.dialog.show({
      title: "Draft Preview",
      subtitle: `${assets.length.toLocaleString()} ratio-preserving placeholder${assets.length === 1 ? "" : "s"}`,
      description: `Draft Preview keeps each source image's intrinsic aspect ratio and preserves the document's image sizing, fitting, and placement arguments. Hover or keyboard-focus a placeholder in the preview to inspect the original image.\n\nThe replaced images total ${formatFileSize(sourceBytes)} on disk and approximately ${formatFileSize(decodedBytes)} when decoded.\n\n${unresolvedSummary}\n\nPDF export always uses the original images.`,
      actions: [{ id: "close", label: "Close", primary: true }],
      cancelAction: "close",
    });
  }
}
