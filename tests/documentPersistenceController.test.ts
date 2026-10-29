import { describe, expect, mock, test } from "bun:test";

const invocations: Array<{ command: string; args: unknown }> = [];
mock.module("@tauri-apps/api/core", () => ({
  invoke: async (command: string, args?: unknown) => {
    invocations.push({ command, args });
    return undefined;
  },
}));

const { DocumentPersistenceController } = await import("../src/editor/documentPersistenceController");

function createController(options: {
  content: string;
  savedContent: string;
  dirty: boolean;
  renderMode: "on-type" | "on-save";
  formatOnSave?: boolean;
  pendingInclude?: boolean;
}) {
  const tab = {
    path: "C:/project/main.typ",
    content: options.content,
    savedContent: options.savedContent,
    isDirty: options.dirty,
    contentLoaded: true,
    previewDisabled: false,
    externalContent: undefined as string | undefined,
    externalPreviewPending: false,
    previewMainPath: "C:/project/main.typ",
  };
  const include = { ...tab, path: "C:/project/chapter.typ", externalPreviewPending: true };
  let formatCalls = 0;
  let refreshCalls = 0;
  const controller = new DocumentPersistenceController({
    activeFilePath: () => tab.path,
    activeMode: () => "CODE",
    previewRenderMode: () => options.renderMode,
    workspaceRootPath: () => "C:/project",
    openTabs: () => (options.pendingInclude ? [tab, include] : [tab]) as never,
    isInternallySupportedPath: () => true,
    flushEditorContentMutation: () => {},
    formatOnSave: () => options.formatOnSave ?? false,
    autoSaveSettings: () => ({ enabled: false, intervalSeconds: 60 }),
    formatActiveDocument: async () => { formatCalls += 1; return true; },
    removeTrailingSpaces: () => {},
    editorText: () => options.content,
    wysiwymMarkup: () => options.content,
    isPinnedMainFile: () => false,
    refreshWorkspaceExplorer: async () => {},
    loadFile: async () => {},
    setPinnedMainFile: async () => {},
    lspReady: () => false,
    flushPendingLspSync: async () => {},
    notifyLspSave: async () => {},
    logMemoryDiagnostics: async () => {},
    clearExternalConflict: () => {},
    autoSaveAllowed: () => true,
    recoveryRevision: () => 0,
    recoverySaved: async () => {},
    renderEditorTabs: () => {},
    refreshPreviewAfterSave: async () => { refreshCalls += 1; },
    setLspStatus: () => {},
    log: () => {},
  });
  return { controller, tab, include,
    runAutoSave: () => (controller as unknown as { runAutoSaveCycle(): Promise<void> }).runAutoSaveCycle(),
    get formatCalls() { return formatCalls; }, get refreshCalls() { return refreshCalls; } };
}

describe("document persistence preview scheduling", () => {
  test("saving an untouched clean Typst file neither formats nor force-renders it", async () => {
    invocations.length = 0;
    const fixture = createController({
      content: "= Finished\n",
      savedContent: "= Finished\n",
      dirty: false,
      renderMode: "on-save",
      formatOnSave: true,
    });

    await fixture.controller.saveActiveFile("manual");

    expect(fixture.formatCalls).toBe(0);
    expect(fixture.refreshCalls).toBe(0);
    expect(invocations.filter(call => call.command === "save_workspace_file")).toHaveLength(1);
  });

  test("an externally changed include compiles on manual main-file save, even if main is unchanged", async () => {
    const fixture = createController({ content: "main", savedContent: "main", dirty: false, renderMode: "on-save", pendingInclude: true });
    await fixture.controller.saveActiveFile("manual");
    expect(fixture.refreshCalls).toBe(1);
    expect(fixture.include.externalPreviewPending).toBe(false);
  });

  test("automatic saving compiles an external revision in On save mode", async () => {
    const fixture = createController({ content: "external", savedContent: "old", dirty: true, renderMode: "on-save" });
    fixture.tab.externalContent = "external";
    fixture.tab.externalPreviewPending = true;
    await fixture.controller.saveActiveFile("automatic");
    expect(fixture.refreshCalls).toBe(1);
    expect(fixture.tab.isDirty).toBe(false);
    expect(fixture.tab.externalPreviewPending).toBe(false);
    await fixture.controller.saveActiveFile("manual");
    expect(fixture.refreshCalls).toBe(1);
    expect(fixture.tab.externalPreviewPending).toBe(false);
  });

  test("a timer cycle compiles a batch of dirty source files once in On save mode", async () => {
    const fixture = createController({ content: "changed main", savedContent: "old main", dirty: true, renderMode: "on-save", pendingInclude: true });
    fixture.include.content = "changed include";
    fixture.include.isDirty = true;
    await fixture.runAutoSave();
    expect(fixture.refreshCalls).toBe(1);
    expect(fixture.tab.isDirty).toBe(false);
    expect(fixture.include.isDirty).toBe(false);
    expect(fixture.include.externalPreviewPending).toBe(false);
  });

  test("auto-saving an inactive include refreshes an unchanged active main file", async () => {
    const fixture = createController({ content: "main", savedContent: "main", dirty: false, renderMode: "on-save", pendingInclude: true });
    fixture.include.content = "changed include";
    fixture.include.isDirty = true;
    await fixture.runAutoSave();
    expect(fixture.refreshCalls).toBe(1);
  });

  test("auto-save does not request extra compilation in On type mode", async () => {
    const fixture = createController({ content: "changed", savedContent: "old", dirty: true, renderMode: "on-type" });
    await fixture.runAutoSave();
    expect(fixture.tab.isDirty).toBe(false);
    expect(fixture.refreshCalls).toBe(0);
  });

  test("an auto-save check without dirty files does not compile", async () => {
    const fixture = createController({ content: "same", savedContent: "same", dirty: false, renderMode: "on-save" });
    await fixture.runAutoSave();
    expect(fixture.refreshCalls).toBe(0);
  });

  test("auto-saving a non-source file does not compile the document", async () => {
    const fixture = createController({ content: "changed", savedContent: "old", dirty: true, renderMode: "on-save", pendingInclude: true });
    fixture.include.path = "C:/project/notes.md";
    fixture.tab.isDirty = false;
    fixture.include.isDirty = true;
    await fixture.runAutoSave();
    expect(fixture.refreshCalls).toBe(0);
  });

  test("a changed Typst file refreshes once on save mode, not on type mode", async () => {
    const onSave = createController({
      content: "= Edited\n",
      savedContent: "= Original\n",
      dirty: true,
      renderMode: "on-save",
    });
    await onSave.controller.saveActiveFile("manual");
    expect(onSave.refreshCalls).toBe(1);

    const onType = createController({
      content: "= Edited\n",
      savedContent: "= Original\n",
      dirty: true,
      renderMode: "on-type",
    });
    await onType.controller.saveActiveFile("manual");
    expect(onType.refreshCalls).toBe(0);
  });
});
