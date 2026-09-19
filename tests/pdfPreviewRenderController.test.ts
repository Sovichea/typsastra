import { describe, expect, test } from "bun:test";

describe("PDF preview render controller", () => {
  test("owns render scheduling and transport state behind an explicit dependency interface", async () => {
    const source = await Bun.file(
      new URL("../src/preview/pdfPreviewRenderController.ts", import.meta.url),
    ).text();

    expect(source).toContain("export interface PdfPreviewRenderDependencies");
    expect(source).toContain("private generationValue = 0");
    expect(source).toContain("private scheduleGeneration = 0");
    expect(source).toContain("private queuedContents: string | null = null");
    expect(source).toContain("public async render(contents: string, force = false)");
    expect(source).toContain("public schedule(contents: string, delayMs: number)");
    expect(source).toContain("public async loadPdfPath(");
    expect(source).toContain('surface === "pdf"');
    expect(source).toContain('setLoading("Preparing PDF preview…", false)');
    expect(source).toContain('setLoading("Compiling live preview…")');
    expect(source).toContain("public resetForWorkspaceClose(): void");
    expect(source).not.toContain(": any");
    expect(source).not.toContain("host: object");
    expect(source).not.toContain("new Proxy(");
  });

  test("compiles the disk-backed mirror with its project root", async () => {
    const source = await Bun.file(
      new URL("../src/preview/pdfPreviewRenderController.ts", import.meta.url),
    ).text();

    expect(source).toContain('invoke<string>("compile_render_preview_pdf"');
    expect(source).toContain("entryFilePath: previewPath");
    expect(source).toContain("cacheRootPath: cacheRoot");
    expect(source).toContain("workspaceRootPath");
    expect(source).not.toContain("exportPdfToFile(previewPath)");
  });

  test("keeps an identical generated PDF mounted across live preview session changes", async () => {
    const source = await Bun.file(
      new URL("../src/preview/pdfPreviewRenderController.ts", import.meta.url),
    ).text();
    const hash = source.indexOf("const pdfHash = await this.hashGeneratedPdf(pdfPath)");
    const reuse = source.indexOf("const keepMountedPreview = pdfHash !== null", hash);
    const stage = source.indexOf('invoke<string>("stage_pdf_preview_generation"', reuse);
    const load = source.indexOf("await this.loadPdfPath(", stage);
    const publishGuard = source.indexOf("if (publishedPdfPath)", load);

    expect(hash).toBeGreaterThan(-1);
    expect(reuse).toBeGreaterThan(hash);
    expect(stage).toBeGreaterThan(reuse);
    expect(load).toBeGreaterThan(stage);
    expect(publishGuard).toBeGreaterThan(load);
    expect(source).toContain("this.lastPresentedLivePdfHash === pdfHash");
    expect(source).toContain("this.deps.previewFrame.retainMountedLivePreview(previewPath, sessionKey)");
    expect(source).not.toContain("this.lastPresentedLivePdf.identity === previewPath");
    expect(source).not.toContain("this.lastPresentedLivePdf.sessionKey === sessionKey");
    expect(source).toContain('invoke("discard_generated_preview_pdf"');
    expect(source).toContain("generated PDF is unchanged; keeping the mounted preview");
    expect(source).toContain("this.deps.previewFrame.preserveViewportForNextLoad(viewportAnchor, scrollTop)");
    expect(source).toContain("private hasLiveViewportValue = false");
    expect(source).toContain("public rememberLiveViewport(");
    expect(source).toContain('surface === "pdf"');
  });

  test("restores the live viewport when reopening the cached low-memory PDF", async () => {
    const source = await Bun.file(
      new URL("../src/preview/pdfPreviewRenderController.ts", import.meta.url),
    ).text();
    const restore = source.indexOf("const cached = await this.deps.restoreLowMemoryPreviewCache()");
    const load = source.indexOf("await this.loadPdfPath(", restore);
    const block = source.slice(restore, load);

    expect(restore).toBeGreaterThan(-1);
    expect(block).toContain("if (this.hasLiveViewportValue)");
    expect(block).toContain("this.deps.previewFrame.preserveViewportForNextLoad(");
    expect(block).toContain("this.liveViewportAnchorValue");
    expect(block).toContain("this.liveScrollTopValue");
  });

  test("falls back to replacing the preview when hashing fails", async () => {
    const source = await Bun.file(
      new URL("../src/preview/pdfPreviewRenderController.ts", import.meta.url),
    ).text();
    const methodStart = source.indexOf("private async hashGeneratedPdf");
    const methodEnd = source.indexOf("\n  public async loadPdfPath", methodStart);
    const method = source.slice(methodStart, methodEnd);

    expect(method).toContain('invoke<string>("hash_preview_file", { path })');
    expect(method).toContain("catch (error)");
    expect(method).toContain("return null");
    expect(method).toContain("replacing the preview normally");
    expect(source).toContain("this.lastPresentedLivePdfHash = null");
  });

  test("keeps appController as a thin delegate for render, load, schedule, and invalidation", async () => {
    const source = await Bun.file(new URL("../src/appController.ts", import.meta.url)).text();

    expect(source).toContain("new PdfPreviewRenderController({");
    expect(source).toContain("return this.pdfPreviewRenderController.render(contents, force);");
    expect(source).toContain("return this.pdfPreviewRenderController.loadPdfPath(");
    expect(source).toContain("this.pdfPreviewRenderController.schedule(contents, delayMs);");
    expect(source).toContain("this.pdfPreviewRenderController.invalidate(reason);");
    expect(source).not.toContain("private pdfPreviewTimer");
    expect(source).not.toContain("private queuedPdfPreviewContents");
  });

  test("resets controller-owned preview state when a workspace closes", async () => {
    const lifecycle = await Bun.file(
      new URL("../src/workspace/workspaceLifecycleController.ts", import.meta.url),
    ).text();

    expect(lifecycle).toContain("app.pdfPreviewRenderController.resetForWorkspaceClose();");
    expect(lifecycle).toContain("app.pdfPreviewPreparationController.clearGeneratedFiles();");
    expect(lifecycle).not.toContain("app.pdfPreviewGeneration += 1");
    expect(lifecycle).not.toContain("app.pdfPreviewSourceMapRootPath = null");
    expect(lifecycle).not.toContain('app.lastPdfPath = ""');
  });
});
