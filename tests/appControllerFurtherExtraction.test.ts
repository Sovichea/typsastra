import { describe, expect, test } from "bun:test";

async function source(path: string): Promise<string> {
  return Bun.file(new URL(path, import.meta.url)).text();
}

function expectTypedBoundary(controllerSource: string): void {
  expect(controllerSource).not.toMatch(/\bhost\s*:\s*object\b/u);
  expect(controllerSource).not.toMatch(/\bas\s+any\b/u);
  expect(controllerSource).not.toMatch(/:\s*any\b/u);
  expect(controllerSource).not.toContain("new Proxy(");
}

describe("continued app controller extraction", () => {
  test("delegates document formatting, workspace text, and typography application", async () => {
    const app = await source("../src/appController.ts");
    const formatting = await source("../src/editor/documentFormattingController.ts");
    const workspaceText = await source("../src/workspace/workspaceTextController.ts");
    const typography = await source("../src/typography/documentTypographyApplicationController.ts");

    expect(app).toContain("this.documentFormattingController.formatActiveDocument(options)");
    expect(app).toContain("this.workspaceTextController.write(path, content)");
    expect(app).toContain("this.documentTypographyApplicationController.apply(config, target)");
    expect(formatting).toContain("export interface DocumentFormattingDependencies");
    expect(workspaceText).toContain("export interface WorkspaceTextDependencies");
    expect(workspaceText).toContain("this.deps.presentation().replaceActiveTextContents(tab, content)");
    expect(typography).toContain("export interface DocumentTypographyApplicationDependencies");
    expect(typography).toContain("await workspaceText.write(templatePath, templateText)");

    for (const controller of [formatting, workspaceText, typography]) expectTypedBoundary(controller);
  });

  test("moves source navigation, outline navigation, and cache mapping behind typed controllers", async () => {
    const app = await source("../src/appController.ts");
    const sourceLocation = await source("../src/navigation/sourceLocationController.ts");
    const outline = await source("../src/navigation/outlineNavigationController.ts");

    expect(app).toContain("this.sourceLocationController.navigateToLspLocation(uri, line, character)");
    expect(app).toContain("this.sourceLocationController.mapToOriginalPath(cachePath)");
    expect(app).toContain("this.outlineNavigationController.navigate(heading)");
    expect(sourceLocation).toContain("mapCacheLspPositionToOriginalEditorOffset(");
    expect(sourceLocation).toContain('invoke<number | null>("map_generated_to_source"');
    expect(outline).toContain('await this.deps.loadFile(heading.filePath, { focusEditor: false })');

    expectTypedBoundary(sourceLocation);
    expectTypedBoundary(outline);
  });

  test("moves queued LSP synchronization and restart restoration behind a typed controller", async () => {
    const app = await source("../src/appController.ts");
    const sync = await source("../src/session/lspSyncController.ts");

    expect(app).toContain("this.lspSyncController.queueContentMutation(rawText)");
    expect(app).toContain("return this.lspSyncController.flushPending()");
    expect(app).toContain("return this.lspSyncController.restoreActiveDocumentAfterRestart(");
    expect(app).toContain("forcePreview,");
    expect(app).toContain("forceCompile,");
    expect(sync).toContain("export interface LspSyncDependencies");
    expect(sync).toContain("this.deps.session().queueDocumentSync(");
    expect(sync).toContain("session.isSyncRequestCurrent(requestKey, expectedGeneration)");
    expect(sync).toContain("await this.deps.updatePinnedMain(mainPath, true)");
    expect(sync).toContain("this.deps.activeEditorText()");

    expectTypedBoundary(sync);
  });

  test("moves workspace rename propagation behind a typed controller", async () => {
    const app = await source("../src/appController.ts");
    const rename = await source("../src/workspace/workspacePathRenameController.ts");

    expect(app).toContain("return this.workspacePathRenameController.rename(oldPath, newPath, updateImageReferences)");
    expect(rename).toContain("export interface WorkspacePathRenameDependencies");
    expect(rename).toContain('await invoke("rename_workspace_file", { oldPath, newPath })');
    expect(rename).toContain("this.deps.documentSession().remapPendingSyncPath");
    expect(rename).toContain("this.deps.previewPreparation().clearGeneratedFiles()");
    expect(rename).toContain("await this.deps.lspDocuments().transferRenamedDocuments");
    expect(rename).toContain("await this.deps.workspace().startWatching(workspaceRoot)");

    expectTypedBoundary(rename);
  });

  test("moves Tinymist integration, developer logs, and diagnostic preview recovery with their state", async () => {
    const app = await source("../src/appController.ts");
    const integration = await source("../src/session/tinymistIntegrationController.ts");
    const logging = await source("../src/diagnostics/developerLogController.ts");
    const recovery = await source("../src/diagnostics/previewDiagnosticsRecoveryController.ts");

    expect(app).toContain("return this.tinymistIntegrationController.createClient()");
    expect(app).toContain("this.developerLogController.appendDeveloper(entry)");
    expect(app).toContain("this.previewDiagnosticsRecoveryController.recoverAfterAcceptedDiagnostics(diagnostics)");
    expect(integration).toContain("export interface TinymistIntegrationDependencies");
    expect(integration).toContain("resetSessionState(): void");
    expect(logging).toContain("developerLogging():");
    expect(recovery).toContain("private failedContents: string | null = null");
    expect(recovery).toContain("private lastRequestedContents: string | null = null");

    for (const controller of [integration, logging, recovery]) expectTypedBoundary(controller);
  });
});
