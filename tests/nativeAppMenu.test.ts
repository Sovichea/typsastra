import { describe, expect, test } from "bun:test";
import {
  buildNativeMenuSpec,
  nativeAppMenuOwnsShortcuts,
  nativeMenuElementIds,
  setNativeAppMenuInstalled,
  workspaceScopedMenuIds,
} from "../src/platform/nativeAppMenuSpec";
import { menuAccelerator } from "../src/platform/nativeAppMenu";

async function source(path: string): Promise<string> {
  return Bun.file(new URL(path, import.meta.url)).text();
}

const acceleratorPattern = /^(CmdOrCtrl|Alt|Shift)(\+(CmdOrCtrl|Alt|Shift))*\+[^+]+$/;

test("native menus own one stroke; application chords stay in the WebView dispatcher", () => {
  expect(menuAccelerator("Mod-K")).toBe("CmdOrCtrl+K");
  expect(menuAccelerator("Mod-K O")).toBeUndefined();
});

const expectedWorkspaceScoped = [
  "action-new-file",
  "action-save-file",
  "action-save-file-as",
  "action-export-pdf",
  "action-export-project",
  "action-export-source-zip",
  "action-restart-workspace",
  "action-close-project",
  "action-format-document",
  "action-fold-file",
  "action-unfold-file",
  "action-toggle-sidebar",
  "action-toggle-editor-toolbar",
  "action-restore-default-layout",
];

const spec = buildNativeMenuSpec("Typsastra");

describe("native application menu spec", () => {
  test("builds seven submenus in macOS order", () => {
    expect(spec.map(submenu => submenu.label)).toEqual([
      "Typsastra",
      "File",
      "Edit",
      "View",
      "Terminal",
      "Window",
      "Help",
    ]);
    expect(spec.map(submenu => submenu.role)).toEqual([
      "app",
      undefined,
      undefined,
      undefined,
      undefined,
      "window",
      "help",
    ]);
  });

  test("labels the app menu with the product-name argument", () => {
    expect(buildNativeMenuSpec("Typsastra Dev")[0].label).toBe("Typsastra Dev");
  });

  test("declares only well-formed, non-bare accelerators", () => {
    for (const submenu of spec) {
      for (const node of submenu.nodes) {
        if ("accelerator" in node && node.accelerator !== undefined) {
          expect(node.accelerator).toMatch(acceleratorPattern);
          expect(node.accelerator).not.toMatch(/^(CmdOrCtrl|Alt|Shift)$/);
        }
      }
    }
  });

  test("scopes exactly the fourteen workspace-dependent menu ids", () => {
    expect(workspaceScopedMenuIds(spec)).toEqual(expectedWorkspaceScoped);
  });

  test("keeps the dynamic recent projects entry accelerator-free", () => {
    const fileMenu = spec.find(submenu => submenu.label === "File");
    expect(fileMenu?.nodes[3]).toEqual({ kind: "recent-placeholder" });
    for (const submenu of spec) {
      for (const node of submenu.nodes) {
        if (node.kind === "recent-placeholder") {
          expect("accelerator" in node).toBe(false);
        }
      }
    }
  });

  test("routes select-all instead of invoking the global native role", async () => {
    const editMenu = spec.find(submenu => submenu.label === "Edit");
    expect(editMenu?.nodes).toContainEqual({
      kind: "item",
      id: "action-select-all",
      label: "Select All",
      accelerator: "CmdOrCtrl+A",
      elementId: "action-select-all",
    });
    expect(editMenu?.nodes).not.toContainEqual({
      kind: "predefined",
      item: "SelectAll",
      text: "Select All",
    });

    const events = await source("../src/ui/appEventBindings.ts");
    const app = await source("../src/appController.ts");
    expect(events).toContain('keyCode === "KeyA"');
    expect(events).toContain('closest("input,textarea,[contenteditable]")');
    expect(events).toContain('getElementById("action-select-all")');
    expect(app).toContain("selectAllActiveSurface:");
    expect(app).toContain('active?.closest(".cm-editor")');
    expect(app).toContain("this.previewFrame.selectAllText()");
  });

  test("tracks the installed state behind a Tauri-free flag", () => {
    expect(nativeAppMenuOwnsShortcuts()).toBe(false);
    setNativeAppMenuInstalled(true);
    expect(nativeAppMenuOwnsShortcuts()).toBe(true);
    setNativeAppMenuInstalled(false);
    expect(nativeAppMenuOwnsShortcuts()).toBe(false);
  });
});

describe("native menu element drift", () => {
  test("every spec element exists in the markup and is bound", async () => {
    const html = await source("../index.html");
    const events = await source("../src/ui/appEventBindings.ts");
    const settings = await source("../src/settingsController.ts");

    for (const elementId of nativeMenuElementIds(spec)) {
      expect(html).toContain(`id="${elementId}"`);
      const boundInEvents = events.includes(`getElementById("${elementId}")`);
      const boundInSettings = settings.includes(`getElementById("${elementId}")`);
      expect(boundInEvents || boundInSettings).toBe(true);
    }
  });

  test("every bound menu action is in the spec or consciously omitted", async () => {
    const events = await source("../src/ui/appEventBindings.ts");
    const bound = new Set(
      [...events.matchAll(/getElementById\("(action-[a-z-]+)"\)/g)].map(match => match[1])
    );
    const specIds = new Set(nativeMenuElementIds(spec));
    const omissionAllowlist = new Map([
      ["action-undo", "Predefined Edit role"],
      ["action-redo", "Predefined Edit role"],
      ["action-exit", "Custom Quit item"],
      ["action-open-recent", "HTML-only trigger"],
    ]);

    for (const id of bound) {
      if (specIds.has(id)) continue;
      expect(omissionAllowlist.has(id)).toBe(true);
    }
    expect(bound.size).toBeGreaterThan(0);
  });

  test("does not port the retired layout toggle", () => {
    expect(JSON.stringify(spec)).not.toContain("action-toggle-layout");
  });
});

describe("native menu installation drift", () => {
  test("guards against the macOS titlebar simulation and preview mode", async () => {
    const native = await source("../src/platform/nativeAppMenu.ts");
    expect(native).toContain("!state.simulated");
    expect(native).toContain('get("mode") !== "preview"');
  });

  test("reveals the HTML bar only after a successful install", async () => {
    const native = await source("../src/platform/nativeAppMenu.ts");
    const css = await source("../src/style.css");
    expect(native).toContain('classList.add("native-app-menu")');
    expect(native).toContain("setNativeAppMenuInstalled(true)");
    expect(css).toMatch(/html\.native-app-menu #app-menus\s*\{\s*display:\s*none\s*!important;/);
  });

  test("keeps the HTML menu bar as the Windows and Linux fallback", async () => {
    const html = await source("../index.html");
    expect(html).toContain('id="app-menus"');
  });

  test("gates JavaScript shortcuts once the native menu owns them", async () => {
    const events = await source("../src/ui/appEventBindings.ts");
    const specSource = await source("../src/platform/nativeAppMenuSpec.ts");

    expect(specSource).toContain("export function nativeAppMenuOwnsShortcuts");
    expect(events).toContain('!nativeAppMenuOwnsShortcuts() || shortcutStrokes(shortcutFor(appShortcut, actions.shortcuts(), isMac)).length === 2');
  });

  test("reconfigures native accelerators as shortcuts change", async () => {
    const nativeMenu = await source("../src/platform/nativeAppMenu.ts");
    expect(nativeMenu).toContain("this.queueAccelerator(id, menuAccelerator(value) ?? null)");
    expect(nativeMenu).toContain("setShortcutCaptureActive(active: boolean)");
    expect(nativeMenu).toContain("shortcutFor(node.id, deps.shortcuts(), true)");
  });

  test("gates the settings accelerator without disabling Escape-to-close", async () => {
    const settings = await source("../src/settingsController.ts");
    const events = await source("../src/ui/appEventBindings.ts");
    expect(events).toContain("sequence.handle(event, actions.shortcuts(), isMac");
    expect(events).toContain('appShortcut?.startsWith("action-")');
    // Escape must stay ungated so the dialog still closes under a native menu.
    const escapeBranch = settings.split("\n").find(line => line.includes('event.key === "Escape"'));
    expect(escapeBranch).toBeDefined();
    expect(escapeBranch).not.toContain("nativeAppMenuOwnsShortcuts()");
  });

  test("restores focus safely when the About trigger is hidden by a native menu", async () => {
    const events = await source("../src/ui/appEventBindings.ts");
    const bindAbout = events.slice(
      events.indexOf("function bindAboutDialog()"),
      events.indexOf("function bindMenuDropdowns()")
    );
    expect(bindAbout).toContain("getClientRects().length > 0");
    expect(bindAbout).toContain("focusBeforeAbout");
    expect(bindAbout).not.toMatch(/\n\s*aboutAction\?\.focus\(\);/);
  });
});
