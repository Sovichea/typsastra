import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");

describe("developer API UI actions", () => {
  test("exposes the current project and preview controls", async () => {
    const bindings = await Bun.file(join(root, "src", "ui", "appEventBindings.ts")).text();
    const app = await Bun.file(join(root, "src", "appController.ts")).text();
    const api = await Bun.file(join(root, "src-tauri", "src", "dev_log_api.rs")).text();

    expect(bindings).toContain('| { action: "project-templates" }');
    expect(bindings).toContain('| { action: "preview-content-mode"; mode: PreviewContentMode }');
    expect(bindings).toContain('tool: "explorer" | "search" | "images" | "tables"');

    expect(app).toContain('case "project-templates":');
    expect(app).toContain('case "preview-content-mode":');
    expect(app).toContain("this.openProjectSearch(false)");
    expect(app).toContain("this.createProjectFromTemplate()");
    expect(app).toContain("this.draftPreviewController.changeMode(action.mode)");

    expect(api).toContain("Search,");
    expect(api).toContain("ProjectTemplates,");
    expect(api).toContain("PreviewContentMode {");
  });
});
