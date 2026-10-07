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
}) {
  const tab = {
    path: "C:/project/main.typ",
    content: options.content,
    savedContent: options.savedContent,
    isDirty: options.dirty,
  };
  let formatCalls = 0;
  let refreshCalls = 0;
  const controller = new DocumentPersistenceController({
    activeFilePath: () => tab.path,
    activeMode: () => "CODE",
    previewRenderMode: () => options.renderMode,
    workspaceRootPath: () => "C:/project",
    openTabs: () => [tab] as never,
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
    renderEditorTabs: () => {},
    refreshPreviewAfterManualSave: async () => { refreshCalls += 1; },
    setLspStatus: () => {},
    log: () => {},
  });
  return { controller, tab, get formatCalls() { return formatCalls; }, get refreshCalls() { return refreshCalls; } };
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
