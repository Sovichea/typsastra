import { describe, expect, mock, test } from "bun:test";

const metadataPayloads: unknown[] = [];
mock.module("@tauri-apps/api/core", () => ({
  invoke: async (command: string) => {
    if (command === "load_workspace_metadata") return metadataPayloads.shift();
    return undefined;
  },
}));

const { WorkspaceController } = await import("../src/workspace/workspaceController");
type WorkspaceControllerPort = import("../src/workspace/workspaceController").WorkspaceControllerPort;

function controller(): InstanceType<typeof WorkspaceController> {
  const port: WorkspaceControllerPort = {
    ensureDockedPreviewVisible: () => {},
    applySidebarVisibility: () => {},
    pathKey: path => path.toLowerCase(),
    handleWorkspaceChange: async () => {},
    reportWatchError: () => {},
    persistActiveTabState: () => {},
    persistenceSnapshot: () => {
      throw new Error("Persistence is not used by loadMetadata tests.");
    },
    setWorkspaceMetadata: () => {},
    reportPersistenceError: () => {},
  };
  return new WorkspaceController(port);
}

describe("workspace metadata loading", () => {
  test("marks a project without stored or legacy metadata as first open", async () => {
    metadataPayloads.push({ project: null, workspace: null });

    const loaded = await controller().loadMetadata("C:/new-project");

    expect(loaded.firstOpen).toBe(true);
    expect(loaded.metadata.project.scriptLanguages).toEqual([]);
  });

  test("does not mark an existing project as first open", async () => {
    metadataPayloads.push({
      project: {
        schemaVersion: 2,
        projectId: "project-1",
        mainFile: "main.typ",
        scriptLanguages: [],
      },
      workspace: {
        schemaVersion: 2,
        activeFile: "main.typ",
      },
    });

    const loaded = await controller().loadMetadata("C:/existing-project");

    expect(loaded.firstOpen).toBe(false);
    expect(loaded.metadata.project.projectId).toBe("project-1");
  });
});
