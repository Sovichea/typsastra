import { describe, expect, test } from "bun:test";
import { ExternalWorkspaceController, type ExternalWorkspaceControllerPort } from "../src/workspace/externalWorkspaceController";

function fixture(overrides: Partial<ExternalWorkspaceControllerPort> = {}) {
  const events: string[] = [];
  const controller = new ExternalWorkspaceController({
    workspaceRoot: () => "C:/Project",
    pathKey: path => path.replace(/\\/g, "/").toLowerCase(),
    conflictPaths: () => new Set(),
    managedPathKeys: () => new Set(),
    reloadChangedAssets: async paths => { events.push(`assets:${paths.join(",")}`); },
    loadExplorer: async () => { events.push("explorer"); },
    markImageToolsStale: () => { events.push("image-index"); },
    refreshImageTools: () => { events.push("images"); },
    refreshTableDirectives: () => { events.push("tables"); },
    imageToolsActive: () => false,
    log: () => {},
    ...overrides,
  });
  return { controller, events };
}

describe("external workspace tools", () => {
  test("refreshes tools without coupling file events to PDF compilation or LSP saves", async () => {
    const { controller, events } = fixture();
    await controller.handleChange({ rootPath: "C:/Project", kind: "modify", paths: ["C:/Project/main.typ"] });
    expect(events).toEqual(["image-index", "assets:C:/Project/main.typ", "explorer", "tables"]);
  });

  test("ignores other workspaces and private cache writes", async () => {
    const { controller, events } = fixture();
    await controller.handleChange({ rootPath: "C:/Other", kind: "modify", paths: ["C:/Other/main.typ"] });
    await controller.handleChange({ rootPath: "C:/Project", kind: "modify", paths: ["C:/Project/.typsastra/cache/main.typ"] });
    expect(events).toEqual([]);
  });

  test("excludes application-managed PDFs and conflicted paths", async () => {
    const { controller, events } = fixture({
      managedPathKeys: () => new Set(["c:/project/main.pdf"]),
      conflictPaths: () => new Set(["c:/project/main.typ"]),
    });
    await controller.handleChange({ rootPath: "C:/Project", kind: "modify", paths: ["C:/Project/main.pdf"] });
    expect(events).toEqual([]);
    await controller.handleChange({ rootPath: "C:/Project", kind: "modify", paths: ["C:/Project/main.typ"] });
    expect(events).toEqual(["explorer"]);
  });

  test("refreshes visible image tools after external asset edits", async () => {
    const { controller, events } = fixture({ imageToolsActive: () => true });
    await controller.handleChange({ rootPath: "C:/Project", kind: "create", paths: ["C:/Project/cover.png"] });
    expect(events).toEqual(["image-index", "assets:C:/Project/cover.png", "explorer", "images", "tables"]);
  });
});
