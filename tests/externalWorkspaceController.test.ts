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
});
