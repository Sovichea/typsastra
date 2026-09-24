import { describe, expect, test } from "bun:test";

describe("preview source navigation controller", () => {
  test("owns inverse sync, forward sync, and preview click routing through typed dependencies", async () => {
    const source = await Bun.file(
      new URL("../src/preview/previewSourceNavigationController.ts", import.meta.url),
    ).text();

    expect(source).toContain("export interface PreviewSourceNavigationDependencies");
    expect(source).toContain("public async handleInverseSync(");
    expect(source).toContain("public async forwardSyncTarget(");
    expect(source).toContain("public async handlePdfPreviewClick(");
    expect(source).toContain("private async applyInverseSyncSelection(");
    expect(source).not.toContain(": any");
    expect(source).not.toContain("host: object");
    expect(source).not.toContain("new Proxy(");
  });

  test("keeps existing appController method names as narrow delegates", async () => {
    const source = await Bun.file(new URL("../src/appController.ts", import.meta.url)).text();

    expect(source).toContain("new PreviewSourceNavigationController({");
    expect(source).toContain("return this.previewSourceNavigationController.handleInverseSync(uri, position);");
    expect(source).toContain("return this.previewSourceNavigationController.forwardSyncTarget(path, cursor);");
    expect(source).toContain("return this.previewSourceNavigationController.handlePdfPreviewClick(point);");
  });

  test("does not forward-sync the preview after an inverse-sync click", async () => {
    const source = await Bun.file(new URL("../src/appController.ts", import.meta.url)).text();
    const start = source.indexOf("handlePreviewSourceLocation: (line, column)");
    expect(start).toBeGreaterThan(-1);
    const handler = source.slice(start, start + 700);

    // Clicking the live preview jumps the editor (inverse sync) and must not
    // forward-sync back into the preview, which made the page jump.
    expect(handler).toContain("suppressOnce()");
    expect(handler).not.toContain("renderAtCursor");
    expect(handler).toContain("this.inverseSyncSelectionInProgress = true;");
  });

  test("flags the inverse-sync selection so the outline does not scroll the PDF", async () => {
    const source = await Bun.file(
      new URL("../src/preview/previewSourceNavigationController.ts", import.meta.url),
    ).text();

    const start = source.indexOf("private async applyInverseSyncSelection(");
    expect(start).toBeGreaterThan(-1);
    const body = source.slice(start, start + 700);
    expect(body).toContain("this.deps.setInverseSyncSelection(true);");
    expect(body).toContain("this.deps.setInverseSyncSelection(false);");
  });

  test("derives the render-cache relative path with the shared helper", async () => {
    const source = await Bun.file(
      new URL("../src/preview/previewSourceNavigationController.ts", import.meta.url),
    ).text();

    // Ctrl+click (LSP URI) paths use forward slashes and may differ in case
    // from the workspace root, so forward sync must not use a raw startsWith.
    expect(source).toContain("relativeFilePath(workspaceRootPath, path)");
    expect(source).not.toContain("path.startsWith(workspaceRootPath)");
  });

  test("resolves LSP navigation to native path identity without raw startsWith", async () => {
    const source = await Bun.file(
      new URL("../src/navigation/sourceLocationController.ts", import.meta.url),
    ).text();

    expect(source).toContain("nativeFilePath(mappedPath)");
    expect(source).toContain("relativeFilePath(workspaceRootPath, filePath)");
    expect(source).not.toContain("filePath.startsWith(workspaceRootPath)");
  });
});
