import { describe, expect, test } from "bun:test";

describe("UI responsiveness safeguards", () => {
  test("does not restyle every descendant when pane resizing begins", async () => {
    const css = await Bun.file(new URL("../src/style.css", import.meta.url)).text();
    expect(css).not.toContain("body.typsastra-resizing *");
    expect(css).toContain("body.typsastra-resizing::before");
  });

  test("coalesces compiler-driven log rendering and skips hidden console DOM work", async () => {
    const source = await Bun.file(
      new URL("../src/diagnostics/logConsoleController.ts", import.meta.url),
    ).text();
    expect(source).toContain("if (!this.visible || this.renderFrame !== null) return");
    expect(source).toContain("requestAnimationFrame");
  });

  test("defers retired PDF cleanup until the UI is idle and no resize is active", async () => {
    const source = await Bun.file(new URL("../src/preview/previewFrame.ts", import.meta.url)).text();
    expect(source).toContain("await waitForUiIdle()");
    expect(source).toContain("while (this.resizeLayoutSuspended)");
  });

  test("keeps PDF presentation and source-map warm-up out of active pane drags", async () => {
    const source = await Bun.file(new URL("../src/appController.ts", import.meta.url)).text();
    const exportComplete = source.indexOf("Tinymist PDF export complete.");
    const resizeBoundary = source.indexOf("await this.waitForHorizontalPaneResizeEnd()", exportComplete);
    const presentation = source.indexOf("await this.loadPdfPath(", resizeBoundary);
    expect(exportComplete).toBeGreaterThan(-1);
    expect(resizeBoundary).toBeGreaterThan(exportComplete);
    expect(presentation).toBeGreaterThan(resizeBoundary);
    expect(source).toContain("this.horizontalPaneResizeActive || this.pdfPreviewRunning");
    expect(source).toContain("this.schedulePdfSourceMapWarmup(generation)");
  });

  test("recovers an interrupted pane drag and stale source-map socket after system resume", async () => {
    const appSource = await Bun.file(new URL("../src/appController.ts", import.meta.url)).text();
    const layoutSource = await Bun.file(new URL("../src/layout/layoutController.ts", import.meta.url)).text();
    expect(appSource).toContain("recoverAfterSystemResume");
    expect(appSource).toContain("this.layoutController.recoverInterruptedResize()");
    expect(appSource).toContain('this.refreshEditorLayout("system resume")');
    expect(layoutSource).toContain("recoverInterruptedResize");
    expect(layoutSource).toContain('document.body.classList.remove("typsastra-resizing")');
  });

  test("does not sample memory or build an unbounded promise chain for no-op file events", async () => {
    const source = await Bun.file(new URL("../src/appController.ts", import.meta.url)).text();
    expect(source).not.toContain('logMemoryDiagnostics("workspace watcher: self-save suppressed")');
    expect(source).not.toContain("workspaceChangeQueue");
    expect(source).toContain("pendingWorkspaceChanges = new Map");
    expect(source).toContain("pending.paths = [...new Set([...pending.paths, ...change.paths])]");
  });
});
