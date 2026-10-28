import { describe, expect, test } from "bun:test";

describe("editor overview scroll markers", () => {
  test("navigate by exact document ranges instead of scrollbar ratios", async () => {
    const source = await Bun.file(
      new URL("../src/editor/editorController.ts", import.meta.url),
    ).text();

    expect(source).toContain("type ScrollMarkerTarget");
    expect(source).toContain("private matchMarkerTargets = new Map");
    expect(source).toContain('pointerEvents: "auto"');
    expect(source).toContain("this.navigateToScrollMarker(target)");
    expect(source).toContain('EditorView.scrollIntoView(from, { y: "center", yMargin: 24 })');
    expect(source).toContain("unfoldEffect.of({ from: foldFrom, to: foldTo })");
  });

  test("remeasures and corrects long-document navigation after layout", async () => {
    const source = await Bun.file(
      new URL("../src/editor/editorController.ts", import.meta.url),
    ).text();

    expect(source).toContain("private ensureScrollMarkerVisible(");
    expect(source).toContain("editor.requestMeasure({");
    expect(source).toContain("editor.coordsAtPos(position)");
    expect(source).toContain("attempt >= 2");
    expect(source).toContain("this.ensureScrollMarkerVisible(editor, doc, position, attempt + 1)");
  });

  test("uses an informational blue marker for ordinary image warnings", async () => {
    const source = await Bun.file(
      new URL("../src/editor/editorController.ts", import.meta.url),
    ).text();

    expect(source).toContain('marker instanceof ImageOptimizationMarker && marker.severity === "info"');
    expect(source).toContain('? "info"');
    expect(source).toContain('severity === "warning" ? "#cca700" : "#3794ff"');
  });
});
