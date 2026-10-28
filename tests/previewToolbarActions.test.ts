import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ContextMenuController } from "../src/components/contextMenuController";
import { TypsastraWorkspaceController } from "../src/appController";

test("external viewer opens the displayed cached PDF rather than guessing a source-adjacent path", async () => {
  const opened: string[] = [];
  const workspace = Object.assign(Object.create(TypsastraWorkspaceController.prototype), {
    pdfPreviewRenderController: { lastPdfPath: "cache/preview/generations/current.pdf" },
    openFileExternally: async (path: string) => { opened.push(path); },
  });
  const menu = Object.assign(Object.create(ContextMenuController.prototype), {
    dependencies: { openPreviewExternally: () => workspace.openLastPreviewExternally() },
  });
  await menu.openPreviewPdf();
  expect(opened).toEqual(["cache/preview/generations/current.pdf"]);
  workspace.pdfPreviewRenderController.lastPdfPath = "images/reference.pdf";
  await menu.openPreviewPdf();
  expect(opened[1]).toBe("images/reference.pdf");
  workspace.pdfPreviewRenderController.lastPdfPath = "";
  await menu.openPreviewPdf();
  expect(opened).toHaveLength(2);
});

const root = join(import.meta.dir, "..");
const read = (...parts: string[]): string => readFileSync(join(root, ...parts), "utf8");

const html = read("index.html");
const app = read("src", "appController.ts");
const bindings = read("src", "ui", "appEventBindings.ts");
const contextMenu = read("src", "components", "contextMenuController.ts");
const icons = read("src", "ui", "icons.ts");
const sourceNavigation = read("src", "preview", "previewSourceNavigationController.ts");
const previewFrame = read("src", "preview", "previewFrame.ts");
const toolbar = read("src", "editor", "toolbarController.ts");

function methodBody(source: string, startToken: string, endToken: string): string {
  const start = source.indexOf(startToken);
  const end = source.indexOf(endToken, start + startToken.length);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("preview toolbar actions", () => {
  test("places reveal cursor in the editor toolbar with a crosshair icon", () => {
    expect(html).toContain('data-tool="reveal-cursor-preview"');
    expect(html).toContain('title="Reveal Cursor in Preview (Alt+Enter)"');
    expect(html).not.toContain('id="preview-forward-sync-btn"');
    expect(icons).toContain('"reveal-cursor-preview": "crosshair"');
    expect(toolbar).toContain('case "reveal-cursor-preview":');
    expect(toolbar).toContain("this.dependencies.revealCursorInPreview()");
    expect(app).toContain("revealCursorInPreview: () => this.revealCursorInPreviewManually()");
    expect(sourceNavigation).toContain("'[data-tool=\"reveal-cursor-preview\"]'");
    expect(contextMenu).not.toContain('id="ctx-preview-forward-sync"');
  });

  test("opens search from the standalone PDF toolbar", () => {
    expect(html).toContain('id="preview-search-btn"');
    expect(html).toContain('title="Find in PDF (Ctrl+F)"');
    expect(bindings).toContain(
      'document.getElementById("preview-search-btn")?.addEventListener("click", actions.openStandalonePdfSearch)',
    );
    expect(app).toContain("openStandalonePdfSearch: () => this.previewFrame.openStandalonePdfSearch()");
    expect(previewFrame).toContain("public openStandalonePdfSearch(): void");
  });

  test("recompile restarts Tinymist and restores the preview viewport", () => {
    const recompile = methodBody(
      app,
      "private async recompilePreviewManually()",
      "private loadPdfPath",
    );
    const captureAnchor = recompile.indexOf("const viewportAnchor =");
    const captureScroll = recompile.indexOf("const scrollTop =");
    const invalidate = recompile.indexOf('this.invalidatePreviewWork("manual recompile is restarting Tinymist")');
    const restart = recompile.indexOf('await this.restartTinymistSession("Restarting Tinymist and recompiling preview...")');
    const sessionGuard = recompile.indexOf("const samePreviewSession = filePathKey(this.activeFilePath");
    const preserve = recompile.indexOf("this.previewFrame.preserveViewportForNextLoad(viewportAnchor, scrollTop)");
    const restore = recompile.indexOf("await this.restoreActiveDocumentAfterTinymistRestart(true)");

    expect(captureAnchor).toBeGreaterThan(-1);
    expect(captureScroll).toBeGreaterThan(captureAnchor);
    expect(invalidate).toBeGreaterThan(captureScroll);
    expect(restart).toBeGreaterThan(invalidate);
    expect(sessionGuard).toBeGreaterThan(restart);
    expect(preserve).toBeGreaterThan(sessionGuard);
    expect(restore).toBeGreaterThan(preserve);
    expect(recompile).not.toContain("recordPreviewScrollPosition");
    expect(recompile).not.toContain("queueViewportAnchor");
    expect(recompile).not.toContain("queueTabScrollPosition");
    expect(recompile).not.toContain("pdfPreviewRenderController.recompileManually");
    expect(previewFrame).toContain("private pendingReloadViewport:");
    expect(previewFrame).toContain("retainMountedLivePreview(identity: string, sessionKey: string)");
    expect(bindings).toContain(
      'document.getElementById("preview-recompile-btn")?.addEventListener("click", () => void actions.recompilePreview())',
    );
  });
});
