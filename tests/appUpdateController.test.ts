import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../src/appUpdateController.ts", import.meta.url), "utf8");
const app = readFileSync(new URL("../src/appController.ts", import.meta.url), "utf8");
const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

describe("staged application updates", () => {
  test("downloads before offering an explicit restart", () => {
    expect(source).toContain("await this.update.download(event =>");
    expect(source).not.toContain("downloadAndInstall");
    expect(source).toContain('this.badge.textContent = "Restart to update"');
    expect(source).toContain("await this.update.install()");
    expect(source).toContain("if (relaunchAfterInstall) await relaunch()");
  });

  test("integrates the staged update with controlled application shutdown", () => {
    expect(app).toContain("proceed = await this.appUpdateController.prepareForClose()");
    expect(html).toContain('id="app-dialog-action-start"');
    expect(html).toContain('id="app-dialog-action-middle"');
    expect(html).toContain('id="app-dialog-action-end"');
    expect(html).toContain('aria-labelledby="app-dialog-title"');
    expect(source).not.toContain("@tauri-apps/plugin-dialog");
    expect(app).toContain("this.appDialogController.show({");
  });

  test("provides a direct local development command", () => {
    expect(packageJson.scripts["dev:update"]).toBe("bun run tauri:dev:update");
    expect(packageJson.scripts["tauri:dev:update"]).toContain("tauri.update-test.conf.json");
  });
});
