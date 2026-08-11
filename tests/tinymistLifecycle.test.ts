import { describe, expect, test } from "bun:test";
import { isTinymistStoppedRequestError } from "../src/compiler/lsp";

describe("Tinymist workspace lifecycle", () => {
  test("exposes an explicit native process stop boundary", async () => {
    const nativeSource = await Bun.file(new URL("../src-tauri/src/lib.rs", import.meta.url)).text();
    const transportSource = await Bun.file(new URL("../src/compiler/lspTransport.ts", import.meta.url)).text();
    const clientSource = await Bun.file(new URL("../src/compiler/lsp.ts", import.meta.url)).text();

    expect(nativeSource).toContain("async fn stop_tinymist_lsp");
    expect(nativeSource).toContain("stop_lsp_process(&state).await");
    expect(transportSource).toContain('invoke("stop_tinymist_lsp")');
    expect(clientSource).toContain("public async stop(): Promise<void>");
  });

  test("restarts for main-file changes and stops when a project closes", async () => {
    const source = await Bun.file(new URL("../src/appController.ts", import.meta.url)).text();

    expect(source).toContain("mainChanged && this.lspClient");
    expect(source).toContain("preparePinnedMainTypography(path)");
    expect(source).toContain("scaled_workspace_font_set_status");
    expect(source).toContain("activate_scaled_workspace_fonts");
    expect(source).toContain("synchronizeDocumentTypography(typography)");
    expect(source).toContain('title: "Migrate Legacy Font Scaling?"');
    expect(source).toContain('invoke<{ alias: string }>("prepare_named_workspace_font"');
    expect(source).toContain("if (!this.isPinnedMainFile(filePath))");
    expect(source.indexOf("preparePinnedMainTypography(path)")).toBeLessThan(
      source.indexOf("this.pinnedMainFilePath = path", source.indexOf("preparePinnedMainTypography(path)"))
    );
    expect(source).toContain('restartTinymistSession("Restarting Tinymist for the new main file..."');
    expect(source).toContain('stopTinymistSession("Project closed")');
    expect(source).toContain("tinymistLifecycleQueue");
    const setMainStart = source.indexOf("private async setPinnedMainFile");
    const setMainEnd = source.indexOf("private async closeProject", setMainStart);
    const setMainSource = source.slice(setMainStart, setMainEnd);
    expect(setMainSource).toContain("this.blockedLargePreviewRoot = null");
    expect(setMainSource).toContain("await this.largePreviewNoticeForRoot(path)");
    expect(setMainSource).toContain("this.workspaceServicesDeferredForLargeFile = true");
    expect(setMainSource).toContain('stopTinymistSession("Large Typst file waiting for editor approval")');
    expect(source).toContain("private async restoreActiveDocumentAfterTinymistRestart");
    expect(source).toContain("if (mainChanged && (!path || mainWasAlreadyActive))");
    expect(source).toContain("await this.restoreActiveDocumentAfterTinymistRestart();");
  });

  test("reloads template typography and synchronizes restored directives", async () => {
    const source = await Bun.file(new URL("../src/appController.ts", import.meta.url)).text();
    expect(source).toContain("private async reloadTemplateTypographyContext");
    expect(source).toContain('restartTinymistSession("Reloading template typography..."');
    const activation = source.indexOf("private async activateEditorTab");
    const tabDispatch = source.indexOf("this.editorInstance.dispatch({", activation);
    const typographySync = source.indexOf(
      "this.editorToolbarController.synchronizeDocumentTypography(activeTypography)",
      tabDispatch,
    );
    const activeTabCommit = source.indexOf("this.activeFilePath = path;", tabDispatch);
    const typographyResolve = source.indexOf("await this.effectiveDocumentTypography(path, tab.content)", tabDispatch);
    expect(tabDispatch).toBeGreaterThan(activation);
    expect(activeTabCommit).toBeGreaterThan(tabDispatch);
    expect(activeTabCommit).toBeLessThan(typographyResolve);
    expect(typographySync).toBeGreaterThan(tabDispatch);
  });

  test("keeps imported template ownership while reusing the main preview session", async () => {
    const source = await Bun.file(new URL("../src/appController.ts", import.meta.url)).text();
    const capture = source.indexOf("private captureCurrentMainSessionForImportedTarget");
    const nextMethod = source.indexOf("\n  private ", capture + 10);
    const method = source.slice(capture, nextMethod);
    expect(method).toContain("previewImported: target.imported");
    expect(method).toContain("previewStandalone: target.standalone");
    expect(method).toContain("previewDisabled: target.disabled");
  });

  test("uses one cached compiler root for on-save and on-type sessions", async () => {
    const source = await Bun.file(new URL("../src/appController.ts", import.meta.url)).text();
    const normalizedSource = source.replace(/\r\n/g, "\n");
    const preparation = source.indexOf("private async prepareRenderProjectIfNeeded");
    const preparationEnd = source.indexOf("\n  private ", preparation + 10);
    const method = source.slice(preparation, preparationEnd);
    expect(method).toContain("this.pinnedMainFilePath");
    expect(method).toContain("entryFile = this.mapToOriginalPath(this.pinnedMainFilePath)");
    expect(method).not.toContain('renderMode !== "on-type"');
    expect(source).toContain("await this.updatePinnedMain(previewLspMainPath(target))");
    expect(source).not.toContain("cachedPreviewCompilerPath");
    expect(normalizedSource).toContain("await this.prepareRenderProjectIfNeeded();\n        await this.restartTinymistSession");
  });

  test("corrects unsupported compiler-font scales after reporting them", async () => {
    const source = await Bun.file(new URL("../src/appController.ts", import.meta.url)).text();
    expect(source).toContain('userEvent: "input.typography-scale-correction"');
    expect(source).toContain("this.resetUnsupportedInternalScales");
    expect(source).toContain("Typsastra will reset their scale to 1×");
  });

  test("clears logs at user-requested lifecycle boundaries", async () => {
    const source = await Bun.file(new URL("../src/appController.ts", import.meta.url)).text();
    const closeProject = source.indexOf("private async closeProject");
    const closeClear = source.indexOf("this.logConsoleController.clearAllLogs();", closeProject);
    const closeConsole = source.indexOf("this.logConsoleController.setVisible(false);", closeProject);
    const manualRestart = source.indexOf('document.getElementById("action-restart-lsp")');
    const restartClear = source.indexOf("this.logConsoleController.clearAllLogs();", manualRestart);
    const restartCall = source.indexOf('restartTinymistSession("Restarting LSP..."', manualRestart);
    const restartRestore = source.indexOf(
      "await this.restoreActiveDocumentAfterTinymistRestart();",
      restartCall
    );
    const nextAction = source.indexOf('document.getElementById("action-docs-typsastra")', restartCall);
    expect(closeClear).toBeGreaterThan(closeProject);
    expect(closeConsole).toBeGreaterThan(closeClear);
    expect(closeConsole).toBeLessThan(manualRestart);
    expect(restartClear).toBeGreaterThan(manualRestart);
    expect(restartClear).toBeLessThan(restartCall);
    expect(restartRestore).toBeGreaterThan(restartCall);
    expect(restartRestore).toBeLessThan(nextAction);
    expect(source.slice(manualRestart, nextAction)).not.toContain("activateEditorTab");
  });

  test("restarts and requeues a preview interrupted by an unexpected Tinymist stop", async () => {
    const source = await Bun.file(new URL("../src/appController.ts", import.meta.url)).text();
    const clientSource = await Bun.file(new URL("../src/compiler/lsp.ts", import.meta.url)).text();

    expect(isTinymistStoppedRequestError(
      new Error("Tinymist stopped before the LSP request completed.")
    )).toBe(true);
    expect(isTinymistStoppedRequestError(new Error("Typst compilation failed."))).toBe(false);
    expect(source).toContain("private recoverTinymistPreviewAfterUnexpectedStop");
    expect(source).toContain("this.tinymistPreviewRecoveryAttempts >= 1");
    expect(source).toContain('restartTinymistSession("Recovering interrupted preview..."');
    expect(source).toContain("await this.restoreActiveDocumentAfterTinymistRestart(false)");
    expect(source).toContain("this.queuedPdfPreviewContents ??= contents");
    expect(source).toContain("this.queuedPdfPreviewForced = true");
    expect(source).toContain("isTinymistStoppedRequestError(error)");
    expect(source).toContain("this.tinymistPreviewRecoveryAttempts = 0");
    expect(source).toContain("this.pdfSourceMapRetryKey = null");
    expect(source).toContain("window.clearTimeout(this.pdfSourceMapWarmupTimer)");
    expect(source).toContain("this.pdfPreviewSourceMapRootPath = null");
    expect(source).toContain("this.pdfPreviewSourceMapTaskId = null");
    expect(clientSource).toContain("private clearPreviewEndpoints(): void");
    expect(clientSource).toContain("this.latestPreviewDataPlaneUrl = \"\"");
  });
});
