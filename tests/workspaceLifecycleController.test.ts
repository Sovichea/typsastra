import { describe, expect, test } from "bun:test";
import {
  WorkspaceLifecycleController,
  type WorkspaceLifecycleDependencies,
} from "../src/workspace/workspaceLifecycleController";

function lifecycleHarness(
  overrides: Partial<WorkspaceLifecycleDependencies> = {},
): { controller: WorkspaceLifecycleController; calls: string[]; app: WorkspaceLifecycleDependencies } {
  const calls: string[] = [];
  const app = new Proxy({
    workspaceRootPath: "C:/project",
    workspaceServicesDeferredForLargeFile: false,
    pinnedMainFilePath: null,
    lspClient: null,
    lspReady: false,
    activeFilePath: null,
    openTabs: [],
    recentProjectsController: {
      add: (path: string) => calls.push(`recent:${path}`),
    },
    ensureLargePreviewApproved: async () => true,
    preparePinnedMainTypography: async () => null,
    prepareRenderProjectIfNeeded: async () => { calls.push("prepare-preview"); },
    restartTinymistSession: async () => { calls.push("restart-lsp"); },
    stopTinymistSession: async () => { calls.push("stop-lsp"); },
    restoreActiveDocumentAfterTinymistRestart: async () => { calls.push("restore-document"); },
    settingsController: {
      value: {
        preview: { renderMode: "on-type", lowMemoryMode: false },
        editor: { globalTerminology: [], languageTerminology: {}, scopedIgnoredWords: {} },
      },
      setWorkspacePreviewRenderMode: () => {},
      setProjectTerminology: () => {},
    },
    appendDeveloperLog: () => {},
    closeEditorTab: async (path: string) => { calls.push(`close-tab:${path}`); },
    ...overrides,
  } as Partial<WorkspaceLifecycleDependencies>, {
    get(target, property) {
      if (property in target) return Reflect.get(target, property);
      return undefined;
    },
    set(target, property, value) {
      return Reflect.set(target, property, value);
    },
  }) as WorkspaceLifecycleDependencies;
  return { controller: new WorkspaceLifecycleController(app), calls, app };
}

describe("WorkspaceLifecycleController behavior", () => {
  test("replays a restored image preview after workspace loading finishes", async () => {
    const imageTab = {
      path: "C:/project/photo.png",
      content: "base64-image",
      contentLoaded: true,
    } as WorkspaceLifecycleDependencies["openTabs"][number];
    const { controller, calls } = lifecycleHarness({
      activeFilePath: imageTab.path,
      openTabs: [imageTab],
      getActiveTab: () => imageTab,
      restoreActiveNonTextPreview: async () => { calls.push("restore-image-preview"); },
    });

    await (controller as unknown as { restoreStartupViewport(): Promise<void> })
      .restoreStartupViewport();

    expect(calls).toEqual(["restore-image-preview"]);
  });

  test("reopening the active project only refreshes its recent-project entry", async () => {
    const { controller, calls } = lifecycleHarness();

    await controller.open("c:/PROJECT");

    expect(calls).toEqual(["recent:c:/PROJECT"]);
  });

  test("does not start compiler services after the project has changed", async () => {
    const { controller, calls } = lifecycleHarness({
      workspaceRootPath: "C:/replacement",
    });

    await controller.startServices("C:/previous");

    expect(calls).toEqual([]);
  });

  test("prepares preview state before restarting Tinymist and restoring the active document", async () => {
    const { controller, calls } = lifecycleHarness({
      lspClient: {} as WorkspaceLifecycleDependencies["lspClient"],
      activeFilePath: "C:/project/main.typ",
    });

    await controller.startServices("C:/project");

    expect(calls).toEqual(["prepare-preview", "restart-lsp", "restore-document"]);
  });

  test("uses no persistent language server for low memory workspaces", async () => {
    const { controller, calls } = lifecycleHarness({
      lspClient: {} as WorkspaceLifecycleDependencies["lspClient"],
      activeFilePath: "C:/project/main.typ",
      settingsController: {
        value: {
          preview: { renderMode: "on-type", lowMemoryMode: true },
          editor: { globalTerminology: [], languageTerminology: {}, scopedIgnoredWords: {} },
        },
        setWorkspacePreviewRenderMode: () => {},
        setProjectTerminology: () => {},
      },
    });

    await controller.startServices("C:/project");

    expect(calls).toEqual(["prepare-preview", "stop-lsp"]);
  });

  test("closes every tab except the requested survivor in tab order", async () => {
    const { controller, calls, app } = lifecycleHarness();
    app.openTabs = [
      { path: "C:/project/one.typ" },
      { path: "C:/project/main.typ" },
      { path: "C:/project/two.typ" },
    ] as WorkspaceLifecycleDependencies["openTabs"];

    await controller.closeOtherTabs("C:/project/main.typ");

    expect(calls).toEqual([
      "close-tab:C:/project/one.typ",
      "close-tab:C:/project/two.typ",
    ]);
  });

  test("restart closes without prompting before reopening the captured project", async () => {
    const { controller, calls } = lifecycleHarness();
    controller.close = async options => {
      calls.push(`close:${String(options.confirmUnsaved)}`);
      return true;
    };
    controller.open = async path => { calls.push(`open:${path}`); };

    await controller.restart();

    expect(calls).toEqual(["close:false", "open:C:/project"]);
  });

  test("close retires the preview, stops services, and releases workspace ownership", async () => {
    const previousDocument = globalThis.document;
    const previousWindow = globalThis.window;
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: { body: { classList: { remove: () => calls.push("leave-image-tools") } } },
    });
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { clearTimeout: () => {} },
    });
    const { controller, calls, app } = lifecycleHarness({
      openTabs: [],
      previewTaskId: null,
      previewScrollTop: 12,
      previewScrollSaveTimer: null,
      pinnedMainFilePath: "C:/project/main.typ",
      pinnedLspMainPath: "C:/project/main.typ",
      mainDocumentScripts: [],
      workspaceMetadata: null,
      workspaceLoading: false,
      blockedLargePreviewRoot: null,
      recommendedWorkspaceToolchain: null,
      selectedWorkspaceToolchain: null,
      previewRootPath: "C:/project/main.typ",
      previewMainPath: "C:/project/main.typ",
      previewSessionKey: "preview",
      previewImported: false,
      previewStandalone: true,
      previewDisabled: false,
      externalPreviewRefreshPending: false,
      lastPreviewRenderMode: "on-save",
      isLoadingFile: false,
      activeMode: "CODE",
      editorExtensions: [],
      approvedLargePreviewRoots: new Set(),
      inspectedPreviewRoots: new Set(),
      managedImageToolPathKeys: new Set(),
      externalConflictPaths: new Set(),
      previewFrame: { currentUrl: null, restoreWorkspaceScrollPosition: () => {}, clear: () => calls.push("clear-preview") },
      pdfPreviewRenderController: { sourceMapTaskId: null, resetForWorkspaceClose: () => {} },
      pdfPreviewPreparationController: { clearGeneratedFiles: () => {} },
      sourceMapSessionController: { registeredTaskId: null, reset: () => {} },
      workspaceController: {
        absolutePath: async () => null,
        loadMetadata: async () => { throw new Error("unused"); },
        startWatching: async () => {},
        stopWatching: () => calls.push("stop-watching"),
      },
      saveWorkspaceState: async () => { calls.push("save-workspace"); },
      stopTinymistSession: async () => { calls.push("stop-lsp"); },
      sidebarController: { activeTool: "explorer", restore: () => {}, reset: () => {} },
      imageToolsController: { setWorkspace: async () => {}, show: () => {} },
      settingsController: {
        value: {
          preview: { renderMode: "on-save", lowMemoryMode: false },
          editor: { globalTerminology: [], languageTerminology: {}, scopedIgnoredWords: {} },
        },
        setWorkspacePreviewRenderMode: () => {},
        setProjectTerminology: () => {},
      },
      draftPreviewController: { mode: "normal", setMode: () => {}, reset: () => {} },
      previewSyncController: { cancelManual: () => {}, clearForward: () => {} },
      typographyController: { resetRuntime: () => {} },
      imagePreviewController: { clear: () => {} },
      updatePreviewActionsToolbar: () => {},
      lspDocumentController: { resetSessionState: () => {} },
      clearPendingLspSync: () => {},
      clearDiagnostics: () => {},
      logConsoleController: { clearAllLogs: () => {}, setVisible: () => {} },
      editorInstance: {
        setState: () => {},
        dispatch: () => {},
      } as unknown as WorkspaceLifecycleDependencies["editorInstance"],
      currentEditorSettingsEffects: () => [],
      applyFoldRanges: () => {},
      activateSpellcheckDocument: () => {},
      editorFontManager: { ready: async () => {}, updateDocument: () => {} },
      editorToolbarController: { synchronizeDocumentTypography: () => {}, setDisabled: () => {} },
      explorer: {
        loadWorkspace: async () => {},
        revealPath: async () => {},
        setActiveFile: () => {},
        clearWorkspace: () => {},
      },
      documentOutlineController: { clear: () => {} },
      renderEditorTabs: () => {},
      setLspStatus: () => {},
      updateWorkspaceViewportVisibility: () => calls.push("update-viewport"),
    });

    try {
      expect(await controller.close({ confirmUnsaved: false })).toBe(true);
      expect(app.workspaceRootPath).toBeNull();
      expect(app.pinnedMainFilePath).toBeNull();
      expect(app.previewRootPath).toBeNull();
      expect(calls.slice(0, 4)).toEqual([
        "clear-preview",
        "save-workspace",
        "stop-watching",
        "stop-lsp",
      ]);
      expect(calls).toContain("update-viewport");
    } finally {
      Object.defineProperty(globalThis, "document", { configurable: true, value: previousDocument });
      Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow });
    }
  });
});
