import { describe, expect, test } from "bun:test";

describe("compiled PDF transport", () => {
  test("exports previews to a private cache instead of returning Base64 through LSP", async () => {
    const source = await Bun.file(new URL("../src/compiler/lsp.ts", import.meta.url)).text();
    expect(source).toContain('$root/.typsastra/cache/preview/$dir/$name');
    expect(source).toContain("outputPath: PREVIEW_OUTPUT_PATH");
    expect(source).toContain("arguments: [path, {}, { write: true, open: false }]");
    expect(source).not.toContain("exportPdfToMemory");
  });

  test("loads compiled previews through raw binary IPC without retaining Base64", async () => {
    const source = await Bun.file(new URL("../src/appController.ts", import.meta.url)).text();
    expect(source).toContain('invoke<ArrayBuffer | Uint8Array | number[]>("read_binary_file"');
    expect(source).not.toContain("lastPdfBase64");
    expect(source).not.toContain("exportBase64Chars");
  });

  test("registers generated preview PDFs before Tinymist writes them", async () => {
    const source = await Bun.file(new URL("../src/appController.ts", import.meta.url)).text();
    const registration = source.indexOf("this.managedPreviewPdfPathKeys.add(anticipatedPdfPathKey)");
    const exportRequest = source.indexOf("await this.lspClient.exportPdfToFile(previewPath)");
    expect(registration).toBeGreaterThan(-1);
    expect(exportRequest).toBeGreaterThan(registration);
    expect(source).toContain("excludeManagedWorkspacePaths(");
  });

  test("uses the private render mirror for on-save and on-type previews", async () => {
    const source = await Bun.file(new URL("../src/appController.ts", import.meta.url)).text();
    expect(source).toContain("Every live preview compiles from Typsastra's private render mirror.");
    expect(source).not.toContain('const shouldMirror = this.settingsController.value.preview.renderMode === "on-type"');
    expect(source).not.toContain("if (!shouldMirror || !this.workspaceRootPath)");
  });

  test("requires explicit confirmation before writing a user-facing PDF", async () => {
    const source = await Bun.file(new URL("../src/appController.ts", import.meta.url)).text();
    const confirmation = source.indexOf('title: outputExists ? "Replace Exported PDF?" : "Export PDF?"');
    const workspaceCopy = source.indexOf('invoke("copy_workspace_file", { source: pdfPath, dest: originalPdfPath })');
    expect(confirmation).toBeGreaterThan(-1);
    expect(workspaceCopy).toBeGreaterThan(confirmation);
    expect(source).toContain('if (exportAction !== "export")');
  });
});
