import { describe, expect, test } from "bun:test";

/**
 * Standalone documents have no project, so the editor gutter actions that open
 * the Image and Table tools must early-return instead of reaching a tool that
 * expects a workspace.
 */
describe("standalone document guards", () => {
  const read = () => Bun.file(new URL("../src/appController.ts", import.meta.url)).text();

  function body(source: string, startMarker: string, endMarker: string): string {
    const start = source.indexOf(startMarker);
    expect(start).toBeGreaterThanOrEqual(0);
    const end = source.indexOf(endMarker, start + startMarker.length);
    expect(end).toBeGreaterThan(start);
    return source.slice(start, end);
  }

  test("editor redirects to the image and table tools do nothing without a project", async () => {
    const controller = await read();
    expect(body(controller, "private async navigateToImageTool", "private navigateToTableTool"))
      .toContain("if (this.standaloneFilePath !== null) return;");
    expect(body(controller, "private navigateToTableTool", "private handleTablesChanged"))
      .toContain("if (this.standaloneFilePath !== null) return;");
    expect(body(controller, "private handleTableDirectiveAction", "private recreateTableDirective"))
      .toContain("if (this.standaloneFilePath !== null) return;");
  });

  test("the project table scan is skipped for a standalone file", async () => {
    const controller = await read();
    expect(body(controller, "public async refreshTableDirectiveIndex", "private tableLinkFor"))
      .toContain("if (this.standaloneFilePath !== null)");
  });
});
