import { describe, expect, test } from "bun:test";

describe("PDF preview preparation controller", () => {
  test("owns render-mirror preparation behind an explicit typed dependency port", async () => {
    const source = await Bun.file(
      new URL("../src/preview/pdfPreviewPreparationController.ts", import.meta.url),
    ).text();

    expect(source).toContain("export interface PdfPreviewPreparationDependencies");
    expect(source).toContain("private readonly generatedFilesValue = new Map");
    expect(source).toContain(
      "prepareRenderProjectWithCopyGuard<RenderPreparationResult>(options)",
    );
    expect(source).toContain('invoke<RenderPreparationFileResult>("prepare_render_file"');
    expect(source).not.toContain("enableKhmerZws");
    expect(source).toContain("public ensureCurrent(revision: number): void");
    expect(source).not.toContain(": any");
    expect(source).not.toContain("host: object");
    expect(source).not.toContain("new Proxy(");
  });

  test("keeps preparation ownership out of appController and exposes only required delegates", async () => {
    const source = await Bun.file(new URL("../src/appController.ts", import.meta.url)).text();
    const renderSource = await Bun.file(
      new URL("../src/preview/pdfPreviewRenderController.ts", import.meta.url),
    ).text();

    expect(source).toContain("new PdfPreviewPreparationController({");
    expect(renderSource).toContain("this.deps.preparation.prepare(");
    expect(renderSource).toContain("this.deps.preparation.closePreparedDocuments()");
    expect(renderSource).toContain('invoke<string>("compile_render_preview_pdf"');
    expect(renderSource).not.toContain("exportPdfToFile(previewPath)");
    expect(source).toContain("return this.pdfPreviewPreparationController.generatedPreviewText(originalPath);");
    expect(source).toContain("return this.pdfPreviewPreparationController.generatedFiles;");
    expect(source).toContain("return this.pdfPreviewPreparationController.prepareProjectIfNeeded();");
    expect(source).not.toContain('invoke<RenderPreparationResult>("prepare_render_project"');
    expect(source).not.toContain('invoke<RenderPreparationFileResult>("prepare_render_file"');
  });
});
