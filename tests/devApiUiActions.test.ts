import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");

describe("developer API UI actions", () => {
  test("exposes the current project, settings, and preview controls", async () => {
    const bindings = await Bun.file(join(root, "src", "ui", "appEventBindings.ts")).text();
    const app = await Bun.file(join(root, "src", "appController.ts")).text();
    const settings = await Bun.file(join(root, "src", "settingsController.ts")).text();
    const api = await Bun.file(join(root, "src-tauri", "src", "dev_log_api.rs")).text();

    expect(bindings).toContain('| { action: "project-templates" }');
    expect(bindings).toContain('action: "settings-open";');
    expect(bindings).toContain('| { action: "settings-close" }');
    expect(bindings).toContain('| { action: "preview-content-mode"; mode: PreviewContentMode }');
    expect(bindings).toContain('tool: "explorer" | "search" | "images" | "tables"');

    expect(app).toContain('case "project-templates":');
    expect(app).toContain('case "settings-open":');
    expect(app).toContain('case "settings-close":');
    expect(app).toContain('case "preview-content-mode":');
    expect(app).toContain('"typsastra:open-settings"');
    expect(app).toContain('"typsastra:close-settings"');
    expect(app).toContain("this.openProjectSearch(false)");
    expect(app).toContain("this.createProjectFromTemplate()");
    expect(app).toContain("this.draftPreviewController.changeMode(action.mode)");
    expect(settings).toContain('"typsastra:close-settings"');

    expect(api).toContain("Search,");
    expect(api).toContain("ProjectTemplates,");
    expect(api).toContain("SettingsOpen {");
    expect(api).toContain("SettingsClose,");
    expect(api).toContain("DevSettingsPanel");
    expect(api).toContain("PreviewContentMode {");
  });
});
