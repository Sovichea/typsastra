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

describe("editor and document controller extraction", () => {
  test("moves tab state, presentation, and open/close lifecycle behind typed controllers", async () => {
    const app = await source("../src/appController.ts");
    const state = await source("../src/editor/editorTabStateController.ts");
    const presentation = await source("../src/editor/editorTabPresentationController.ts");
    const lifecycle = await source("../src/editor/editorTabLifecycleController.ts");

    expect(app).toContain("this.editorTabStateController.persistActive()");
    expect(app).toContain("this.editorTabLifecycleController.close(path, skipDirtyCheck)");
    expect(app).toContain("this.editorTabLifecycleController.load(path, options)");
    expect(state).toContain("captureEditorUndoHistory(editor.state)");
    expect(presentation).toContain("presentEmpty(): void");
    expect(lifecycle).toContain("export interface EditorTabLifecycleDependencies");
    expect(lifecycle).toContain("await this.dependencies.lspDocuments.closeIfOpened(path)");
    expectTypedBoundary(state);
    expectTypedBoundary(presentation);
    expectTypedBoundary(lifecycle);
  });

  test("moves preview session, large-preview policy, and activation preparation with their state", async () => {
    const session = await source("../src/preview/previewSessionController.ts");
    const guard = await source("../src/workspace/largePreviewGuardController.ts");
    const activation = await source("../src/editor/editorPreviewActivationController.ts");

    expect(session).toContain("private session: PreviewSessionState = {");
    expect(session).toContain("captureCurrentMainSessionForImportedTarget");
    expect(guard).toContain("readonly approvedRoots = new Set<string>()");
    expect(guard).toContain("async ensureApproved(rootPath: string | null)");
    expect(activation).toContain("this.deps.previewSession.prepareTemplateAware");
    expectTypedBoundary(session);
    expectTypedBoundary(guard);
    expectTypedBoundary(activation);
  });

  test("moves LSP document, language, external reload, and recovery state out of the root", async () => {
    const lsp = await source("../src/session/lspDocumentController.ts");
    const language = await source("../src/editor/documentLanguageController.ts");
    const reload = await source("../src/workspace/externalFileReloadController.ts");
    const recovery = await source("../src/preview/tinymistPreviewRecoveryController.ts");
    const surround = await source("../src/editor/surroundWithDiscoveryController.ts");

    expect(lsp).toContain("private readonly openedUris = new Set<string>()");
    expect(language).toContain("private outlineUpdateTimer: number | null = null");
    expect(reload).toContain("readonly conflictPaths = new Set<string>()");
    expect(recovery).toContain("private attempts = 0");
    expect(surround).toContain("private optionsValue: readonly SurroundWithOption[] = SURROUND_WITH_OPTIONS");
    for (const controller of [lsp, language, reload, recovery, surround]) {
      expectTypedBoundary(controller);
    }
  });

  test("keeps main-file typography preparation as a typed, delegated workflow", async () => {
    const app = await source("../src/appController.ts");
    const typography = await source("../src/typography/pinnedMainTypographyController.ts");

    expect(app).toContain("return this.pinnedMainTypographyController.prepare(path)");
    expect(typography).toContain("export interface PinnedMainTypographyDependencies");
    expect(typography).toContain('title: t("Prepare Document Fonts?")');
    expect(typography).toContain("prepareMainFileFonts(typography)");
    expectTypedBoundary(typography);
  });
});
