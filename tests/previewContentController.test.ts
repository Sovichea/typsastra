import { describe, expect, test } from "bun:test";

describe("preview content controller", () => {
  test("owns active preview-surface selection behind explicit dependencies", async () => {
    const source = await Bun.file(
      new URL("../src/preview/previewContentController.ts", import.meta.url),
    ).text();

    expect(source).toContain("export interface PreviewContentDependencies");
    expect(source).toContain("public suspendDocumentPreviewForImageTools(): void");
    expect(source).toContain("this.deps.markdownPreview.deactivate();");
    expect(source).toContain("public restoreMarkdownPreviewIfActive(): boolean");
    expect(source).toContain("this.deps.markdownPreview.activate(tab.path, tab.content);");
    expect(source).toContain("public renderImageToolPreview(");
    expect(source).toContain("public renderInteractiveImageViewer(");
    expect(source).toContain('setLoading("Preparing image preview…", false)');
    expect(source).toContain("isTableToolActive(): boolean;");
    expect(source).toContain("public async refreshActivePreviewRoot(");
    // A tool surface owns the pane, so the document preview must not reclaim it.
    expect(source).toContain("if (this.deps.isImageToolActive() || this.deps.isTableToolActive()) return;");
    expect(source).toContain('invoke<PreviewTarget>("resolve_preview_main"');
    expect(source).not.toContain(": any");
    expect(source).not.toContain("host: object");
    expect(source).not.toContain("new Proxy(");
  });

  test("keeps appController preview-content methods as delegates", async () => {
    const source = await Bun.file(new URL("../src/appController.ts", import.meta.url)).text();

    expect(source).toContain("new PreviewContentController({");
    expect(source).toContain("this.previewContentController.suspendDocumentPreviewForImageTools();");
    expect(source).toContain("this.previewContentController.restoreMarkdownPreviewIfActive()");
    expect(source).toContain("return this.previewContentController.noMainFileMessage();");
    expect(source).toContain("this.previewContentController.renderImageToolPreview(source, imagePath);");
    expect(source).toContain("return this.previewContentController.refreshActivePreviewRoot(forceRender);");
    expect(source).toContain("isTableToolActive: () => this.sidebarController.activeTool === \"tables\",");
    // Document preview rendering is blocked while the table tool owns the pane.
    expect(source).toContain("if (this.sidebarController.activeTool === \"tables\") return Promise.resolve();");
  });

  test("shows image loading before lazy editor and image-tool decoding", async () => {
    const activation = await Bun.file(
      new URL("../src/editor/editorTabActivationController.ts", import.meta.url),
    ).text();
    const imageTools = await Bun.file(
      new URL("../src/components/imageTools.ts", import.meta.url),
    ).text();

    expect(activation.indexOf("deps.presentation.showImageLoading(tab.path)")).toBeLessThan(
      activation.indexOf("await deps.loadEditorTabContent(tab)"),
    );
    expect(imageTools).toContain("this.showImagePreview(null, image.path);");
  });
});
