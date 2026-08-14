import { describe, expect, test } from "bun:test";

describe("cross-platform scrollbar design", () => {
  test("styles application scrollbars while preserving the hidden tab strip", async () => {
    const css = await Bun.file(new URL("../src/style.css", import.meta.url)).text();
    expect(css).toContain("--ui-scrollbar-thumb");
    expect(css).toContain("--ui-scrollbar-track: transparent");
    expect(css).toContain("*::-webkit-scrollbar");
    expect(css).toContain("border-radius: 0");
    expect(css).toContain("@supports not selector(::-webkit-scrollbar)");
    expect(css).toContain("scrollbar-color: var(--ui-scrollbar-thumb) var(--ui-scrollbar-track)");
    expect(css).toContain(".editor-tab-bar::-webkit-scrollbar");
    expect(css).toContain("scrollbar-width: none");
  });

  test("applies matching custom geometry inside the isolated PDF iframe", async () => {
    const source = await Bun.file(new URL("../src/preview/previewFrame.ts", import.meta.url)).text();
    expect(source).toMatch(/body::\-webkit-scrollbar\{width:\d+px;height:\d+px\}/);
    expect(source).not.toContain("*::-webkit-scrollbar");
    expect(source).toContain("@supports not selector(::-webkit-scrollbar)");
    expect(source).toContain("scrollbar-color:var(--scrollbar-thumb) var(--scrollbar-track)");
    expect(source).toContain("border-radius:0");
    expect(source).toContain('copy("--ui-accent-color", "--preview-ui-accent"');
    expect(source).toContain("var(--preview-ui-accent)");
  });

  test("distinguishes live preview from directly opened PDF surfaces", async () => {
    const source = await Bun.file(new URL("../src/preview/previewFrame.ts", import.meta.url)).text();
    const controller = await Bun.file(
      new URL("../src/preview/pdfPreviewRenderController.ts", import.meta.url),
    ).text();
    const contextMenu = await Bun.file(
      new URL("../src/components/contextMenuController.ts", import.meta.url),
    ).text();
    expect(source).toContain('export type PreviewSurface = "live" | "pdf"');
    expect(source).toContain('iframeDoc.documentElement.dataset.previewSurface = surface');
    expect(source).toContain(':root[data-preview-surface="pdf"]{--preview-surface-bg:#b8b8b8}');
    expect(source).toContain('background:var(--preview-surface-bg)');
    expect(controller).toContain('surface: PreviewSurface = isTypstDocumentPath(identity) ? "live" : "pdf"');
    expect(controller).toContain(
      'this.deps.previewFrame.loadPdfBytes(bytes, identity, sessionKey, surface)',
    );
    expect(contextMenu).toContain("isTypstDocumentPath(this.dependencies.getActiveFile()");
  });

  test("supports persistent document, dark, and inverted preview colors", async () => {
    const frame = await Bun.file(new URL("../src/preview/previewFrame.ts", import.meta.url)).text();
    const menu = await Bun.file(
      new URL("../src/components/contextMenuController.ts", import.meta.url),
    ).text();
    const settingsUi = await Bun.file(new URL("../index.html", import.meta.url)).text();
    expect(frame).toContain('root.dataset.previewColorMode = this.previewColorMode');
    expect(frame).toContain('data-preview-color-mode="dark"');
    expect(frame).toContain('data-preview-color-mode="inverted"');
    expect(frame).toContain("recordImages: true");
    expect(frame).toContain("task.imageCoordinates ?? page.imageCoordinates");
    expect(frame).toContain('darkCanvas.className = "pdf-page-canvas pdf-page-canvas-dark"');
    expect(frame).toContain("applyDarkPreviewPixels(darkPixels.data)");
    expect(frame).toContain('context.drawImage(original, 0, 0)');
    expect(menu).toContain('colorItem("document", "Document colors")');
    expect(menu).toContain('colorItem("dark", "Dark preview")');
    expect(menu).toContain('colorItem("inverted", "Inverted preview (experimental)")');
    expect(settingsUi).toContain('id="settings-preview-color-mode"');
  });

  test("does not build an unused PDF text layer", async () => {
    const source = await Bun.file(new URL("../src/preview/previewFrame.ts", import.meta.url)).text();
    expect(source).not.toContain("renderTextLayer");
    expect(source).not.toContain('className = "textLayer"');
    expect(source).toContain("hydratePageDimensions");
  });

  test("uses immediate programmatic page jumps and reports the visible page", async () => {
    const source = await Bun.file(new URL("../src/preview/previewFrame.ts", import.meta.url)).text();
    expect(source).toContain('behavior: "auto"');
    expect(source).not.toContain('behavior: "smooth"');
    expect(source).toContain("finishInstantPageJump");
    expect(source).toContain("reportPageStatus");
  });

  test("restores the raw preview scroll offset across PDF recompilation", async () => {
    const source = await Bun.file(new URL("../src/preview/previewFrame.ts", import.meta.url)).text();
    const loadStart = source.indexOf("public async loadPdfBytes");
    const loadEnd = source.indexOf("private async pdfJs", loadStart);
    const loadPdf = source.slice(loadStart, loadEnd);
    expect(loadPdf).toContain(": this.captureScrollPosition()");
    expect(loadPdf).toContain("this.restoreScrollPosition(previousScrollTop)");
    expect(loadPdf).not.toContain("const previousScroll = this.captureScrollAnchor()");
    expect(source).toContain("const restoredTop = Math.min(Math.max(0, scrollTop), maximum)");
  });

  test("restores the workspace preview offset on the first PDF presentation", async () => {
    const source = await Bun.file(new URL("../src/preview/previewFrame.ts", import.meta.url)).text();
    const controller = await Bun.file(new URL("../src/appController.ts", import.meta.url)).text();
    const lifecycle = await Bun.file(
      new URL("../src/workspace/workspaceLifecycleController.ts", import.meta.url),
    ).text();
    expect(source).toContain("restoreWorkspaceScrollPosition(scrollTop: number)");
    expect(source).toContain("this.pendingRestoredScrollTop");
    expect(lifecycle).toContain("app.previewFrame.restoreWorkspaceScrollPosition(state.previewScrollTop)");
    expect(controller).toContain("previewScrollTop: this.previewScrollTop");
  });

  test("shares a preview offset between tabs in the same preview session", async () => {
    const source = await Bun.file(new URL("../src/preview/previewFrame.ts", import.meta.url)).text();
    const controller = await Bun.file(new URL("../src/appController.ts", import.meta.url)).text();
    const activation = await Bun.file(
      new URL("../src/editor/editorTabActivationController.ts", import.meta.url),
    ).text();
    expect(controller).toContain("const previewOwnerPath = activeTab?.previewMainPath");
    expect(controller).toContain("filePathKey(tabOwnerPath) === ownerKey");
    expect(controller).toContain("previewScrollTopForTab: tab => {");
    expect(activation).toContain("deps.queuePreviewScrollPosition(deps.previewScrollTopForTab(tab))");
    expect(source).toContain("queueTabScrollPosition(scrollTop?: number)");
    expect(source).toContain("const restoringSavedPosition = this.pendingRestoredScrollTop !== null");
  });

  test("provides an accessible floating control to return to the first page", async () => {
    const source = await Bun.file(new URL("../src/preview/previewFrame.ts", import.meta.url)).text();
    expect(source).toContain('id="preview-go-first"');
    expect(source).toContain('aria-label="Go to first page"');
    expect(source).toContain("this.jumpToPreviewOffset(0, 1)");
    expect(source).toContain("this.updateGoToFirstPageButton()");
    expect(source).toContain('target?.closest("#preview-go-first")');
  });

  test("reveals and distinguishes actionable preview links while Ctrl is held inside the preview", async () => {
    const source = await Bun.file(new URL("../src/preview/previewFrame.ts", import.meta.url)).text();
    expect(source).toContain('target.kind === "external"');
    expect(source).toContain('"external-link"');
    expect(source).toContain('"internal-reference"');
    expect(source).toContain(".preview-link-modifier .annotation-link.internal-reference");
    expect(source).toContain(".preview-link-modifier .annotation-link.external-link");
    expect(source).toContain("box-shadow:inset 3px 0");
    expect(source).toContain("outline:2px dashed");
    expect(source).toContain("this.previewPointerInside && this.previewLinkModifierHeld");
    expect(source).toContain("this.setPreviewLinkModifier(doc, this.previewLinkModifierHeld)");
    expect(source).toContain("this.previewPointerInside = false");
    expect(source).toContain("Math.min(rect[0], rect[2]) - 3");
    expect(source).toContain("Math.max(rect[0], rect[2]) + 3");
  });

  test("provides editable page navigation in the shared preview toolbar", async () => {
    const html = await Bun.file(new URL("../index.html", import.meta.url)).text();
    expect(html).toContain('id="preview-page-input"');
    expect(html).toContain('id="preview-page-count"');
    expect(html).toContain('role="spinbutton"');
  });

  test("preserves a compiled PDF behind non-Typst preview messages", async () => {
    const source = await Bun.file(new URL("../src/preview/previewFrame.ts", import.meta.url)).text();
    const presentation = await Bun.file(
      new URL("../src/editor/editorTabPresentationController.ts", import.meta.url),
    ).text();
    const activation = await Bun.file(
      new URL("../src/editor/editorPreviewActivationController.ts", import.meta.url),
    ).text();
    expect(source).toContain("setMessageOverlay(html: string)");
    expect(source).toContain("this.mountedSessionKey !== sessionKey");
    expect(source).toContain("this.clearMessageHost();");
    expect(presentation).toContain("this.deps.previewFrame().setMessageOverlay(");
    expect(activation).toContain("presentationReused = this.deps.previewFrame().activateSession(tab.previewSessionKey)");
  });
});
