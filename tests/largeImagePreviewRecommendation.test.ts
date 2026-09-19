import { describe, expect, test } from "bun:test";

describe("large-image preview recommendation", () => {
  test("uses aggregate image pressure without blocking preview compilation", async () => {
    const controller = await Bun.file(
      new URL("../src/preview/pdfPreviewRenderController.ts", import.meta.url),
    ).text();
    const draftController = await Bun.file(new URL("../src/preview/draftPreviewController.ts", import.meta.url)).text();
    const start = draftController.indexOf("updateImageHeavyWarning");
    const end = draftController.indexOf("updateControl", start);
    const method = draftController.slice(start, end);

    expect(method).toContain("estimatedTotalDecodedBytes > MAX_RECOMMENDED_TOTAL_DECODED_PREVIEW_IMAGE_BYTES");
    expect(method).toContain("totalSourceBytes > MAX_RECOMMENDED_PREVIEW_IMAGE_SOURCE_BYTES");
    expect(method).toContain("uniqueImageCount >= MAX_RECOMMENDED_UNIQUE_PREVIEW_IMAGES");
    expect(method).toContain('getElementById("preview-image-warning-btn")');
    expect(method).toContain('button.dataset.active = "true"');
    expect(method).toContain("Click for details.");
    expect(method).toContain("Preview may take longer to update after each save.");
    expect(draftController).toContain("activeSourceContents: activeSourcePath && editor ? editor.state.doc.toString() : null");
    expect(draftController).toContain('title: "Image-heavy Document"');
    expect(draftController).toContain('{ id: "view-images", label: "View Images", primary: false }');
    expect(draftController).toContain('{ id: "switch-on-save", label: "Use On Save", primary: true }');
    expect(draftController).toContain('this.modeValue !== "draft" && actions.length < 3');
    expect(draftController).toContain('await this.port.setPreviewRenderMode("on-save")');
    expect(draftController).toContain("Compilation will continue normally");
    const renderStart = controller.indexOf("public async render(");
    const renderEnd = controller.indexOf("public recompileManually", renderStart);
    const renderMethod = controller.slice(renderStart, renderEnd);
    expect(renderMethod).toContain("this.deps.draftPreview.updateImageHeavyWarning(imageProfile);");
    expect(renderMethod).not.toContain("recommendOnSaveForImageHeavyPreview");
    expect(renderMethod).not.toMatch(/updateImageHeavyPreviewWarning\(imageProfile\)[\s\S]{0,80}return;/);
  });

  test("recommends hard offenders and a bounded set of aggregate contributors", async () => {
    const controller = await Bun.file(new URL("../src/preview/draftPreviewController.ts", import.meta.url)).text();
    const start = controller.indexOf("private recommendedAssets");
    const end = controller.indexOf("private optimizationMessage", start);
    const method = controller.slice(start, end);

    expect(controller).toContain("const MAX_RECOMMENDED_DECODED_PREVIEW_IMAGE_BYTES = 64 * 1024 * 1024");
    expect(controller).toContain("const AGGREGATE_IMAGE_CONTRIBUTOR_BYTES = 32 * 1024 * 1024");
    expect(controller).toContain("const MAX_RECOMMENDED_SINGLE_IMAGE_SOURCE_BYTES = 8 * 1024 * 1024");
    expect(controller).toContain("const MAX_AGGREGATE_IMAGE_OPTIMIZATION_SUGGESTIONS = 5");
    expect(method).toContain("image.estimatedDecodedBytes > MAX_RECOMMENDED_DECODED_PREVIEW_IMAGE_BYTES");
    expect(method).toContain("image.sourceBytes > MAX_RECOMMENDED_SINGLE_IMAGE_SOURCE_BYTES");
    expect(method).toContain("profile.estimatedTotalDecodedBytes > MAX_RECOMMENDED_TOTAL_DECODED_PREVIEW_IMAGE_BYTES");
    expect(method).toContain("image.estimatedDecodedBytes > AGGREGATE_IMAGE_CONTRIBUTOR_BYTES");
    expect(method).toContain("MAX_AGGREGATE_IMAGE_OPTIMIZATION_SUGGESTIONS - selected.size");
    expect(controller).toContain("this.recommendedAssets(profile)");
  });

  test("registers the read-only raster metadata command", async () => {
    const backend = await Bun.file(new URL("../src-tauri/src/lib.rs", import.meta.url)).text();
    expect(backend).toMatch(/#\[tauri::command\]\r?\nfn typst_preview_image_profile\(/u);
    expect(backend).toMatch(/\.invoke_handler\(tauri::generate_handler!\[[\s\S]*typst_preview_image_profile,/);
    expect(backend).toContain("estimated_total_decoded_bytes");
    expect(backend).toContain("reference_count");
  });

  test("publishes oversized image references in a dedicated warning gutter", async () => {
    const controller = await Bun.file(new URL("../src/appController.ts", import.meta.url)).text();
    const draftController = await Bun.file(new URL("../src/preview/draftPreviewController.ts", import.meta.url)).text();
    const warnings = await Bun.file(new URL("../src/editor/imageWarnings.ts", import.meta.url)).text();
    const consoleController = await Bun.file(new URL("../src/diagnostics/logConsoleController.ts", import.meta.url)).text();
    const markup = await Bun.file(new URL("../index.html", import.meta.url)).text();
    expect(controller).toContain("setImageOptimizationWarningsEffect.of(warnings)");
    expect(draftController).toContain("setImageOptimizationIssues(candidates.map");
    expect(draftController).toContain('channel: "images"');
    expect(draftController).toContain("Downscale its pixel dimensions");
    expect(draftController).toContain("may reduce the exported PDF size");
    expect(warnings).toContain('class: "cm-warningGutter"');
    expect(warnings).toContain("initialSpacer:");
    expect(warnings).toContain('marker.className = "cm-image-optimization-marker"');
    expect(consoleController).toContain('LogEntryChannel = "lsp" | "spellcheck" | "images" | "dev"');
    expect(consoleController).toContain('this.setTabCount("images", imageWarnings)');
    expect(consoleController).toContain('entry.channel === "images" && entry.locations?.[0]');
    expect(consoleController).toContain("void this.onNavigate({ ...entry, ...first, locations: undefined })");
    expect(markup).toContain('data-log-console-tab="images"');
    expect(markup).toContain('id="preview-image-warning-btn"');
    expect(warnings).toContain('createAppIcon("triangleAlert", { size: 17 })');
    expect(draftController).toContain('getElementById("preview-image-warning-btn")');
  });

  test("offers a clickable informational Image Tools marker for ordinary images", async () => {
    const draftController = await Bun.file(new URL("../src/preview/draftPreviewController.ts", import.meta.url)).text();
    const warnings = await Bun.file(new URL("../src/editor/imageWarnings.ts", import.meta.url)).text();

    expect(draftController).toContain("const recommendedKeys = new Set(candidates.map");
    expect(draftController).toContain('const severity: ImageOptimizationWarning["severity"] = recommended ? "warning" : "info"');
    expect(draftController).toContain("this.imageToolMessage(image)");
    expect(draftController).toContain("Open Image Tools to compress or re-encode it and reduce the exported PDF size.");
    expect(warnings).toContain('createAppIcon("info", { size: 15 })');
    expect(warnings).toContain('marker.classList.add("cm-image-info-marker")');
    expect(warnings).toContain('if ((warning.severity ?? "warning") === "warning") entry.severity = "warning"');
    expect(warnings).toContain("imageSeverity: marker.severity");
    // The shared click handler opens Image Tools for both warning and info markers.
    expect(warnings).toContain('window.dispatchEvent(new CustomEvent("typsastra-open-image-tool"');
  });

  test("plans a source-preserving draft preview for v0.6.0", async () => {
    const roadmap = await Bun.file(new URL("../docs/ROADMAP.md", import.meta.url)).text();
    const versionStart = roadmap.indexOf("## v0.6.0");
    const versionEnd = roadmap.indexOf("## v0.9.0", versionStart);
    const milestone = roadmap.slice(versionStart, versionEnd);
    expect(milestone).toContain("**Draft Preview**");
    expect(milestone).toContain("layout-preserving placeholders");
    expect(milestone).toContain("temporary UI overlay on demand");
    expect(milestone).toMatch(/never used for final PDF export/);
  });
});
