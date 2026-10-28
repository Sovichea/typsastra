import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const controller = readFileSync(join(root, "src", "appController.ts"), "utf8");
const previewWindowController = readFileSync(join(root, "src", "preview", "previewWindowController.ts"), "utf8");
const editorInitializationController = readFileSync(join(root, "src", "editor", "editorInitializationController.ts"), "utf8");
const pdfRenderController = readFileSync(join(root, "src", "preview", "pdfPreviewRenderController.ts"), "utf8");
const pdfPreparationController = readFileSync(join(root, "src", "preview", "pdfPreviewPreparationController.ts"), "utf8");
const sourceNavigationController = readFileSync(join(root, "src", "preview", "previewSourceNavigationController.ts"), "utf8");
const appEventBindings = readFileSync(join(root, "src", "ui", "appEventBindings.ts"), "utf8");
const draftController = readFileSync(
  join(root, "src", "preview", "draftPreviewController.ts"),
  "utf8"
);
const previewFrame = readFileSync(join(root, "src", "preview", "previewFrame.ts"), "utf8");
const contextMenus = readFileSync(
  join(root, "src", "components", "contextMenuController.ts"),
  "utf8"
);
const styles = readFileSync(join(root, "src", "style.css"), "utf8");
const html = readFileSync(join(root, "index.html"), "utf8");
const plan = readFileSync(join(root, "docs", "V0_6_0_DRAFT_PREVIEW_IMPLEMENTATION_PLAN.md"), "utf8");

describe("Draft Preview", () => {
  test("exposes a workspace-persisted Normal/Draft toggle", () => {
    expect(html).toContain('id="preview-content-mode-toggle"');
    expect(html).toContain('role="switch"');
    expect(html).toContain('aria-checked="false"');
    expect(html).toContain('class="preview-content-mode-track"');
    expect(html).toContain('class="preview-content-mode-thumb"');
    expect(controller).toContain("previewContentMode: this.draftPreviewController.mode");
    expect(pdfPreparationController).toContain('previewContentMode: "normal"');
    expect(previewWindowController).toContain('deps.draftPreview.mode === "draft" ? "normal" : "draft"');
    expect(styles).toMatch(/\.preview-content-mode-toggle\s*\{[^}]*width:\s*108px;[^}]*min-width:\s*108px;/s);
    expect(styles).toMatch(
      /\.preview-content-mode-thumb\s*\{[^}]*background:\s*var\(--ui-text\);/
    );
    expect(styles).toMatch(/\.preview-content-mode-toggle\.active \.preview-content-mode-thumb\s*\{[^}]*translateX\(14px\)/s);
    expect(styles).toContain(".preview-content-mode-toggle:focus-visible");
    expect(styles).not.toMatch(
      /\.preview-content-mode-toggle\.active\s*\{[^}]*background:\s*var\(--ui-active-selection\)/
    );
    expect(styles).not.toMatch(
      /\.preview-content-mode-toggle\.active\s*\{[^}]*border-color:\s*var\(--ui-accent-color\)/
    );
    expect(styles).toMatch(/data-compiling="true"[^}]*\.preview-content-mode-track\s*\{[^}]*box-shadow:/s);
    expect(styles).not.toMatch(/data-compiling="true"[^}]*::after/);
  });

  test("keeps essential preview controls visible and progressively moves actions into the menu", () => {
    expect(styles).toMatch(/\.preview-actions\s*\{[^}]*flex-wrap:\s*nowrap;/s);
    expect(styles).toMatch(/\.preview-actions\s*\{[^}]*overflow-x:\s*hidden;/s);
    expect(styles).toMatch(/\.preview-actions\s*>\s*\*\s*\{[^}]*flex:\s*0 0 auto;/s);
    expect(html).toContain('data-preview-collapsible="zoom"');

    expect(html).toContain('data-preview-collapsible="recompile"');
    expect(html).toContain('data-preview-collapsible="undock"');
    expect(styles).toContain("@container preview-pane (max-width: 620px)");
    expect(styles).toContain("@container preview-pane (max-width: 430px)");
    expect(contextMenus).toContain('id="ctx-preview-zoom-fit"');

    expect(contextMenus).toContain('id="ctx-preview-recompile"');
    expect(contextMenus).toContain('id="ctx-export-pdf"');
    expect(contextMenus).toContain('id="ctx-preview-undock"');
    expect(contextMenus).toContain('this.menu.dataset.menuKind === "preview"');
    expect(previewFrame).toContain('window.postMessage({ type: "HIDE_CONTEXT_MENU" }, "*")');
  });

  test("commits the requested mode and image manifest only after PDF presentation", () => {
    const presentation = pdfRenderController.indexOf("await this.loadPdfPath(");
    const modeCommit = pdfRenderController.indexOf("await this.deps.draftPreview.presentGeneration({", presentation);
    expect(presentation).toBeGreaterThan(-1);
    expect(modeCommit).toBeGreaterThan(presentation);
    expect(draftController).toContain("this.presentedModeValue = input.mode");
    expect(draftController).toContain('this.assetsValue = input.mode === "draft" ? input.assets : new Map()');
  });

  test("uses draft annotations for safe hover inspection and ordinary inverse sync", () => {
    expect(previewFrame).toContain('target.kind === "draft-image"');
    expect(previewFrame).toContain("this.hideDraftImagePopover()");
    expect(previewFrame).toContain("URL.revokeObjectURL");
    expect(previewFrame).toContain('name: "preview.draft-hover"');
    expect(previewFrame).toContain("this.onPreviewClick({ draftImageId: annotationTarget.id })");
    expect(sourceNavigationController).toContain("await this.navigateToDraftPreviewImage(point.draftImageId)");
    expect(previewFrame).not.toContain('if (this.annotationTargets.get(annotationLink)?.kind === "draft-image")');
    expect(plan).toContain("including its fixed-size path label");
  });

  test("retargets a stationary Draft hover after gesture and middle-button scrolling", () => {
    expect(previewFrame).toContain("this.rememberDraftPointer(event)");
    expect(previewFrame).toContain("elementFromPoint(point.x, point.y)");
    expect(previewFrame).toContain("this.retargetDraftHoverAtPointer()");
    expect(previewFrame).toContain("this.rememberDraftPointer(event)");
    expect(previewFrame).toContain("this.scheduleDraftHoverRetarget()");
    expect(previewFrame).toContain("window.requestAnimationFrame(() => this.retargetDraftHoverAtPointer())");
    expect(previewFrame).toContain('this.motion.current().state !== "moving"');
    expect(previewFrame).toContain("this.isDraftLinkActive(link)");
    expect(previewFrame).not.toContain('link.matches(":hover, :focus")');
  });

  test("loads cached thumbnails from the backend-validated generation manifest", () => {
    const loaderStart = draftController.indexOf("async loadImage");
    const loaderEnd = draftController.indexOf("async startThumbnailQueue", loaderStart);
    const loader = draftController.slice(loaderStart, loaderEnd);
    expect(loader).toContain("this.assetsValue.get(id)");
    expect(loader).toContain('invoke<DraftThumbnailStatus>("get_draft_thumbnail_status"');
    expect(loader).toContain('invoke<ArrayBuffer | Uint8Array | number[]>("read_binary_file"');
    expect(loader).toContain("path: status.path");
    expect(loader).toContain("width: status.sourceWidth");
    expect(loader).toContain("height: status.sourceHeight");
    expect(loader).toContain("sourceBytes: status.sourceBytes");
    expect(loader).not.toContain("width: status.thumbnailWidth");
    expect(loader).not.toContain("sourceBytes: status.thumbnailBytes");
    expect(loader).not.toContain("path: asset.path");
    expect(loader).not.toContain("relativeFilePath(");
    expect(previewFrame).toContain("Preparing image preview…");
    expect(previewFrame).toContain("draftImageIdsForPage(pageNo: number)");
  });

  test("keeps Draft hover thumbnails available in the undocked preview", () => {
    expect(previewWindowController).toContain("deps.setWorkspaceRootPath(update.draftAssetRootPath ?? null)");
    expect(previewWindowController).toContain("deps.draftPreview.installPresentedState({");
    expect(previewWindowController).toContain("generation: update.draftThumbnailGeneration ?? 0");
    expect(previewWindowController).toContain("assets: update.draftAssets ?? []");
    expect(draftController).toContain("this.assetsValue = new Map((input.assets ?? [])");
  });

  test("keeps the undocked Normal/Draft control themed and interactive", () => {
    expect(previewWindowController).toContain('"preview-content-mode-request"');
    expect(previewWindowController).toContain("deps.draftPreview.updateControl(true)");
    expect(draftController).toContain("this.updateControl(false)");
    expect(previewWindowController).not.toContain("contentModeToggle.disabled = true");
    expect(appEventBindings).toContain('listenEvent<PreviewContentMode>("preview-content-mode-request"');
  });

  test("initializes preview options inside the undocked window", () => {
    expect(previewWindowController).toContain("this.initializeOptions(");
    expect(previewWindowController).toContain('action => emit("preview-window-action", action)');
    expect(previewWindowController).toContain('data-preview-action="zoom-fit"');
    expect(previewWindowController).toContain('data-preview-action="export-pdf"');
    expect(previewWindowController).toContain('data-preview-action="open-external"');
    expect(previewWindowController).toContain('data-preview-action="dock"');
    expect(appEventBindings).toContain('listenEvent<"export-pdf" | "open-external" | "recompile">("preview-window-action"');
  });

  test("starts one fixed native thumbnail queue after Draft presentation", () => {
    expect(draftController).toContain('invoke<DraftThumbnailQueueSummary>("start_draft_thumbnail_generation"');
    expect(draftController).toContain("displayedPageAssetIds");
    expect(draftController).toContain('invoke("cancel_draft_thumbnail_generation")');
    expect(draftController).not.toContain("reprioritize_draft_thumbnail");
    expect(plan).toContain("one immutable queue");
  });

  test("scopes thumbnails and editor overlays to the selected main document", async () => {
    const mirror = await Bun.file(
      new URL("../src-tauri/src/render_prepare/mirror.rs", import.meta.url)
    ).text();
    const thumbnails = await Bun.file(
      new URL("../src-tauri/src/render_prepare/draft_thumbnail.rs", import.meta.url)
    ).text();

    expect(mirror).toContain("collect_reachable_typst_files");
    expect(mirror).toContain("draft_reachable_files");
    expect(pdfPreparationController).toContain("result.draftReachableFiles");
    expect(pdfPreparationController).toContain("draftReachableFileKeys.has");
    expect(draftController).toContain("documentRootPath: this.thumbnailDocumentRootPath");
    expect(thumbnails).toContain("thumbnail_document_namespace");
    expect(thumbnails).toContain("thumbnail_root.join(cache_namespace)");
    expect(plan).toContain("main document's reachable local");
    expect(plan).toContain("separate namespace for each main document");
  });

  test("logs one aggregate thumbnail benchmark instead of per-image metrics", async () => {
    const native = await Bun.file(
      new URL("../src-tauri/src/render_prepare/draft_thumbnail.rs", import.meta.url)
    ).text();

    expect(native).toContain('"draft-thumbnail-queue-metric"');
    expect(native).not.toContain('"draft-thumbnail-metric"');
    expect(editorInitializationController).toContain(
      'listen<DraftThumbnailQueueMetric>("draft-thumbnail-queue-metric"'
    );
    expect(editorInitializationController).toContain("Draft thumbnail cache ${metric.status}");
    expect(editorInitializationController).not.toContain(
      'listen<DraftThumbnailMetric>("draft-thumbnail-metric"'
    );
  });

  test("reports persisted Draft preparation reuse separately from same-generation overlays", () => {
    expect(pdfRenderController).toContain("projectManifestCacheHits");
    expect(pdfRenderController).toContain("overlayManifestCacheHits");
    expect(pdfRenderController).toContain("overlayPreparations");
    expect(pdfPreparationController).toContain("result.draftCacheHits");
    expect(pdfPreparationController).toContain("generated.draftCacheHit");
    expect(pdfRenderController).toContain("backendTypMs");
    expect(pdfRenderController).toContain("backendAssetMs");
    expect(pdfRenderController).toContain("projectPreparationMs");
    expect(pdfRenderController).toContain("overlayPreparationMs");
  });

  test("keeps cached hover previews compact in storage and on screen", () => {
    expect(plan).toContain("capped below 100 KiB per thumbnail");
    expect(plan).toContain("capped at 340 by 300 CSS pixels");
    expect(previewFrame).toContain("max-width:min(340px,calc(100vw - 16px))");
    expect(previewFrame).toContain("max-height:min(240px,calc(100vh - 58px))");
    expect(previewFrame).toContain("maximumImageHeight / naturalHeight");
    expect(previewFrame).toContain("popover.style.width = `${renderedImageWidth + 16}px`");
    expect(previewFrame).toContain("formatFileSize(image.sourceBytes)");
    expect(previewFrame).not.toContain("`${image.filename} - ${image.width.toLocaleString()}");
  });

  test("documents exact intrinsic ratio and original-image export guarantees", () => {
    expect(plan).toMatch(/exact\s+intrinsic aspect ratio/);
    expect(plan).toContain("PDF export always uses Normal Preview");
    expect(plan).toContain("original images");
  });
});
