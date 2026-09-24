import { describe, expect, test } from "bun:test";
import { clampEditorPreviewSplitPct } from "../src/layout/layoutController";

describe("preview dock layout", () => {
  test("keeps the docked split separate from the temporary undocked width", async () => {
    const layout = await Bun.file(new URL("../src/layout/layoutController.ts", import.meta.url)).text();
    const app = await Bun.file(new URL("../src/appController.ts", import.meta.url)).text();
    const lifecycle = await Bun.file(
      new URL("../src/workspace/workspaceLifecycleController.ts", import.meta.url),
    ).text();

    expect(layout).toContain("private dockedInputWidthPct = 50");
    expect(layout).toContain("this.captureDockedPaneSize();");
    expect(layout).toContain("this.previewUndocked = true;");
    expect(layout).toContain("previewWrapper.style.display = \"none\";");
    expect(layout).toContain("input.style.width = `${this.dockedInputWidthPct}%`");
    expect(layout).toContain("previewWrapper.style.width = `${100 - this.dockedInputWidthPct}%`");
    expect(app).toContain("inputContainerWidthPct: this.layoutController.getDockedInputWidthPct()");
    expect(lifecycle).toContain("app.layoutController.setDockedInputWidthPct(state.layout.inputContainerWidthPct)");
  });

  test("does not auto-dock an intentionally undocked preview when the editor is shown", async () => {
    const layout = await Bun.file(new URL("../src/layout/layoutController.ts", import.meta.url)).text();
    const workspace = await Bun.file(
      new URL("../src/workspace/workspaceController.ts", import.meta.url),
    ).text();
    const app = await Bun.file(new URL("../src/appController.ts", import.meta.url)).text();

    // Showing the editor only ensures the docked layout; it must not close the
    // undocked preview window (inverse sync activates a tab and would dock it).
    expect(layout).toContain("public ensureDockedPreviewVisible(): void {");
    expect(layout).toContain("if (this.previewUndocked) return;");
    expect(layout).toContain("private applyDockedPreviewLayout(): void {");
    expect(workspace).toContain("this.port.ensureDockedPreviewVisible();");
    expect(workspace).not.toContain("this.port.dockPreview();");
    expect(app).toContain("ensureDockedPreviewVisible: () => this.layoutController.ensureDockedPreviewVisible()");
  });

  test("stops shrinking once the essential preview toolbar controls are packed", () => {
    expect(clampEditorPreviewSplitPct(80, 1000, 420)).toBe(58);
    expect(clampEditorPreviewSplitPct(40, 1000, 420)).toBe(40);
    expect(clampEditorPreviewSplitPct(58, 750, 420)).toBeCloseTo(44);
    expect(clampEditorPreviewSplitPct(95, 1000, 1200)).toBe(10);
    expect(clampEditorPreviewSplitPct(95, 0, 420)).toBe(90);
  });

  test("reconciles the split after the project sidebar changes the available width", async () => {
    const layout = await Bun.file(new URL("../src/layout/layoutController.ts", import.meta.url)).text();
    const app = await Bun.file(new URL("../src/appController.ts", import.meta.url)).text();

    expect(layout).toContain("public reconcileDockedPaneWidths(): void");
    expect(layout).toContain("this.minimumPreviewToolbarWidth()");
    expect(app).toContain("this.layoutController.reconcileDockedPaneWidths()");
  });

  test("transfers the active PDF viewport between docked and undocked frames", async () => {
    const app = await Bun.file(new URL("../src/appController.ts", import.meta.url)).text();
    const layout = await Bun.file(new URL("../src/layout/layoutController.ts", import.meta.url)).text();
    const bindings = await Bun.file(new URL("../src/ui/appEventBindings.ts", import.meta.url)).text();
    const previewFrame = await Bun.file(
      new URL("../src/preview/previewFrame.ts", import.meta.url),
    ).text();
    const previewWindow = await Bun.file(
      new URL("../src/preview/previewWindowController.ts", import.meta.url),
    ).text();

    const captureIndex = layout.indexOf("this.onPreviewUndocking();");
    expect(captureIndex).toBeGreaterThan(-1);
    expect(layout.indexOf('previewWrapper.style.display = "none";', captureIndex)).toBeGreaterThan(
      captureIndex,
    );
    expect(app).toContain("this.previewViewportAnchor = this.previewFrame.currentViewportAnchor");
    expect(app).toContain("viewportAnchor: this.previewViewportAnchor ?? this.previewFrame.currentViewportAnchor");
    expect(app).toContain("this.restoreUndockedPreviewScrollPosition(position)");
    expect(app).toContain("position.sessionKey !== expectedSessionKey");
    expect(app).toContain("this.previewFrame.queueViewportAnchor(position.viewportAnchor)");
    expect(app).toContain("this.previewFrame.queueTabScrollPosition(position.scrollTop)");
    expect(previewFrame).toContain("this.restoreScrollAnchor(restoredViewportAnchor, true)");
    expect(bindings).toContain('listenEvent<PreviewScrollPositionPayload>("preview-scroll-position-changed"');
    expect(previewWindow).toContain("deps.previewFrame.queueViewportAnchor(update.viewportAnchor)");
    expect(previewWindow).toContain("deps.previewFrame.queueTabScrollPosition(update.scrollTop)");
    expect(previewWindow).toContain("viewportAnchor: this.deps.previewFrame.currentViewportAnchor");
    expect(previewWindow).toContain('emit("preview-scroll-position-changed"');
  });

  test("applies the active preview colors before an undocked PDF is loaded", async () => {
    const app = await Bun.file(new URL("../src/appController.ts", import.meta.url)).text();
    const renderer = await Bun.file(
      new URL("../src/preview/pdfPreviewRenderController.ts", import.meta.url),
    ).text();
    const previewWindow = await Bun.file(
      new URL("../src/preview/previewWindowController.ts", import.meta.url),
    ).text();

    expect(app).toContain("previewColorMode: this.settingsController.value.preview.colorMode");
    expect(renderer).toContain("previewColorMode: this.deps.previewFrame.colorMode");
    expect(previewWindow).toContain("deps.previewFrame.setColorMode(deps.previewColorMode())");
    const colorIndex = previewWindow.indexOf("deps.previewFrame.setColorMode(update.previewColorMode)");
    expect(colorIndex).toBeGreaterThan(-1);
    expect(previewWindow.indexOf("deps.loadPdfPath(", colorIndex)).toBeGreaterThan(colorIndex);
  });
});
