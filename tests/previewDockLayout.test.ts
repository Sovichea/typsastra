import { describe, expect, test } from "bun:test";
import { clampEditorPreviewSplitPct } from "../src/layout/layoutController";

describe("preview dock layout", () => {
  test("keeps the docked split separate from the temporary undocked width", async () => {
    const layout = await Bun.file(new URL("../src/layout/layoutController.ts", import.meta.url)).text();
    const app = await Bun.file(new URL("../src/appController.ts", import.meta.url)).text();

    expect(layout).toContain("private dockedInputWidthPct = 50");
    expect(layout).toContain("this.captureDockedPaneSize();\n      this.previewUndocked = true;\n      previewWrapper.style.display = \"none\"");
    expect(layout).toContain("input.style.width = `${this.dockedInputWidthPct}%`");
    expect(layout).toContain("previewWrapper.style.width = `${100 - this.dockedInputWidthPct}%`");
    expect(app).toContain("inputContainerWidthPct: this.layoutController.getDockedInputWidthPct()");
    expect(app).toContain("this.layoutController.setDockedInputWidthPct(state.layout.inputContainerWidthPct)");
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
});
