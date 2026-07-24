import { describe, expect, test } from "bun:test";
import {
  LARGE_PDF_FILE_BYTES,
  LARGE_TEXT_FILE_BYTES,
  LARGE_TEXT_FILE_LINES,
  formatFileSize,
  largeFileOpeningNotice,
  largeMainPreviewOpeningNotice,
} from "../src/workspace/largeFileOpening";

describe("large file opening notice", () => {
  test("notifies for large text and PDF files at independent thresholds", () => {
    expect(largeFileOpeningNotice("chapter.typ", LARGE_TEXT_FILE_BYTES)).toEqual({
      kind: "text",
      sizeBytes: LARGE_TEXT_FILE_BYTES,
    });
    expect(largeFileOpeningNotice("book.pdf", LARGE_PDF_FILE_BYTES)).toEqual({
      kind: "pdf",
      sizeBytes: LARGE_PDF_FILE_BYTES,
    });
    expect(largeFileOpeningNotice("chapter.typ", LARGE_TEXT_FILE_BYTES - 1)).toBeNull();
    expect(largeFileOpeningNotice("book.pdf", LARGE_PDF_FILE_BYTES - 1)).toBeNull();
  });

  test("also guards text files with many short lines", () => {
    expect(largeFileOpeningNotice("chapter.typ", 200 * 1024, LARGE_TEXT_FILE_LINES)).toEqual({
      kind: "text",
      sizeBytes: 200 * 1024,
      lineCount: LARGE_TEXT_FILE_LINES,
    });
  });

  test("does not classify binary images or unsupported files as large text", () => {
    expect(largeFileOpeningNotice("figure.png", LARGE_PDF_FILE_BYTES)).toBeNull();
    expect(largeFileOpeningNotice("archive.zip", LARGE_PDF_FILE_BYTES)).toBeNull();
  });

  test("describes a large Typst preview root separately from the opened chapter", () => {
    expect(largeMainPreviewOpeningNotice("book.typ", LARGE_TEXT_FILE_BYTES)).toEqual({
      kind: "main-preview",
      sizeBytes: LARGE_TEXT_FILE_BYTES,
      previewRootPath: "book.typ",
      previewSourceFiles: undefined,
    });
    expect(largeMainPreviewOpeningNotice(
      "book.typ",
      200 * 1024,
      LARGE_TEXT_FILE_LINES,
    )).toEqual({
      kind: "main-preview",
      sizeBytes: 200 * 1024,
      lineCount: LARGE_TEXT_FILE_LINES,
      previewRootPath: "book.typ",
      previewSourceFiles: undefined,
    });
    expect(largeMainPreviewOpeningNotice(
      "book.typ",
      LARGE_TEXT_FILE_BYTES,
      LARGE_TEXT_FILE_LINES,
      8,
    )?.previewSourceFiles).toBe(8);
    expect(largeMainPreviewOpeningNotice("book.typ", LARGE_TEXT_FILE_BYTES - 1)).toBeNull();
    expect(largeMainPreviewOpeningNotice("book.pdf", LARGE_PDF_FILE_BYTES)).toBeNull();
  });

  test("formats the size for the user-facing status", () => {
    expect(formatFileSize(768 * 1024)).toBe("768 KB");
    expect(formatFileSize(1.5 * 1024 * 1024)).toBe("1.5 MB");
    expect(formatFileSize(100 * 1024 * 1024)).toBe("100 MB");
  });

  test("replaces a stale live preview while a large PDF awaits confirmation", async () => {
    const controller = await Bun.file(new URL("../src/appController.ts", import.meta.url)).text();
    const confirmationStart = controller.indexOf("private showLargeFileConfirmation");
    const confirmationEnd = controller.indexOf("private async openFileExternally", confirmationStart);
    const confirmationSource = controller.slice(confirmationStart, confirmationEnd);

    expect(confirmationSource).toContain('if (notice.kind === "pdf")');
    expect(confirmationSource).toContain("this.blockedLargePdfPaths.add(filePathKey(path))");
    expect(confirmationSource).toContain("this.pdfLoadRequestGeneration += 1");
    expect(confirmationSource).toContain("this.invalidatePreviewWork(");
    expect(confirmationSource).toContain("this.previewFrame.setMessage(");
    expect(confirmationSource).toContain("Large PDF Preview Paused");
    expect(confirmationSource).toContain("this.blockedLargePdfPaths.delete(filePathKey(path))");

    const loadStart = controller.indexOf("private async loadPdfPath");
    const loadEnd = controller.indexOf("private async syncPreparedPreviewDocuments", loadStart);
    const loadSource = controller.slice(loadStart, loadEnd);
    expect(loadSource).toContain("if (this.blockedLargePdfPaths.has(pathKey)) return 0");
    expect(loadSource).toContain("const requestGeneration = ++this.pdfLoadRequestGeneration");
    expect(loadSource).toContain("this.blockedLargePdfPaths.has(pathKey)");
  });
});
