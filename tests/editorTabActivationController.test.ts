import { describe, expect, test } from "bun:test";
import { EditorTabActivationController, type EditorTabActivationDependencies } from "../src/editor/editorTabActivationController";
import type { EditorTab } from "../src/editor/editorTab";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function tab(path: string, loaded = true): EditorTab {
  return {
    path, content: path, savedContent: path, contentLoaded: loaded, isDirty: false,
    previewRootPath: null, previewMainPath: null, previewTaskId: null, previewSessionKey: null,
    previewImported: false, previewStandalone: false, previewDisabled: false,
    version: 1, latestVersion: 1, selectionAnchor: 0, selectionHead: 0,
    foldRanges: [], foldStateExplicit: false,
  };
}

function fixture(overrides: Partial<EditorTabActivationDependencies> = {}) {
  const original = tab("C:/project/main.typ");
  const first = tab("C:/project/first.typ");
  const second = tab("C:/project/second.typ");
  const tabs = [original, first, second];
  let activePath = original.path;
  let editorText = original.content;
  const presented: string[] = [];
  const prepared: string[] = [];
  const finished: string[] = [];
  const persisted: string[] = [];
  const noop = () => {};
  const noops = Object.fromEntries([
    "capturePreviewViewport", "clearGuardrailAlignment", "updatePreviewActionsToolbar", "renderEditorTabs",
    "saveWorkspaceState", "cancelManualForwardSync", "updateManualForwardSyncAction", "setCurrentVersion",
    "setLatestDocumentVersion", "clearEditorDiagnostics", "setLoadingFile", "activateSpellcheckDocument",
    "clearOutline", "restoreCachedEditorDiagnostics", "updateWorkspaceViewportVisibility", "restoreTabFoldState",
    "setDiagnosticWaitStartedAt", "clearPendingLspSync", "scheduleDocumentOutlineUpdate", "logPreview",
  ].map(name => [name, noop]));
  const deps = {
    ...noops,
    explorer: { setActiveFile: noop, revealPath: async () => {} },
    workspaceRootPath: () => "C:/project", openTabs: () => tabs,
    activeFilePath: () => activePath, setActiveFilePath: (path: string) => { activePath = path; },
    isInternallySupportedPath: () => true,
    largeFileNoticeForTab: async () => null,
    loadEditorTabContent: async (current: EditorTab) => { current.contentLoaded = true; },
    persistActiveTabState: () => { persisted.push(activePath + ":" + editorText); },
    editor: () => ({ state: { doc: { toString: () => editorText }, selection: { main: { head: 0 } } }, focus: noop }),
    markdownPreview: { activate: noop, deactivate: noop }, setMarkdownPreviewActive: noop,
    typography: { setAcceptedFonts: noop, fromText: () => null, effective: async () => null },
    previewSync: { reset: noop, clearForward: noop },
    presentation: {
      presentText: (current: EditorTab) => { editorText = current.content; presented.push(current.path); },
      finishTextPresentation: (path: string) => finished.push(path),
    },
    draftPreview: { publishWarnings: noop },
    restoreEditorTabViewport: async () => {},
    resumeDeferredWorkspaceServices: async () => {}, isLowMemoryMode: () => false,
    toolbar: { synchronizeDocumentTypography: noop },
    previewActivation: {
      prepare: async (_tab: EditorTab, path: string) => { prepared.push(path); return { target: null, guarded: false, presentationReused: true }; },
      finish: async () => {},
    },
    spellcheck: { schedule: noop }, outline: { setCursorPosition: noop },
    activeMode: () => "CODE", editorController: { refreshLayout: noop },
    ...overrides,
  } as unknown as EditorTabActivationDependencies;
  return { controller: new EditorTabActivationController(deps), first, second, tabs, presented, prepared, finished, persisted,
    get activePath() { return activePath; }, get editorText() { return editorText; } };
}

describe("editor tab activation ownership", () => {
  test("a slow unloaded tab cannot replace a more recently selected tab", async () => {
    const read = deferred();
    const f = fixture({ loadEditorTabContent: async current => { await read.promise; current.contentLoaded = true; } });
    f.first.contentLoaded = false;
    const older = f.controller.activate(f.first.path);
    await Promise.resolve();
    await f.controller.activate(f.second.path);
    read.resolve();
    await older;
    expect(f.activePath).toBe(f.second.path);
    expect(f.editorText).toBe(f.second.content);
    expect(f.presented).toEqual([f.second.path]);
    expect(f.persisted.every(value => value === "C:/project/main.typ:C:/project/main.typ")).toBe(true);
  });

  test("an older viewport restoration cannot finish a newer tab's presentation", async () => {
    const restoration = deferred();
    const f = fixture({ restoreEditorTabViewport: current => current.path.endsWith("first.typ") ? restoration.promise : Promise.resolve() });
    const older = f.controller.activate(f.first.path);
    await f.controller.activate(f.second.path);
    restoration.resolve();
    await older;
    expect(f.activePath).toBe(f.second.path);
    expect(f.prepared).toEqual([f.second.path]);
    expect(f.finished).toEqual([f.second.path]);
  });

  test("repeated clicks share the pending activation instead of cancelling its completion", async () => {
    const restoration = deferred();
    const f = fixture({ restoreEditorTabViewport: () => restoration.promise });
    const firstClick = f.controller.activate(f.first.path);
    const secondClick = f.controller.activate(f.first.path);
    expect(secondClick).toBe(firstClick);
    restoration.resolve();
    await Promise.all([firstClick, secondClick]);
    expect(f.presented).toEqual([f.first.path]);
    expect(f.finished).toEqual([f.first.path]);
    expect(f.prepared).toEqual([f.first.path]);
  });

  test("closing a tab during its read prevents it from becoming active", async () => {
    const read = deferred();
    const f = fixture({ loadEditorTabContent: async current => { await read.promise; current.contentLoaded = true; } });
    f.first.contentLoaded = false;
    const activation = f.controller.activate(f.first.path);
    await Promise.resolve();
    f.tabs.splice(f.tabs.indexOf(f.first), 1);
    read.resolve();
    await activation;
    expect(f.presented).toEqual([]);
    expect(f.activePath).toBe("C:/project/main.typ");
  });
});
