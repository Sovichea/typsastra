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
    const pinnedMainSource = await Bun.file(
      new URL("../src/workspace/pinnedMainFileController.ts", import.meta.url),
    ).text();
    const lifecycle = await Bun.file(
      new URL("../src/workspace/workspaceLifecycleController.ts", import.meta.url),
    ).text();
    const sessionSource = await Bun.file(
      new URL("../src/session/documentSessionController.ts", import.meta.url),
    ).text();
    const typographySource = await Bun.file(
      new URL("../src/typography/typographyController.ts", import.meta.url),
    ).text();
    const typographyApplicationSource = await Bun.file(
      new URL("../src/typography/documentTypographyApplicationController.ts", import.meta.url),
    ).text();

    expect(pinnedMainSource).toContain("if (mainChanged && previewApproved)");
    expect(pinnedMainSource).toContain("if (deps.hasLspClient())");
    expect(pinnedMainSource).toContain("if (deps.isLowMemoryMode())");
    expect(pinnedMainSource).toContain("await deps.refreshActivePreviewRoot(true)");
    expect(pinnedMainSource).toContain("await deps.prepareTypography(path)");
    expect(typographySource).toContain("scaled_workspace_font_set_status");
    expect(typographySource).toContain("activate_scaled_workspace_fonts");
    expect(typographySource).toContain("this.port.synchronizeDocumentTypography(config)");
    expect(typographyApplicationSource).toContain("ownsWorkspaceTypography && !await typography.confirmScaleRange(config)");
    expect(typographySource).toContain("if (!this.port.isPinnedMainFile(activeFilePath))");
    expect(pinnedMainSource.indexOf("await deps.prepareTypography(path)")).toBeLessThan(
      pinnedMainSource.indexOf("deps.setPinnedMainFilePath(path)")
    );
    expect(pinnedMainSource).toContain('deps.restartTinymistSession("Restarting Tinymist for the new main file...")');
    expect(lifecycle).toContain('stopTinymistSession("Project closed")');
    expect(sessionSource).toContain("private lifecycleQueue: Promise<void>");
    expect(sessionSource).toContain("runExclusive(operation: () => Promise<void>)");
    expect(pinnedMainSource).toContain("deps.clearBlockedLargePreviewRoot()");
    expect(pinnedMainSource).toContain("await deps.largePreviewNoticeForRoot(path)");
    expect(pinnedMainSource).toContain("deps.setWorkspaceServicesDeferred(true)");
    expect(pinnedMainSource).toContain('deps.stopTinymistSession("Large Typst file waiting for editor approval")');
    const lspSyncSource = await Bun.file(
      new URL("../src/session/lspSyncController.ts", import.meta.url),
    ).text();
    expect(source).toContain("private restoreActiveDocumentAfterTinymistRestart");
    expect(source).toContain("return this.lspSyncController.restoreActiveDocumentAfterRestart(forcePreview)");
    expect(lspSyncSource).toContain("async restoreActiveDocumentAfterRestart(forcePreview = true)");
    expect(lspSyncSource).toContain("await this.deps.updatePinnedMain(mainPath, true)");
    expect(pinnedMainSource).toContain("if (mainChanged && (!path || mainWasAlreadyActive))");
    expect(pinnedMainSource).toContain("await deps.restoreActiveDocumentAfterRestart(mainWasAlreadyActive)");
  });

  test("continues opening a replacement after late teardown cleanup fails", async () => {
    const lifecycle = await Bun.file(
      new URL("../src/workspace/workspaceLifecycleController.ts", import.meta.url),
    ).text();

    expect(lifecycle).toContain("const previousWorkspace = app.workspaceRootPath;");
    expect(lifecycle).toContain("if (app.workspaceRootPath !== null) throw error;");
    expect(lifecycle).toContain("continuing with ${selected}");
    expect(lifecycle.indexOf("app.workspaceLoading = true;")).toBeGreaterThan(
      lifecycle.indexOf("if (app.workspaceRootPath !== null) throw error;"),
    );
  });

  test("reloads template typography and synchronizes restored directives", async () => {
    const activationSource = await Bun.file(
      new URL("../src/editor/editorTabActivationController.ts", import.meta.url),
    ).text();
    const typographySource = await Bun.file(
      new URL("../src/typography/typographyController.ts", import.meta.url),
    ).text();
    const presentationSource = await Bun.file(
      new URL("../src/editor/editorTabPresentationController.ts", import.meta.url),
    ).text();
    expect(typographySource).toContain("public async reloadTemplateContext");
    expect(typographySource).toContain('this.port.restartTinymistSession("Reloading template typography...")');
    const presentation = presentationSource.indexOf("presentText(tab: EditorTab, path: string)");
    const tabDispatch = presentationSource.indexOf("editor.dispatch({", presentation);
    const activation = activationSource.indexOf("async activate(");
    const presentText = activationSource.indexOf("deps.presentation.presentText(tab, path)", activation);
    const activeTabCommit = activationSource.indexOf("deps.setActiveFilePath(path)", presentText);
    const typographyResolve = activationSource.indexOf(
      "await deps.typography.effective(path, tab.content)",
      activeTabCommit,
    );
    const typographySync = activationSource.indexOf(
      "deps.toolbar.synchronizeDocumentTypography(activeTypography)",
      typographyResolve,
    );
    expect(tabDispatch).toBeGreaterThan(presentation);
    expect(presentText).toBeGreaterThan(activation);
    expect(activeTabCommit).toBeGreaterThan(presentText);
    expect(activeTabCommit).toBeLessThan(typographyResolve);
    expect(typographySync).toBeGreaterThan(typographyResolve);
  });

  test("keeps imported template ownership while reusing the main preview session", async () => {
    const source = await Bun.file(
      new URL("../src/preview/previewSessionController.ts", import.meta.url),
    ).text();
    const capture = source.indexOf("captureCurrentMainSessionForImportedTarget");
    const nextMethod = source.indexOf("\n  applySessionToTab", capture + 10);
    const method = source.slice(capture, nextMethod);
    expect(method).toContain("previewImported: target.imported");
    expect(method).toContain("previewStandalone: target.standalone");
    expect(method).toContain("previewDisabled: target.disabled");
  });

  test("uses one cached compiler root for on-save and on-type sessions", async () => {
    const source = await Bun.file(new URL("../src/appController.ts", import.meta.url)).text();
    const normalizedSource = source.replace(/\r\n/g, "\n");
    const preparationSource = await Bun.file(
      new URL("../src/preview/pdfPreviewPreparationController.ts", import.meta.url),
    ).text();
    const contentSource = await Bun.file(
      new URL("../src/preview/previewContentController.ts", import.meta.url),
    ).text();
    const lifecycleSource = await Bun.file(
      new URL("../src/workspace/workspaceLifecycleController.ts", import.meta.url),
    ).text();
    const preparation = preparationSource.indexOf("public async prepareProjectIfNeeded");
    const preparationEnd = preparationSource.indexOf("\n  public ", preparation + 10);
    const method = preparationSource.slice(preparation, preparationEnd);
    expect(method).toContain("const pinnedMainFilePath = this.deps.getPinnedMainFilePath()");
    expect(method).toContain("entryFile = this.deps.mapToOriginalPath(pinnedMainFilePath)");
    expect(method).not.toContain('renderMode !== "on-type"');
    expect(contentSource).toContain("await this.deps.updatePinnedMain(previewLspMainPath(target))");
    expect(source).not.toContain("cachedPreviewCompilerPath");
    const normalizedLifecycleSource = lifecycleSource.replace(/\r\n/g, "\n");
    expect(normalizedLifecycleSource).toContain("await app.prepareRenderProjectIfNeeded();");
    expect(normalizedLifecycleSource).toContain("await app.restartTinymistSession(\"Connecting to new project...\")");
  });

  test("corrects unsupported compiler-font scales after reporting them", async () => {
    const source = await Bun.file(new URL("../src/appController.ts", import.meta.url)).text();
    const typographySource = await Bun.file(
      new URL("../src/typography/typographyController.ts", import.meta.url),
    ).text();
    expect(typographySource).toContain('this.port.dispatchDocumentEdit(edit, "input.typography-scale-correction")');
    expect(typographySource).toContain("this.resetUnsupportedInternalScales");
    expect(typographySource).toContain("Typsastra will reset their scale to 1×");
  });

  test("clears logs at user-requested lifecycle boundaries", async () => {
    const source = await Bun.file(new URL("../src/appController.ts", import.meta.url)).text();
    const eventBindings = await Bun.file(
      new URL("../src/ui/appEventBindings.ts", import.meta.url),
    ).text();
    const lifecycle = await Bun.file(
      new URL("../src/workspace/workspaceLifecycleController.ts", import.meta.url),
    ).text();
    const closeProject = lifecycle.indexOf("async close(");
    const closePreview = lifecycle.indexOf("app.previewFrame.clear();", closeProject);
    const closeSave = lifecycle.indexOf("await app.saveWorkspaceState();", closeProject);
    const closeClear = lifecycle.indexOf("app.logConsoleController.clearAllLogs();", closeProject);
    const closeConsole = lifecycle.indexOf("app.logConsoleController.setVisible(false);", closeProject);
    const manualRestart = eventBindings.indexOf('document.getElementById("action-restart-lsp")');
    const restartBinding = eventBindings.indexOf("actions.restartLsp()", manualRestart);
    const restartStart = source.indexOf("restartLsp: async () => {");
    const restartClear = source.indexOf("this.logConsoleController.clearAllLogs();", restartStart);
    const restartCall = source.indexOf('restartTinymistSession("Restarting LSP..."', restartStart);
    const restartRestore = source.indexOf(
      "await this.restoreActiveDocumentAfterTinymistRestart();",
      restartCall
    );
    const restartEnd = source.indexOf("},", restartRestore);
    expect(closePreview).toBeGreaterThan(closeProject);
    expect(closePreview).toBeLessThan(closeSave);
    expect(closeClear).toBeGreaterThan(closeProject);
    expect(closeConsole).toBeGreaterThan(closeClear);
    expect(closeConsole).toBeGreaterThan(closeProject);
    expect(lifecycle).toContain("app.lspDocumentController.resetSessionState();");
    expect(lifecycle).not.toContain("app.openedDocumentUris.clear();");
    expect(manualRestart).toBeGreaterThan(-1);
    expect(restartBinding).toBeGreaterThan(manualRestart);
    expect(restartClear).toBeGreaterThan(restartStart);
    expect(restartClear).toBeLessThan(restartCall);
    expect(restartRestore).toBeGreaterThan(restartCall);
    expect(restartEnd).toBeGreaterThan(restartRestore);
    expect(source.slice(restartStart, restartEnd)).not.toContain("activateEditorTab");
  });

  test("restarts and requeues a preview interrupted by an unexpected Tinymist stop", async () => {
    const source = await Bun.file(new URL("../src/appController.ts", import.meta.url)).text();
    const clientSource = await Bun.file(new URL("../src/compiler/lsp.ts", import.meta.url)).text();
    const renderSource = await Bun.file(
      new URL("../src/preview/pdfPreviewRenderController.ts", import.meta.url),
    ).text();
    const sourceMapSource = await Bun.file(
      new URL("../src/preview/sourceMapSessionController.ts", import.meta.url),
    ).text();
    const previewSyncSource = await Bun.file(
      new URL("../src/preview/previewSyncController.ts", import.meta.url),
    ).text();

    expect(isTinymistStoppedRequestError(
      new Error("Tinymist stopped before the LSP request completed.")
    )).toBe(true);
    expect(isTinymistStoppedRequestError(new Error("Typst compilation failed."))).toBe(false);
    const recoverySource = await Bun.file(
      new URL("../src/preview/tinymistPreviewRecoveryController.ts", import.meta.url),
    ).text();
    expect(source).toContain("private recoverTinymistPreviewAfterUnexpectedStop");
    expect(recoverySource).toContain("this.attempts >= 1");
    expect(recoverySource).toContain('this.dependencies.restartTinymistSession("Recovering interrupted preview...")');
    expect(recoverySource).toContain("await this.dependencies.restoreActiveDocumentAfterRestart()");
    expect(recoverySource).toContain("this.dependencies.queueRecovery(contents)");
    expect(renderSource).toContain("this.queuedContents ??= contents");
    expect(renderSource).toContain("this.queuedForced = true");
    expect(renderSource).toContain("isTinymistStoppedRequestError(error)");
    expect(source).toContain("this.tinymistPreviewRecoveryController.resetAttempts()");
    expect(source).toContain("this.sourceMapSessionController.reset()");
    expect(sourceMapSource).toContain("this.retryKey = null");
    expect(source).toContain("this.previewSyncController.clearWarmup()");
    expect(previewSyncSource).toContain("window.clearTimeout(this.warmupTimer)");
    expect(source).toContain("this.pdfPreviewRenderController.resetSourceMapIdentity()");
    expect(renderSource).toContain("this.sourceMapRootPathValue = null");
    expect(renderSource).toContain("this.sourceMapTaskIdValue = null");
    expect(clientSource).toContain("private clearPreviewEndpoints(): void");
    expect(clientSource).toContain("this.latestPreviewDataPlaneUrl = \"\"");
  });
});
