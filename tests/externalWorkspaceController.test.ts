import { describe, expect, test } from "bun:test";
import { ExternalWorkspaceController } from "../src/workspace/externalWorkspaceController";

describe("external workspace diagnostics", () => {
  test("invalidates the previous diagnostic snapshot before refreshing an accepted change", async () => {
    const events: string[] = [];
    const controller = new ExternalWorkspaceController({
      workspaceRoot: () => "C:\\Project",
      pathKey: path => path.replace(/\\/g, "/").toLowerCase(),
      openTabPaths: () => [],
      conflictPaths: () => new Set(),
      managedPathKeys: () => new Set(),
      reloadOpenFiles: async () => false,
      pathsExist: async paths => paths.map(() => true),
      lspClient: () => undefined,
      lspReady: () => false,
      loadExplorer: async () => { events.push("explorer"); },
      refreshImageTools: () => {},
      refreshTableDirectives: () => { events.push("table-directives"); },
      imageToolsActive: () => false,
      clearDiagnostics: () => { events.push("diagnostics"); },
      retireSourceMap: async () => { events.push("source-map"); },
      refreshPreview: async () => { events.push("preview"); },
      waitForPreviewRefresh: async () => { events.push("settled"); },
      setRefreshPending: () => {},
      updateForwardSyncAction: () => {},
      log: () => {},
    });

    await controller.handleChange({
      rootPath: "C:\\Project",
      kind: "modify",
      paths: ["C:\\Project\\main.typ"],
    });

    expect(events).toEqual(["diagnostics", "source-map", "explorer", "table-directives", "preview", "settled"]);
  });

  test("reports an atomic replacement as changed when the watcher labels it removed", async () => {
    const notifiedTypes: number[] = [];
    const warnings: string[] = [];
    const client = {
      notifyWorkspaceFilesChanged: async (changes: Array<{ uri: string; type: 1 | 2 | 3 }>) => {
        notifiedTypes.push(...changes.map(change => change.type));
      },
    } as unknown as import("../src/compiler/lsp").TinymistLspClient;
    const controller = new ExternalWorkspaceController({
      workspaceRoot: () => "C:\\Project",
      pathKey: path => path.replace(/\\/g, "/").toLowerCase(),
      openTabPaths: () => [],
      conflictPaths: () => new Set(),
      managedPathKeys: () => new Set(),
      reloadOpenFiles: async () => false,
      pathsExist: async paths => paths.map(path => path.endsWith("main.typ")),
      lspClient: () => client,
      lspReady: () => true,
      loadExplorer: async () => {},
      refreshImageTools: () => {},
      refreshTableDirectives: () => {},
      imageToolsActive: () => false,
      clearDiagnostics: () => {},
      retireSourceMap: async () => {},
      refreshPreview: async () => {},
      waitForPreviewRefresh: async () => {},
      setRefreshPending: () => {},
      updateForwardSyncAction: () => {},
      log: (kind, message) => {
        if (kind === "warning") warnings.push(message);
      },
    });

    await controller.handleChange({
      rootPath: "C:\\Project",
      kind: "remove",
      paths: ["C:\\Project\\main.typ"],
    });

    expect(notifiedTypes).toEqual([2]);
    expect(warnings[0]).toContain("Watcher reported removal for a path that exists");
  });

  test("maps a rename pair from current disk state instead of event ordering", async () => {
    const notifiedTypes: number[] = [];
    const client = {
      notifyWorkspaceFilesChanged: async (changes: Array<{ uri: string; type: 1 | 2 | 3 }>) => {
        notifiedTypes.push(...changes.map(change => change.type));
      },
    } as unknown as import("../src/compiler/lsp").TinymistLspClient;
    const controller = new ExternalWorkspaceController({
      workspaceRoot: () => "C:\\Project",
      pathKey: path => path.replace(/\\/g, "/").toLowerCase(),
      openTabPaths: () => [],
      conflictPaths: () => new Set(),
      managedPathKeys: () => new Set(),
      reloadOpenFiles: async () => false,
      pathsExist: async paths => paths.map(path => path.endsWith("new.typ")),
      lspClient: () => client,
      lspReady: () => true,
      loadExplorer: async () => {},
      refreshImageTools: () => {},
      refreshTableDirectives: () => {},
      imageToolsActive: () => false,
      clearDiagnostics: () => {},
      retireSourceMap: async () => {},
      refreshPreview: async () => {},
      waitForPreviewRefresh: async () => {},
      setRefreshPending: () => {},
      updateForwardSyncAction: () => {},
      log: () => {},
    });

    await controller.handleChange({
      rootPath: "C:\\Project",
      kind: "rename",
      paths: ["C:\\Project\\old.typ", "C:\\Project\\new.typ"],
    });

    expect(notifiedTypes).toEqual([3, 1]);
  });
});
