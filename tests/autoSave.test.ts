import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const controller = readFileSync(new URL("../src/appController.ts", import.meta.url), "utf8");
const persistence = readFileSync(new URL("../src/editor/documentPersistenceController.ts", import.meta.url), "utf8");
const settingsUi = readFileSync(new URL("../index.html", import.meta.url), "utf8");

describe("auto save", () => {
  test("exposes an enabled setting and bounded interval control", () => {
    expect(settingsUi).toContain('id="settings-auto-save"');
    expect(settingsUi).toContain('id="settings-auto-save-interval"');
    expect(settingsUi).toContain('min="5"');
    expect(settingsUi).toContain('max="300"');
  });

  test("automatic persistence does not notify Tinymist or render preview", () => {
    const start = persistence.indexOf("private async performAutoSave");
    const end = persistence.indexOf("private async performSaveActiveFile", start);
    const method = persistence.slice(start, end);

    expect(method).toContain('invoke("save_workspace_file"');
    expect(method).not.toContain("notifyTextSave");
    expect(method).not.toContain("renderPdfPreview");
  });

  test("manual save renders even when auto-save already cleared the dirty state", () => {
    const start = persistence.indexOf("private async performSaveActiveFile");
    const end = persistence.indexOf("private canPersistPath", start);
    const method = persistence.slice(start, end);

    expect(method).toContain('intent === "manual"');
    expect(method).toContain("isTypstDocumentPath(activeFilePath)");
    expect(method).toContain("this.deps.refreshPreviewAfterManualSave(activeFilePath, content)");
    expect(controller).toContain("previewContentController.refreshActivePreviewRoot(true)");
    expect(method).not.toContain("savedChangedRevision &&");
  });
});
