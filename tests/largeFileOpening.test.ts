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

  test("keeps standalone PDF confirmation in the preview pane", async () => {
    const controller = await Bun.file(new URL("../src/appController.ts", import.meta.url)).text();
    const renderController = await Bun.file(
      new URL("../src/preview/pdfPreviewRenderController.ts", import.meta.url),
    ).text();
    const guard = await Bun.file(
      new URL("../src/editor/editorFileGuardController.ts", import.meta.url),
    ).text();
    const confirmationStart = guard.indexOf("showLargeFileConfirmation");
    const confirmationEnd = guard.indexOf("private observeAlignment", confirmationStart);
    const confirmationSource = guard.slice(confirmationStart, confirmationEnd);

    expect(confirmationSource).toContain('if (notice.kind === "pdf")');
    expect(confirmationSource).toContain("this.deps.onPdfBlocked(path)");
    expect(controller).toContain("this.blockedLargePdfPaths.add(filePathKey(path))");
    expect(controller).toContain("this.pdfPreviewRenderController.cancelPendingPdfLoad()");
    expect(controller).toContain("this.invalidatePreviewWork(");
    expect(confirmationSource).toContain("this.deps.previewFrame().setConfirmationMessage({");
    expect(confirmationSource).toContain("Large PDF Preview Not Started");
    expect(confirmationSource).toContain('confirmLabel: "Open Large PDF"');
    expect(confirmationSource).toContain("this.deps.onPdfUnblocked(path)");

    const loadStart = renderController.indexOf("public async loadPdfPath");
    const loadSource = renderController.slice(loadStart);
    expect(loadSource).toContain("if (this.deps.isPdfBlocked(path)) return 0");
    expect(loadSource).toContain("const requestGeneration = ++this.loadRequestGeneration");
    expect(loadSource).toContain("this.deps.isPdfBlocked(path)");
  });

  test("routes large Typst preview approval through the editor guard", async () => {
    const controller = await Bun.file(new URL("../src/appController.ts", import.meta.url)).text();
    const previewGuard = await Bun.file(
      new URL("../src/workspace/largePreviewGuardController.ts", import.meta.url),
    ).text();
    const noticeStart = previewGuard.indexOf("async noticeForTab(tab: EditorTab)");
    const noticeEnd = previewGuard.indexOf("async previewTargetForUnloadedTab", noticeStart);
    const noticeSource = previewGuard.slice(noticeStart, noticeEnd);
    expect(noticeSource).toContain("this.previewTargetForUnloadedTab(tab)");
    expect(noticeSource).toContain("this.noticeForRoot(target.rootPath)");
    expect(noticeSource).toContain("this.approvedRoots.has(rootKey)");

    const guard = await Bun.file(
      new URL("../src/editor/editorFileGuardController.ts", import.meta.url),
    ).text();
    const confirmationStart = guard.indexOf("showLargeFileConfirmation");
    const confirmationEnd = guard.indexOf("private observeAlignment", confirmationStart);
    const confirmationSource = guard.slice(confirmationStart, confirmationEnd);
    expect(confirmationSource).toContain("this.deps.onTypstPreviewBlocked(notice.previewRootPath ?? path)");
    expect(controller).toContain("this.workspaceServicesDeferredForLargeFile = true");
    expect(confirmationSource).toContain("await this.deps.approveLargePreview(tab, notice)");
    expect(confirmationSource).toContain('"Large Typst Document"');
    expect(confirmationSource).not.toContain('"Large Main Document Preview"');
    expect(confirmationSource).toContain("Open and Compile Preview");
    expect(confirmationSource).toContain("The compiler preview will start after you confirm opening the large Typst file.");

    const lifecycle = await Bun.file(
      new URL("../src/workspace/workspaceLifecycleController.ts", import.meta.url),
    ).text();
    const servicesStart = lifecycle.indexOf("async startServices");
    const servicesEnd = lifecycle.indexOf("async restoreToolchain", servicesStart);
    const servicesSource = lifecycle.slice(servicesStart, servicesEnd);
    expect(servicesSource).toContain("app.workspaceServicesDeferredForLargeFile");

    const activation = await Bun.file(
      new URL("../src/editor/editorTabActivationController.ts", import.meta.url),
    ).text();
    const resumeIndex = activation.indexOf("deps.resumeDeferredWorkspaceServices();");
    const prepareIndex = activation.indexOf("await deps.previewActivation.prepare");
    expect(resumeIndex).toBeGreaterThan(-1);
    expect(resumeIndex).toBeLessThan(prepareIndex);
  });
});
