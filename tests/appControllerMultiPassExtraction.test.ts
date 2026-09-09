import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const app = readFileSync(join(root, "src", "appController.ts"), "utf8");
const files = [
  join(root, "src", "editor", "editorTabActivationController.ts"),
  join(root, "src", "editor", "editorInitializationController.ts"),
  join(root, "src", "preview", "previewWindowController.ts"),
  join(root, "src", "workspace", "pinnedMainFileController.ts"),
  join(root, "src", "toolchain", "toolchainSetupController.ts"),
  join(root, "src", "settingsRuntimeController.ts"),
];
const extracted = files.map(file => readFileSync(file, "utf8"));

describe("appController multi-pass extraction", () => {
  test("keeps root methods as narrow delegates for moved workflows", () => {
    expect(app).toContain("return this.editorTabActivationController.activate(path, persistCurrent, options)");
    expect(app).toContain("return this.previewWindowController.bootstrap()");
    expect(app).toContain("return this.pinnedMainFileController.set(path)");
    expect(app).toContain("return this.toolchainSetupController.show()");
    expect(app).toContain("this.settingsRuntimeController.apply(settings)");
    expect(app).toContain("const initialized = this.editorInitializationController.initialize()");
  });

  test("uses explicit dependency interfaces without untyped host adapters", () => {
    for (const source of extracted) {
      expect(source).toContain("export interface ");
      expect(source).not.toContain(": any");
      expect(source).not.toContain("host: object");
      expect(source).not.toContain("new Proxy(");
    }
  });

  test("moves state with the owning workflows", () => {
    expect(extracted[1]).toContain("private isComposing = false");
    expect(extracted[5]).toContain("private _forwardSyncDebounceMs = 120");
    expect(extracted[5]).toContain("private _lastPreviewRenderMode");
    expect(extracted[5]).not.toContain("private _lastKhmerRenderPrepState");
  });
});
