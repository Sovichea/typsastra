import { describe, expect, test } from "bun:test";
import { ExternalFileReloadController, type ExternalFileReloadDependencies } from "../src/workspace/externalFileReloadController";
import type { EditorTab } from "../src/editor/editorTab";

function tab(path = "C:/Project/main.typ"): EditorTab {
  return {
    path, content: "original", savedContent: "original", contentLoaded: true, isDirty: false,
    previewRootPath: "C:/Project/main.typ", previewMainPath: "C:/Project/main.typ",
    previewTaskId: null, previewSessionKey: null, previewImported: false,
    previewStandalone: false, previewDisabled: false, version: 1, latestVersion: 1,
    selectionAnchor: 0, selectionHead: 0, foldRanges: [], foldStateExplicit: false,
  };
}

function fixture(overrides: Partial<ExternalFileReloadDependencies> = {}) {
  const source = tab();
  let disk = "external";
  const changed: string[] = [];
  const presented: string[] = [];
  const warnings: string[] = [];
  const deps: ExternalFileReloadDependencies = {
    presentation: { replaceActiveTextContents: (_tab: EditorTab, text: string) => { presented.push(text); } } as unknown as ExternalFileReloadDependencies["presentation"],
    openTabs: () => [source], activeFilePath: () => source.path,
    isInternallySupportedPath: () => true, isSaving: () => false, flushEditorContentMutation: () => {},
    pathExists: async () => true, readText: async () => disk, readImage: async () => disk,
    closeTab: async () => {}, loadPdfPath: () => {}, renderTabs: () => {},
    sourceChanged: current => { changed.push(current.content); },
    confirmReload: async () => false,
    setLspStatus: () => {}, appendWorkspaceWarning: message => { warnings.push(message); },
    invalidateLazyLoad: () => {}, ...overrides,
  };
  return { source, changed, presented, warnings, deps, controller: new ExternalFileReloadController(deps), set disk(text: string) { disk = text; } };
}

describe("external source monitoring", () => {
  test("adopts disk contents as unsaved and emits one normal source mutation", async () => {
    const f = fixture();
    expect(await f.controller.reloadOpenFiles()).toBe(true);
    expect(f.source.content).toBe("external");
    expect(f.source.savedContent).toBe("original");
    expect(f.source.isDirty).toBe(true);
    expect(f.source.externalPreviewPending).toBe(true);
    expect(f.presented).toEqual(["external"]);
    expect(f.changed).toEqual(["external"]);
    expect(await f.controller.reloadOpenFiles()).toBe(false);
    expect(f.source.isDirty).toBe(true);
    expect(f.changed).toHaveLength(1);
  });

  test("adopts consecutive external edits without treating its unsaved marker as a local conflict", async () => {
    const f = fixture();
    await f.controller.reloadOpenFiles();
    f.disk = "external again";
    await f.controller.reloadOpenFiles();
    expect(f.source.content).toBe("external again");
    expect(f.source.isDirty).toBe(true);
    expect(f.warnings).toEqual([]);
    expect(f.changed).toEqual(["external", "external again"]);
  });

  test("keeps a reverted external revision unsaved until an app save", async () => {
    const f = fixture();
    await f.controller.reloadOpenFiles();
    f.disk = "original";
    await f.controller.reloadOpenFiles();
    expect(f.source.content).toBe("original");
    expect(f.source.isDirty).toBe(true);
    expect(f.source.externalContent).toBe("original");
  });

  test("ignores app saves and does not emit a duplicate mutation", async () => {
    const f = fixture();
    f.disk = "original";
    await f.controller.reloadOpenFiles();
    expect(f.changed).toEqual([]);
    expect(f.source.isDirty).toBe(false);
    await f.controller.reloadOpenFiles();
    f.disk = "external";
    await f.controller.reloadOpenFiles();
    f.source.savedContent = f.source.content;
    f.source.externalContent = undefined;
    f.source.isDirty = false;
    await f.controller.reloadOpenFiles();
    expect(f.changed).toEqual(["external"]);
    expect(f.source.isDirty).toBe(false);
  });

  test("preserves local edits and offers each conflicting disk revision only once", async () => {
    let prompts = 0;
    const f = fixture({ confirmReload: async () => { prompts++; return false; } });
    f.source.content = "local";
    f.source.isDirty = true;
    await f.controller.reloadOpenFiles();
    await f.controller.reloadOpenFiles();
    expect(prompts).toBe(1);
    expect(f.source.content).toBe("local");
    expect(f.changed).toEqual([]);
    f.disk = "external again";
    await f.controller.reloadOpenFiles();
    expect(prompts).toBe(2);
  });

  test("reloads a conflicting revision when the user chooses it", async () => {
    const f = fixture({ confirmReload: async () => true });
    f.source.content = "local";
    f.source.isDirty = true;
    await f.controller.reloadOpenFiles();
    expect(f.source.content).toBe("external");
    expect(f.source.isDirty).toBe(true);
    expect(f.controller.conflictPaths.size).toBe(0);
  });

  test("rejects a disk read if the editor or save baseline changed while it was pending", async () => {
    for (const field of ["content", "savedContent"] as const) {
      let resolve!: (value: string) => void;
      const f = fixture({ readText: () => new Promise<string>(done => { resolve = done; }) });
      const reload = f.controller.reloadOpenFiles();
      await Promise.resolve();
      f.source[field] = "new local revision";
      resolve("old disk revision");
      await reload;
      expect(f.changed).toEqual([]);
      expect(f.source[field]).toBe("new local revision");
    }
  });

  test("ignores an in-flight read when an app save starts", async () => {
    let saving = false;
    let resolve!: (value: string) => void;
    const f = fixture({
      isSaving: () => saving,
      readText: () => new Promise<string>(done => { resolve = done; }),
    });
    const reload = f.controller.reloadOpenFiles();
    await Promise.resolve();
    saving = true;
    resolve("intermediate disk write");
    await reload;
    expect(f.source.content).toBe("original");
    expect(f.changed).toEqual([]);
  });

  test("inactive includes discard retained editor state and emit a source mutation", async () => {
    const f = fixture({ activeFilePath: () => "C:/Project/other.typ" });
    f.source.editorState = {} as EditorTab["editorState"];
    await f.controller.reloadOpenFiles();
    expect(f.source.editorState).toBeUndefined();
    expect(f.presented).toEqual([]);
    expect(f.changed).toEqual(["external"]);
  });

  test("routine polling leaves an unloaded tab's in-flight load and metadata intact", async () => {
    let invalidations = 0;
    const f = fixture({ invalidateLazyLoad: () => { invalidations++; } });
    f.source.contentLoaded = false;
    f.source.sizeBytes = 40000;
    f.source.lineCount = 600;
    await f.controller.reloadOpenFiles();
    await f.controller.reloadOpenFiles();
    expect(invalidations).toBe(0);
    expect(f.source.sizeBytes).toBe(40000);
    expect(f.source.lineCount).toBe(600);
    await f.controller.reloadOpenFiles([f.source.path]);
    expect(invalidations).toBe(1);
    expect(f.source.sizeBytes).toBeUndefined();
  });

  test("polling does not repeatedly reopen PDF assets", async () => {
    let loads = 0;
    const f = fixture({ loadPdfPath: () => { loads++; } });
    f.source.path = "C:/Project/readme.pdf";
    await f.controller.reloadOpenFiles();
    expect(loads).toBe(0);
    await f.controller.reloadOpenFiles([f.source.path]);
    expect(loads).toBe(1);
  });
});
