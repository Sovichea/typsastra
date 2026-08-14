import { describe, expect, test } from "bun:test";

describe("compiled PDF transport", () => {
  test("exports previews to a private cache instead of returning Base64 through LSP", async () => {
    const source = await Bun.file(new URL("../src/compiler/lsp.ts", import.meta.url)).text();
    expect(source).toContain('$root/.typsastra/cache/preview/$name');
    expect(source).not.toContain('cache/preview/$dir/$name');
    expect(source).toContain("outputPath: PREVIEW_OUTPUT_PATH");
    expect(source).toContain("arguments: [path, {}, { write: true, open: false }]");
    expect(source).not.toContain("exportPdfToMemory");
  });

  test("loads compiled previews through raw binary IPC without retaining Base64", async () => {
    const source = await Bun.file(
      new URL("../src/preview/pdfPreviewRenderController.ts", import.meta.url),
    ).text();
    expect(source).toContain('invoke<ArrayBuffer | Uint8Array | number[]>("read_binary_file"');
    expect(source).not.toContain("lastPdfBase64");
    expect(source).not.toContain("exportBase64Chars");
  });

  test("registers generated preview PDFs before Tinymist writes them", async () => {
    const source = await Bun.file(
      new URL("../src/preview/pdfPreviewRenderController.ts", import.meta.url),
    ).text();
    const workspaceSource = await Bun.file(
      new URL("../src/workspace/externalWorkspaceController.ts", import.meta.url),
    ).text();
    const registration = source.indexOf("this.managedPdfPathKeysValue.add(anticipatedPdfPathKey)");
    const exportRequest = source.indexOf("await this.deps.getLspClient()!.exportPdfToFile(previewPath)");
    expect(registration).toBeGreaterThan(-1);
    expect(exportRequest).toBeGreaterThan(registration);
    expect(source).toContain('const anticipatedPdfPath = `${cacheRoot}/preview/${previewPdfName}`');
    expect(workspaceSource).toContain("excludeManagedWorkspacePaths(");
  });

  test("uses an isolated one-shot compiler without starting the LSP in low memory mode", async () => {
    const renderSource = await Bun.file(
      new URL("../src/preview/pdfPreviewRenderController.ts", import.meta.url),
    ).text();
    const nativeSource = await Bun.file(
      new URL("../src-tauri/src/lib.rs", import.meta.url),
    ).text();
    const lifecycleSource = await Bun.file(
      new URL("../src/workspace/workspaceLifecycleController.ts", import.meta.url),
    ).text();

    expect(renderSource).toContain('invoke<OneShotCompileResult>("compile_tinymist_pdf_once"');
    expect(renderSource).toContain("if (lowMemoryMode)");
    expect(renderSource).toContain("result.diagnostics");
    expect(renderSource).toContain("publishSuccessfulDiagnostics(oneShotDiagnostics)");
    expect(nativeSource).toContain("async fn compile_tinymist_pdf_once(");
    expect(nativeSource).toContain("diagnostics: String::from_utf8_lossy(&result.stderr)");
    expect(nativeSource).toContain('.arg("compile")');
    expect(nativeSource).toContain(".kill_on_drop(true)");
    expect(nativeSource).toContain("input.starts_with(cache_root.join(\"render\"))");
    expect(lifecycleSource).toContain(
      'await app.stopTinymistSession("Low memory mode: using one-shot compiler on save")',
    );
  });

  test("keeps compiler diagnostic markers without the persistent LSP", async () => {
    const failureSource = await Bun.file(
      new URL("../src/diagnostics/previewFailureController.ts", import.meta.url),
    ).text();
    const diagnosticsSource = await Bun.file(
      new URL("../src/diagnostics/diagnosticsController.ts", import.meta.url),
    ).text();

    expect(failureSource).toContain("includePrimaryCompilerDiagnostic()");
    expect(failureSource).toContain('severity: "error"');
    expect(failureSource).toContain('severity = /^error:/i.test(block) ? "error" as const : "warning" as const');
    expect(diagnosticsSource).toContain('severity: entry.severity ?? "related"');
  });

  test("shares the staged PDF generation with the undocked preview", async () => {
    const source = await Bun.file(
      new URL("../src/preview/pdfPreviewRenderController.ts", import.meta.url),
    ).text();
    const staging = source.indexOf('const stagedPdfPath = await invoke<string>("stage_pdf_preview_generation"');
    const update = source.indexOf('emit("pdf-update"', staging);
    const updateEnd = source.indexOf("satisfies PdfUpdatePayload", update);
    const payload = source.slice(update, updateEnd);

    expect(staging).toBeGreaterThan(-1);
    expect(update).toBeGreaterThan(staging);
    expect(payload).toContain("path: stagedPdfPath");
    expect(payload).not.toContain("path: pdfPath");
  });

  test("does not run workspace memory diagnostics from the preview-only window", async () => {
    const source = await Bun.file(new URL("../src/appController.ts", import.meta.url)).text();
    const previewOwner = await Bun.file(
      new URL("../src/preview/previewController.ts", import.meta.url),
    ).text();
    const diagnostics = source.indexOf('return this.performanceController.logMemoryDiagnostics(`PDF ${stage}`, detail);');
    const callback = source.slice(Math.max(0, diagnostics - 220), diagnostics);

    expect(previewOwner).toContain("readonly pdf: PreviewFrame");
    expect(diagnostics).toBeGreaterThan(-1);
    expect(callback).toContain("if (this.previewWindowController.isPreviewOnlyWindow()) return;");
  });

  test("keeps memory diagnostics safe before CodeMirror is initialized", async () => {
    const appSource = await Bun.file(new URL("../src/appController.ts", import.meta.url)).text();
    const controllerSource = await Bun.file(
      new URL("../src/performance/performanceController.ts", import.meta.url),
    ).text();

    expect(appSource).toContain(
      "editorUndoDepth: () => this.editorInstance?.state ? undoDepth(this.editorInstance.state) : 0",
    );
    expect(controllerSource).toContain("this.port.editorUndoDepth()");
    expect(controllerSource).not.toContain("editorInstance");
  });

  test("uses the private render mirror for on-save and on-type previews", async () => {
    const source = await Bun.file(new URL("../src/appController.ts", import.meta.url)).text();
    const preparationSource = await Bun.file(
      new URL("../src/preview/pdfPreviewPreparationController.ts", import.meta.url),
    ).text();
    expect(preparationSource).toContain("Every live preview compiles from Typsastra's private render mirror.");
    expect(source).not.toContain('const shouldMirror = this.settingsController.value.preview.renderMode === "on-type"');
    expect(source).not.toContain("if (!shouldMirror || !this.workspaceRootPath)");
  });

  test("pins the exact prepared revision transiently while exporting in every render mode", async () => {
    const source = await Bun.file(
      new URL("../src/preview/pdfPreviewRenderController.ts", import.meta.url),
    ).text();
    const diagnosticsSource = await Bun.file(
      new URL("../src/diagnostics/diagnosticsController.ts", import.meta.url)
    ).text();
    const renderStart = source.indexOf("public async render(");
    const preparedPaths = source.indexOf("const preparedPaths = [...new Set([", renderStart);
    const legacyClose = source.indexOf("await this.deps.preparation.closePreparedDocuments()", preparedPaths);
    const invalidation = source.indexOf("await this.deps.getLspClient()!.notifyWorkspaceFilesChanged(", preparedPaths);
    const transientOpen = source.indexOf("await this.deps.preparation.openPreparedDocumentsForExport(preparedPaths)", invalidation);
    const exportRequest = source.indexOf("await this.deps.getLspClient()!.exportPdfToFile(previewPath)", transientOpen);
    const transientClose = source.indexOf("await this.deps.preparation.closePreparedDocuments()", exportRequest);
    const invalidationPrefix = source.slice(preparedPaths, invalidation);

    expect(preparedPaths).toBeGreaterThan(renderStart);
    expect(legacyClose).toBeGreaterThan(preparedPaths);
    expect(invalidation).toBeGreaterThan(legacyClose);
    expect(transientOpen).toBeGreaterThan(invalidation);
    expect(exportRequest).toBeGreaterThan(transientOpen);
    expect(transientClose).toBeGreaterThan(exportRequest);
    expect(invalidationPrefix).not.toContain('renderMode === "on-type"');
    const preparationSource = await Bun.file(
      new URL("../src/preview/pdfPreviewPreparationController.ts", import.meta.url),
    ).text();
    expect(source).toContain("...preparedPreview.changedPaths");
    expect(preparationSource).toContain("changedPaths: result.changedFiles");
    expect(source).not.toContain("syncPreparedPreviewDocuments");
    expect(diagnosticsSource).toContain("if (this.port.isRenderCachePath(rawPath))");
    expect(source).toContain("Tinymist's watched-file invalidation can complete");
  });

  test("uses memory overlays on type and disk snapshots on save", async () => {
    const source = await Bun.file(
      new URL("../src/preview/pdfPreviewRenderController.ts", import.meta.url),
    ).text();
    const preparationSource = await Bun.file(
      new URL("../src/preview/pdfPreviewPreparationController.ts", import.meta.url),
    ).text();
    expect(source).toContain(
      'const useEditorOverlays = this.deps.getPreviewRenderMode() === "on-type" || force;'
    );
    expect(preparationSource).toContain("const tabsToOverlay = useEditorOverlays");
    expect(preparationSource).toMatch(
      /if\s*\(\s*useEditorOverlays\s*&&[\s\S]*?!overlaid\.has\(filePathKey\(originalActivePath\)\)/
    );
  });

  test("keeps editor diagnostics on original sources and recompiles explicit saves in either mode", async () => {
    const source = await Bun.file(new URL("../src/appController.ts", import.meta.url)).text();
    const contentSource = await Bun.file(
      new URL("../src/preview/previewContentController.ts", import.meta.url),
    ).text();
    const persistenceSource = await Bun.file(
      new URL("../src/editor/documentPersistenceController.ts", import.meta.url),
    ).text();
    const diagnosticsSource = await Bun.file(
      new URL("../src/diagnostics/diagnosticsController.ts", import.meta.url)
    ).text();
    const saveStart = persistenceSource.indexOf("private async performSaveActiveFile");
    const saveEnd = persistenceSource.indexOf("\n  private ", saveStart + 10);
    const saveMethod = persistenceSource.slice(saveStart, saveEnd);
    expect(contentSource).toContain("await this.deps.updatePinnedMain(previewLspMainPath(target))");
    expect(source).not.toContain("cachedPreviewCompilerPath");
    expect(diagnosticsSource).toContain("if (this.port.isRenderCachePath(rawPath))");
    expect(saveMethod).toContain("void this.deps.renderPdfPreview(content)");
    expect(saveMethod).not.toContain('effectivePreviewRenderMode === "on-save"');
  });

  test("recovers the latest editor snapshot after a failed on-type render", async () => {
    const source = await Bun.file(new URL("../src/appController.ts", import.meta.url)).text();
    const renderSource = await Bun.file(
      new URL("../src/preview/pdfPreviewRenderController.ts", import.meta.url),
    ).text();
    const diagnosticsSource = await Bun.file(
      new URL("../src/diagnostics/diagnosticsController.ts", import.meta.url)
    ).text();
    const failureSource = await Bun.file(
      new URL("../src/diagnostics/previewFailureController.ts", import.meta.url)
    ).text();
    const recoverySource = await Bun.file(
      new URL("../src/diagnostics/previewDiagnosticsRecoveryController.ts", import.meta.url)
    ).text();
    const renderStart = renderSource.indexOf("public async render(");
    const renderEnd = renderSource.indexOf("\n  public ", renderStart + 10);
    const renderMethod = renderSource.slice(renderStart, renderEnd);
    const diagnosticsStart = source.indexOf("private handleLspDiagnostics");
    const diagnosticsEnd = source.indexOf("\n  private ", diagnosticsStart + 10);
    const diagnosticsMethod = source.slice(diagnosticsStart, diagnosticsEnd);

    expect(renderMethod).toContain("const latestContents = this.deps.getEditorText()");
    expect(renderMethod).toContain("if (latestContents !== contents)");
    expect(renderMethod).toContain("queued !== contents || !renderSucceeded");
    expect(renderMethod).toContain('this.deps.previewFrame.setCompilerError("Preview Render Failed", failureMessage');
    expect(renderMethod).not.toContain("if (!this.deps.previewFrame.currentUrl)");
    expect(renderMethod).not.toContain('if (reportRenderStatus) {\n        this.deps.setLspStatus({ kind: "preview-ready", message: "Preview ready" });');
    expect(renderMethod).toContain('this.deps.setLspStatus({ kind: "preview-ready", message: "Preview ready" });');
    expect(renderMethod).toContain('this.deps.logConsole.clearLogsBySource(["compiler", "package compatibility"]);');
    expect(renderMethod).toContain('this.deps.setLspStatus({ kind: "preview-error", message: "PDF compile failed" });');
    expect(diagnosticsMethod).toContain("this.diagnosticsController.handleLspDiagnostics");
    expect(source).toContain("this.previewDiagnosticsRecoveryController.recoverAfterAcceptedDiagnostics(diagnostics)");
    expect(recoverySource).toContain('this.deps.previewFrame().setError(');
    expect(recoverySource).toContain('"Preview Render Failed"');
    expect(recoverySource).toContain("this.deps.previewFrame().clearErrorOverlay()");
    expect(recoverySource).toContain("this.failedContents === null");
    expect(diagnosticsMethod).toContain("this.diagnosticsController.handleLspDiagnostics");
    expect(recoverySource).toContain("LSP accepted a corrected revision after preview failure");
    expect(renderSource).toContain("parsePreviewCompilerFailure(error)");
    expect(renderMethod).toContain(
      "this.deps.previewFailure.publish(failure, packageHint, displayedFailureMessage)",
    );
    expect(failureSource).toContain("const failureComesFromRenderMirror = failure.location !== null");
    expect(failureSource).toContain("if (!failureComesFromRenderMirror)");
    expect(renderSource).toContain("this.deps.previewFailure.packageFailureHint");
    expect(failureSource).toContain("private async packageDependencyChain(");
    expect(failureSource).toMatch(
      /source:\s*"package compatibility",[\s\S]*?kind:\s*"error"|kind:\s*"error",[\s\S]*?source:\s*"package compatibility"/
    );
    expect(diagnosticsSource).toContain("this.port.acceptedDiagnosticsChanged(filteredDiagnostics)");
  });

  test("keeps the current preview session while navigating to a diagnostic source", async () => {
    const source = await Bun.file(new URL("../src/appController.ts", import.meta.url)).text();
    const diagnosticsSource = await Bun.file(
      new URL("../src/diagnostics/diagnosticsController.ts", import.meta.url)
    ).text();
    const navigateStart = source.indexOf("private navigateToLogEntry");
    const navigateEnd = source.indexOf("\n  private ", navigateStart + 10);
    const navigateMethod = source.slice(navigateStart, navigateEnd);

    expect(navigateMethod).toContain("this.diagnosticsController.navigateToLogEntry(entry)");
    expect(diagnosticsSource).toContain("await this.port.openDiagnosticFile(entry.filePath)");
    expect(source).toContain("const previewSession = this.previewRootPath");
    expect(source).toContain("preservePreviewSession: previewSession");
    expect(diagnosticsSource).not.toContain("loadFile(");
  });

  test("restores retained diagnostics when a source tab becomes active", async () => {
    const source = await Bun.file(new URL("../src/appController.ts", import.meta.url)).text();
    const activationSource = await Bun.file(new URL("../src/editor/editorTabActivationController.ts", import.meta.url)).text();
    const diagnosticsSource = await Bun.file(
      new URL("../src/diagnostics/diagnosticsController.ts", import.meta.url)
    ).text();
    const activateStart = activationSource.indexOf("async activate(");
    const activateEnd = activationSource.indexOf("\n  }", activateStart + 10);
    const activateMethod = activationSource.slice(activateStart, activateEnd);
    const diagnosticsStart = source.indexOf("private handleLspDiagnostics");
    const diagnosticsEnd = source.indexOf("\n  private ", diagnosticsStart + 10);
    const diagnosticsMethod = source.slice(diagnosticsStart, diagnosticsEnd);

    expect(activateMethod).toContain("deps.clearEditorDiagnostics()");
    expect(activateMethod).not.toContain("clearDiagnostics()");
    expect(activateMethod).toContain("deps.restoreCachedEditorDiagnostics(path)");
    expect(diagnosticsMethod).toContain("this.diagnosticsController.handleLspDiagnostics");
    expect(diagnosticsSource).toContain("this.lspDiagnosticsByFile.set(this.port.pathKey(originalPath), cacheableDiagnostics)");
    expect(diagnosticsSource).toContain("restoreCachedEditorDiagnostics(path: string): void");
  });

  test("validates copied workspace caches before starting Tinymist", async () => {
    const source = await Bun.file(
      new URL("../src/workspace/workspaceLifecycleController.ts", import.meta.url),
    ).text();
    const validation = source.indexOf(
      'await invoke("cleanup_workspace_preview_files", { workspaceRootPath: selected })'
    );
    const startup = source.indexOf(
      'await app.restartTinymistSession("Connecting to new project...")'
    );
    expect(validation).toBeGreaterThan(-1);
    expect(startup).toBeGreaterThan(validation);
  });

  test("uses a native Save dialog before writing a user-facing PDF", async () => {
    const source = await Bun.file(
      new URL("../src/export/projectExportController.ts", import.meta.url),
    ).text();
    const selector = source.indexOf('title: "Export PDF"');
    const workspaceCopy = source.indexOf('invoke("copy_workspace_file", { source: pdfPath, dest: exportPdfPath })');
    expect(selector).toBeGreaterThan(-1);
    expect(workspaceCopy).toBeGreaterThan(selector);
    expect(source).toContain('filters: [{ name: "PDF Document", extensions: ["pdf"] }]');
    expect(source).toContain("if (!exportPdfPath)");
  });
});
