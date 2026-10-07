import { describe, expect, test } from "bun:test";
import {
  capturePreviewDocumentToken,
  previewDocumentTokenIsCurrent,
} from "../src/preview/previewDocumentGeneration";

describe("standalone PDF document replacement", () => {
  test("rejects asynchronous work owned by an older document generation", () => {
    const olderDocument = { name: "older" };
    const newerDocument = { name: "newer" };
    const olderWork = capturePreviewDocumentToken(4, olderDocument);
    const newerWork = capturePreviewDocumentToken(5, newerDocument);

    expect(previewDocumentTokenIsCurrent(olderWork, 5, newerDocument)).toBe(false);
    expect(previewDocumentTokenIsCurrent(olderWork, 4, newerDocument)).toBe(false);
    expect(previewDocumentTokenIsCurrent(newerWork, 5, newerDocument)).toBe(true);
  });

  test("keeps the old PDF visible until its replacement is ready", async () => {
    const source = await Bun.file(new URL("../src/preview/previewFrame.ts", import.meta.url)).text();
    const generation = source.indexOf("const generation = ++this.pdfGeneration;");
    const reset = source.indexOf("this.resetStandalonePdfSearch();", generation);
    const prepareSurface = source.indexOf("this.preparePdfReplacementSurface(existingIframeDoc);", generation);
    const ensureIframe = source.indexOf("const iframe = await this.ensureIframe();", generation);
    const openDocument = source.indexOf("PdfiumDocument.open(", ensureIframe);
    const prepareMethod = source.slice(
      source.indexOf("private preparePdfReplacementSurface("),
      source.indexOf("private finishPdfReplacementSurface("),
    );
    const installNewDocument = source.indexOf("this.pdfDoc = pdfDoc;", openDocument);
    const replacePages = source.indexOf("this.createPageSlots(iframeDoc, false);", installNewDocument);

    expect(generation).toBeGreaterThan(-1);
    expect(reset).toBeGreaterThan(generation);
    expect(reset).toBeLessThan(prepareSurface);
    expect(prepareSurface).toBeLessThan(ensureIframe);
    expect(ensureIframe).toBeLessThan(openDocument);
    expect(installNewDocument).toBeGreaterThan(openDocument);
    expect(replacePages).toBeGreaterThan(installNewDocument);
    expect(prepareMethod).toContain('viewer?.setAttribute("aria-busy", "true")');
    expect(prepareMethod).toContain('this.pdfDoc && viewer.querySelector(".pdf-page-canvas")');
    expect(prepareMethod).toContain('viewer.classList.add("pdf-retained-viewer")');
    expect(prepareMethod).toContain("viewer.style.minHeight = `${this.retainedViewer.scrollHeight}px`");
    expect(prepareMethod).not.toContain("this.pageSlots = []");
    expect(prepareMethod).toContain('viewer.classList.add("pdf-retained-viewer")');
    expect(source).toContain("this.trackReplacementPagePaints(iframeDoc)");
    expect(source).toContain("this.markReplacementPagePainted(pageNo)");
    expect(source).toContain("this.pendingReplacementPages.delete(pageNo)");
    expect(source).not.toContain("this.createPageSlots(iframeDoc, true);");
    expect(source).toContain('replaceElementChildren(viewer);'); // swapped after new PDF installation
    expect(source).toContain('this.mountedSessionKey = "";');
    expect(source).toContain('root.dataset.pdfReplacing !== "true"');
  });

  test("detaches the previous document when a replacement fails", async () => {
    const source = await Bun.file(new URL("../src/preview/previewFrame.ts", import.meta.url)).text();
    const failure = source.indexOf("} catch (error) {", source.indexOf("private async loadPdfSource("));
    const finallyBlock = source.indexOf("} finally {", failure);
    const failureBody = source.slice(failure, finallyBlock);

    expect(failureBody).toContain("this.pdfDoc = null;");
    expect(failureBody).toContain("this.pdfLoadingTask = null;");
    expect(failureBody).toContain("this.pageDimensions.clear();");
    expect(failureBody).toContain("classifyStandalonePdfLoadFailure(error)");
    expect(source).toContain("if (!doc || !this.pdfDoc || !this.isStandalonePdfSurface()) return;");
  });

  test("binds search to one immutable PDF document across every await", async () => {
    const source = await Bun.file(new URL("../src/preview/previewFrame.ts", import.meta.url)).text();

    expect(source).toContain("const documentToken = capturePreviewDocumentToken(this.pdfGeneration, pdfDoc);");
    expect(source).toContain("previewDocumentTokenIsCurrent(documentToken, this.pdfGeneration, this.pdfDoc)");
    expect(source.match(/if \(!isCurrent\(\)\) return;/g)?.length).toBeGreaterThanOrEqual(4);
  });
});
