import { beforeEach, describe, expect, test } from "bun:test";
import {
  WorkspaceStateStore,
  normalizeWorkspaceMetadata,
  safeRelativeWorkspacePath,
  workspaceRestoreCandidates
} from "../src/workspace/workspaceStateStore";

const values = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key)
  },
  configurable: true
});

describe("workspace state store", () => {
  beforeEach(() => values.clear());

  test("normalizes portable project and session metadata", () => {
    expect(normalizeWorkspaceMetadata({
      project: { projectId: "project-1", mainFile: "chapters/main.typ" },
      workspace: {
        activeFile: "chapters/one.typ",
        openTabs: [{ path: "chapters/one.typ", selectionAnchor: 4, selectionHead: 5 }],
        expandedDirectories: ["chapters"],
        layout: { inputContainerWidthPct: 60, explorerSidebarWidthPx: 300, sidebarVisible: false }
      }
    })).toEqual({
      project: {
        schemaVersion: 2,
        projectId: "project-1",
        mainFile: "chapters/main.typ",
        recommendedToolchain: null,
        terminology: [],
        scriptLanguages: []
      },
      workspace: {
        schemaVersion: 2,
        activeFile: "chapters/one.typ",
        openTabs: [{
          path: "chapters/one.typ",
          selectionAnchor: 4,
          selectionHead: 5,
          scrollTop: undefined,
          scrollLeft: undefined,
          previewScrollTop: undefined,
          foldState: null,
          foldRanges: null
        }],
        expandedDirectories: ["chapters"],
        layout: {
          inputContainerWidthPct: 60,
          explorerSidebarWidthPx: 300,
          sidebarVisible: false,
          activeSidebarTool: "explorer"
        },
        selectedToolchain: null,
        previewContentMode: "normal",
        previewRenderMode: null,
        previewScrollTop: 0
      }
    });
  });

  test("normalizes portable script-language assignments", () => {
    const metadata = normalizeWorkspaceMetadata({
      project: {
        scriptLanguages: [
          { script: "Latn", languageTag: "EN_us" },
          { script: "Khmr", languageTag: "KM" },
          { script: "Latn", languageTag: "fr-fr" },
          { script: "latin", languageTag: "en-US" },
          { script: "Arab", languageTag: "invalid-tag-extra" },
        ],
      },
      workspace: null,
    });

    expect(metadata.project.scriptLanguages).toEqual([
      { script: "Khmr", languageTag: "km" },
      { script: "Latn", languageTag: "fr-FR" },
    ]);
  });

  test("rejects absolute and traversing metadata paths", () => {
    expect(safeRelativeWorkspacePath("chapters/main.typ")).toBe("chapters/main.typ");
    expect(safeRelativeWorkspacePath("C:\\project\\main.typ")).toBeNull();
    expect(safeRelativeWorkspacePath("../main.typ")).toBeNull();
    expect(safeRelativeWorkspacePath("/project/main.typ")).toBeNull();
  });

  test("restores active and main files without duplicate candidates", () => {
    const metadata = normalizeWorkspaceMetadata({
      project: { projectId: "project-1", mainFile: "main.typ" },
      workspace: { activeFile: "main.typ", openTabs: [{ path: "chapter.typ" }] }
    });
    expect(workspaceRestoreCandidates(metadata)).toEqual(["main.typ", "chapter.typ"]);
  });

  test("removes duplicate persisted tabs while preserving their first state", () => {
    const metadata = normalizeWorkspaceMetadata({
      project: { projectId: "project-1", mainFile: "main.typ" },
      workspace: {
        activeFile: "main.typ",
        openTabs: [
          { path: "main.typ", selectionAnchor: 4 },
          { path: "main.typ", selectionAnchor: 99 },
          { path: "chapter.typ", selectionAnchor: 8 }
        ]
      }
    });
    expect(metadata.workspace.openTabs.map(tab => [tab.path, tab.selectionAnchor])).toEqual([
      ["main.typ", 4],
      ["chapter.typ", 8]
    ]);
  });

  test("restores only explicitly user-owned fold state", () => {
    const metadata = normalizeWorkspaceMetadata({
      project: { projectId: "project-1" },
      workspace: {
        openTabs: [
          { path: "legacy.typ", foldRanges: [{ from: 1, to: 20 }] },
          {
            path: "manual.typ",
            foldState: "user",
            foldRanges: [{ from: 2, to: 30 }]
          }
        ]
      }
    });

    expect(metadata.workspace.openTabs[0].foldState).toBeNull();
    expect(metadata.workspace.openTabs[0].foldRanges).toBeNull();
    expect(metadata.workspace.openTabs[1].foldState).toBe("user");
    expect(metadata.workspace.openTabs[1].foldRanges).toEqual([{ from: 2, to: 30 }]);
  });

  test("persists Draft Preview per workspace and migrates older state to Normal", () => {
    const draft = normalizeWorkspaceMetadata({
      project: null,
      workspace: { previewContentMode: "draft" }
    });
    const legacy = normalizeWorkspaceMetadata({
      project: null,
      workspace: { schemaVersion: 1 }
    });
    expect(draft.workspace.previewContentMode).toBe("draft");
    expect(draft.workspace.schemaVersion).toBe(2);
    expect(legacy.workspace.previewContentMode).toBe("normal");
  });

  test("persists preview refresh mode per workspace and leaves legacy state unset", () => {
    const onType = normalizeWorkspaceMetadata({
      project: null,
      workspace: { previewRenderMode: "on-type" }
    });
    const onSave = normalizeWorkspaceMetadata({
      project: null,
      workspace: { previewRenderMode: "on-save" }
    });
    const legacy = normalizeWorkspaceMetadata({
      project: null,
      workspace: { schemaVersion: 2 }
    });

    expect(onType.workspace.previewRenderMode).toBe("on-type");
    expect(onSave.workspace.previewRenderMode).toBe("on-save");
    expect(legacy.workspace.previewRenderMode).toBeNull();
  });

  test("normalizes the raw preview scroll position per workspace", () => {
    const stored = normalizeWorkspaceMetadata({
      project: null,
      workspace: { previewScrollTop: 4821.5 }
    });
    const invalid = normalizeWorkspaceMetadata({
      project: null,
      workspace: { previewScrollTop: -25 }
    });

    expect(stored.workspace.previewScrollTop).toBe(4821.5);
    expect(invalid.workspace.previewScrollTop).toBe(0);
  });

  test("normalizes independent preview positions for open tabs", () => {
    const stored = normalizeWorkspaceMetadata({
      project: null,
      workspace: {
        openTabs: [
          { path: "main.typ", previewScrollTop: 1832.5 },
          { path: "chapter.typ", previewScrollTop: -20 },
        ],
      },
    });

    expect(stored.workspace.openTabs.map(tab => tab.previewScrollTop)).toEqual([1832.5, 0]);
  });

  test("reads and removes legacy absolute-path state for one-time migration", () => {
    values.set("typsastra-workspace-C:/work", JSON.stringify({
      activeFilePath: "C:/work/main.typ",
      pinnedMainFilePath: "C:/work/main.typ",
      openTabs: []
    }));
    const store = new WorkspaceStateStore();
    expect(store.loadLegacy("C:/work")?.pinnedMainFilePath).toBe("C:/work/main.typ");
    store.removeLegacy("C:/work");
    expect(store.loadLegacy("C:/work")).toBeNull();
  });
});
