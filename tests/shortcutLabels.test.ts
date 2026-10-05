import { describe, expect, test } from "bun:test";
import { formatShortcut, isMacShortcutPlatform, shortcutLabel } from "../src/platform/shortcuts";

const macUserAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15";
const windowsUserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";
const linuxUserAgent = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36";

describe("platform shortcut labels", () => {
  test("renders the primary accelerator per platform", () => {
    expect(formatShortcut("Mod+S", false)).toBe("Ctrl+S");
    expect(formatShortcut("Mod+S", true)).toBe("Cmd+S");
    expect(formatShortcut("Mod+Shift+T", false)).toBe("Ctrl+Shift+T");
    expect(formatShortcut("Mod+Shift+T", true)).toBe("Cmd+Shift+T");
    expect(formatShortcut("Mod+a", false)).toBe("Ctrl+A");
    expect(formatShortcut("Ctrl+b", true)).toBe("Control+B");
    expect(formatShortcut("Alt+l", false)).toBe("Alt+L");
    expect(formatShortcut("Mod+Backquote", false)).toBe("Ctrl+`");
  });

  test("names Alt as Option and Ctrl as Control on macOS only", () => {
    expect(formatShortcut("Alt+Z", false)).toBe("Alt+Z");
    expect(formatShortcut("Alt+Z", true)).toBe("Option+Z");
    expect(formatShortcut("Ctrl+Enter", false)).toBe("Ctrl+Enter");
    expect(formatShortcut("Ctrl+Enter", true)).toBe("Control+Enter");
  });

  test("keeps chords and punctuation keys intact", () => {
    expect(formatShortcut("Mod+K O", false)).toBe("Ctrl+K, O");
    expect(formatShortcut("Mod+K Mod+O", true)).toBe("Cmd+K, Cmd+O");
    expect(formatShortcut("Mod+K O", false)).toBe("Ctrl+K, O");
    expect(formatShortcut("Mod+,", true)).toBe("Cmd+,");
    expect(formatShortcut("Mod+`", true)).toBe("Cmd+`");
  });

  test("supports a different macOS binding, not only a renamed modifier", () => {
    expect(shortcutLabel("Mod+Y", "Mod+Shift+Z", false)).toBe("Ctrl+Y");
    expect(shortcutLabel("Mod+Y", "Mod+Shift+Z", true)).toBe("Cmd+Shift+Z");
  });

  test("detects macOS from the runtime titlebar platform signals", () => {
    expect(isMacShortcutPlatform({ userAgent: macUserAgent, platform: "MacIntel" })).toBe(true);
    expect(isMacShortcutPlatform({ userAgent: windowsUserAgent, platform: "Win32" })).toBe(false);
    expect(isMacShortcutPlatform({ userAgent: linuxUserAgent, platform: "Linux x86_64" })).toBe(false);
  });

  test("follows the macOS layout simulation used by the dev command", () => {
    expect(isMacShortcutPlatform({
      userAgent: windowsUserAgent,
      platform: "Win32",
      search: "?test-platform=macos-titlebar",
      dev: true
    })).toBe(true);
  });
});

describe("shortcut label markup", () => {
  const indexHtml = () => Bun.file(new URL("../index.html", import.meta.url)).text();

  test("declares every menu hotkey as a platform-neutral spec", async () => {
    const html = await indexHtml();
    const menus = html.slice(html.indexOf('id="app-menus"'), html.indexOf('class="titlebar-center"'));
    const hotkeys = menus.match(/<span class="hotkey"[^>]*>/g) ?? [];

    expect(hotkeys.length).toBeGreaterThan(0);
    for (const hotkey of hotkeys) expect(hotkey).toContain("data-shortcut=");
  });

  test("authors Windows and Linux text as the static fallback", async () => {
    const html = await indexHtml();
    expect(html).toContain('data-shortcut="Mod+B">Ctrl+B<');
    expect(html).toContain('data-shortcut="Mod+Shift+T">Ctrl+Shift+T<');
    expect(html).toContain('data-shortcut="Mod+O">Ctrl+O<');
    expect(html).not.toContain('data-shortcut="Mod+K Mod+O"');
  });

  test("labels redo with its real macOS binding", async () => {
    const html = await indexHtml();
    expect(html).toContain('data-shortcut="Mod+Y" data-shortcut-mac="Mod+Shift+Z"');
  });

  test("renders shortcut-bearing titles from a template", async () => {
    const html = await indexHtml();
    expect(html).toContain('data-shortcut-title="Open Settings ({})"');
  });
});
