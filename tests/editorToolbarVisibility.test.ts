import { describe, expect, test } from "bun:test";
import { defaultAppSettings, normalizeAppSettings } from "../src/settings";

const indexHtml = () => Bun.file(new URL("../index.html", import.meta.url)).text();
const appController = () => Bun.file(new URL("../src/appController.ts", import.meta.url)).text();
const appEventBindings = () => Bun.file(new URL("../src/ui/appEventBindings.ts", import.meta.url)).text();

describe("editor toolbar visibility", () => {
  test("shows the toolbar by default and keeps an explicit hidden choice", () => {
    expect(defaultAppSettings.editor.visualToolbar).toBe(true);
    expect(normalizeAppSettings({}).editor.visualToolbar).toBe(true);
    expect(normalizeAppSettings({ editor: { visualToolbar: false } }).editor.visualToolbar).toBe(false);
    expect(normalizeAppSettings({ editor: { visualToolbar: "no" } }).editor.visualToolbar).toBe(true);
  });

  test("offers the View menu entry with its documented shortcut", async () => {
    const html = await indexHtml();
    const viewMenu = html.slice(
      html.indexOf('<div class="menu-label">View</div>'),
      html.indexOf('<div class="menu-label">Terminal</div>')
    );
    expect(viewMenu).toContain('id="action-toggle-editor-toolbar"');
    expect(viewMenu).toContain("Toggle Editor Toolbar");
    expect(viewMenu).toContain("Ctrl+Shift+T");
  });

  test("exposes the setting in the Editor settings panel", async () => {
    const html = await indexHtml();
    expect(html).toContain('id="settings-visual-toolbar"');

    const controller = await Bun.file(new URL("../src/settingsController.ts", import.meta.url)).text();
    expect(controller).toContain('onChange("settings-visual-toolbar"');
    expect(controller).toContain('setChecked("settings-visual-toolbar", editor.visualToolbar)');
  });

  test("routes the shortcut and the menu entry through the persisted setting", async () => {
    const bindings = await appEventBindings();
    expect(bindings).toContain("sequence.handle(event, actions.shortcuts(), isMac");
    expect(bindings).toContain("document.getElementById(appShortcut)?.click()");
    expect(bindings).toContain('document.getElementById("action-toggle-editor-toolbar")?.addEventListener("click", actions.toggleEditorToolbar)');

    const source = await appController();
    expect(source).toContain("settings.editor.visualToolbar = !settings.editor.visualToolbar");
    expect(source).toContain("this.editorToolbarController.setVisible(editor.visualToolbar)");
  });

  test("restores the toolbar with the default layout", async () => {
    const source = await appController();
    const restore = source.slice(
      source.indexOf("private restoreDefaultLayout()"),
      source.indexOf("private applySidebarVisibility()")
    );
    expect(restore).toContain("visualToolbar");
  });
});
