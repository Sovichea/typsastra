import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { cloneDefaultAppSettings, defaultAppSettings, normalizeAppSettings } from "../src/settings";

const settingsHtml = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const settingsController = readFileSync(new URL("../src/settingsController.ts", import.meta.url), "utf8");
const settingsStyles = readFileSync(new URL("../src/style.css", import.meta.url), "utf8");

describe("application settings", () => {
  test("fills missing values from defaults", () => {
    const settings = normalizeAppSettings({ appearance: { theme: "nord" } });

    expect(settings.appearance.theme).toBe("nord");
    expect(settings.developerMode).toBe(false);
    expect(settings.developerLogs).toEqual(defaultAppSettings.developerLogs);
    expect(settings.editor.codeFont).toBe("Fira Mono");
    expect(settings.editor.unicodeFont).toBe("auto");
    expect(settings.editor.unicodeFonts).toEqual({});
    expect(settings.editor.wordWrap).toBe(defaultAppSettings.editor.wordWrap);
    expect(settings.editor.spellcheck).toBe(true);
    expect(settings.editor.wordCompletion).toBe(true);
    expect(settings.editor.showZws).toBe(true);
    expect(settings.editor.userDictionary).toEqual([]);
    expect(settings.editor.ignoredWords).toEqual([]);
    expect(settings.editor.formatOnSave).toBe(false);
    expect(settings.editor.autoSave).toBe(true);
    expect(settings.editor.autoSaveIntervalSeconds).toBe(30);
    expect(settings.preview.renderMode).toBe("on-save");
    expect(settings.preview.colorMode).toBe("document");
    expect(settings.preview.syncDebounceMs).toBe(defaultAppSettings.preview.syncDebounceMs);
    expect(settings.preview.forwardSyncTimeoutMs).toBe(5000);
    expect(settings.compatibility.disableWebkitDmabufRenderer).toBe(false);
    expect(settings.fonts.privateDirectories).toEqual([]);
    expect(settings.toolchain.tinymistVersion).toBeNull();
    expect(settings.toolchain.enhancedUnicodeEngineEnabled).toBe(false);
    expect(settings.toolchain.enhancedUnicodeEnginePath).toBeNull();
  });

  test("drops the retired Khmer render-preparation setting", () => {
    const settings = normalizeAppSettings({ preview: { khmerRenderPreparation: true } });

    expect("khmerRenderPreparation" in settings.preview).toBe(false);
  });

  test("rejects unsupported enums and clamps numeric values", () => {
    const settings = normalizeAppSettings({
      developerMode: true,
      appearance: { theme: "unknown", editorFontSize: 80, editorLineHeight: 0.5 },
      editor: { tabSize: 3, codeFont: "MiSans Latin", unicodeFont: "unknown-font" },
      preview: {
        renderMode: "sometimes",
        colorMode: "sepia",
        syncDebounceMs: 1,
        forwardSyncTimeoutMs: 50000,
        highlightDurationMs: 50000
      },
      toolchain: { tinymistVersion: "0.15.1-rc.1" }
    });

    expect(settings.appearance.theme).toBe("default");
    expect(settings.developerMode).toBe(true);
    expect(settings.appearance.editorFontSize).toBe(32);
    expect(settings.appearance.editorLineHeight).toBe(1.2);
    expect(settings.editor.tabSize).toBe(2);
    expect(settings.editor.codeFont).toBe("MiSans Latin");
    expect(settings.editor.unicodeFont).toBe("unknown-font");
    expect(settings.editor.formatOnSave).toBe(false);
    expect(settings.editor.autoSaveIntervalSeconds).toBe(30);
    expect(settings.preview.syncDebounceMs).toBe(50);
    expect(settings.preview.forwardSyncTimeoutMs).toBe(30000);
    expect(settings.preview.highlightDurationMs).toBe(10000);
    expect(settings.preview.renderMode).toBe("on-save");
    expect(settings.preview.colorMode).toBe("document");
    expect(settings.toolchain.tinymistVersion).toBeNull();
  });

  test("keeps a selected stable Tinymist version", () => {
    expect(normalizeAppSettings({ toolchain: { tinymistVersion: "0.15.2" } }).toolchain.tinymistVersion).toBe("0.15.2");
  });

  test("migrates the former Typst version selection", () => {
    expect(normalizeAppSettings({ toolchain: { typstVersion: "0.14.2" } }).toolchain.tinymistVersion).toBe("0.14.2");
  });

  test("keeps a validated local enhanced Unicode engine selection", () => {
    const settings = normalizeAppSettings({
      toolchain: {
        enhancedUnicodeEngineEnabled: true,
        enhancedUnicodeEnginePath: " C:\\Tools\\typst-unicode.exe ",
      },
    });

    expect(settings.toolchain.enhancedUnicodeEngineEnabled).toBe(true);
    expect(settings.toolchain.enhancedUnicodeEnginePath).toBe("C:\\Tools\\typst-unicode.exe");
  });

  test("rejects unsafe enhanced Unicode engine paths", () => {
    const settings = normalizeAppSettings({
      toolchain: {
        enhancedUnicodeEngineEnabled: true,
        enhancedUnicodeEnginePath: "C:\\Tools\\typst.exe\n--help",
      },
    });

    expect(settings.toolchain.enhancedUnicodeEngineEnabled).toBe(false);
    expect(settings.toolchain.enhancedUnicodeEnginePath).toBeNull();
  });

  test("clamps the auto-save interval", () => {
    expect(normalizeAppSettings({ editor: { autoSaveIntervalSeconds: 1 } }).editor.autoSaveIntervalSeconds).toBe(5);
    expect(normalizeAppSettings({ editor: { autoSaveIntervalSeconds: 900 } }).editor.autoSaveIntervalSeconds).toBe(300);
  });

  test("keeps Typsastra green light and dark theme selections", () => {
    expect(normalizeAppSettings({ appearance: { theme: "typsastraLight" } }).appearance.theme).toBe("typsastraLight");
    expect(normalizeAppSettings({ appearance: { theme: "typsastraDark" } }).appearance.theme).toBe("typsastraDark");
  });

  test("keeps independent per-script editor fallbacks", () => {
    const settings = normalizeAppSettings({ editor: {
      unicodeFont: "auto",
      unicodeFonts: { "mi-sans-khmer": "Noto Sans Khmer", "mi-sans-lao": "none" }
    } });
    expect(settings.editor.unicodeFonts).toEqual({
      "mi-sans-khmer": "Noto Sans Khmer",
      "mi-sans-lao": "none"
    });
  });

  test("keeps developer log category selections independently", () => {
    const settings = normalizeAppSettings({
      developerMode: true,
      developerLogs: {
        preview: false,
        inverseSync: true,
        forwardSync: false,
        performance: false,
        memory: true,
        lsp: false,
        spellcheck: false,
        general: true
      }
    });

    expect(settings.developerLogs).toEqual({
      preview: false,
      inverseSync: true,
      forwardSync: false,
      performance: false,
      memory: true,
      lsp: false,
      spellcheck: false,
      general: true
    });
  });

  test("returns independent default objects", () => {
    const first = cloneDefaultAppSettings();
    const second = cloneDefaultAppSettings();
    first.editor.wordWrap = false;
    first.developerMode = true;
    first.developerLogs.memory = false;

    expect(second.editor.wordWrap).toBe(true);
    expect(second.developerMode).toBe(false);
    expect(second.developerLogs.memory).toBe(true);
  });

  test("preserves both supported preview render modes", () => {
    expect(normalizeAppSettings({ preview: { renderMode: "on-save" } }).preview.renderMode).toBe("on-save");
    expect(normalizeAppSettings({ preview: { renderMode: "on-type" } }).preview.renderMode).toBe("on-type");
  });

  test("preserves supported preview color modes", () => {
    expect(normalizeAppSettings({ preview: { colorMode: "document" } }).preview.colorMode).toBe("document");
    expect(normalizeAppSettings({ preview: { colorMode: "dark" } }).preview.colorMode).toBe("dark");
    expect(normalizeAppSettings({ preview: { colorMode: "inverted" } }).preview.colorMode).toBe("inverted");
  });

  test("keeps the Linux WebKit DMA-BUF compatibility override", () => {
    expect(normalizeAppSettings({
      compatibility: { disableWebkitDmabufRenderer: true }
    }).compatibility.disableWebkitDmabufRenderer).toBe(true);
  });

  test("normalizes global private font directories without duplicating paths", () => {
    const settings = normalizeAppSettings({
      fonts: {
        privateDirectories: [
          " C:\\Fonts\\Research ",
          "c:\\fonts\\research\\",
          "/home/author/fonts",
          "",
          42
        ]
      }
    });

    expect(settings.fonts.privateDirectories).toEqual([
      "C:\\Fonts\\Research",
      "/home/author/fonts"
    ]);
  });

  test("normalizes and deduplicates personal dictionary words", () => {
    const settings = normalizeAppSettings({
      editor: { wordCompletion: false, userDictionary: [" សាលា ", "សាលា", "", 42] }
    });
    expect(settings.editor.wordCompletion).toBe(false);
    expect(settings.editor.userDictionary).toEqual(["សាលា"]);
  });

  test("normalizes and deduplicates ignored words", () => {
    const settings = normalizeAppSettings({
      editor: { ignoredWords: [" ខ្មេ ", "ខ្មេ", "", 42] }
    });
    expect(settings.editor.ignoredWords).toEqual(["ខ្មេ"]);
  });
});

describe("editor settings presentation", () => {
  test("collapses per-script editor fallbacks by default", () => {
    expect(settingsHtml).toContain('<details class="settings-field settings-unicode-fonts-field settings-disclosure">');
    expect(settingsHtml).toContain("<summary>Per-script editor fallbacks</summary>");
    expect(settingsHtml).not.toContain('<details open class="settings-field settings-unicode-fonts-field settings-disclosure">');
  });

  test("shows and lazily populates the language provider catalog by default", () => {
    const catalogStart = settingsHtml.indexOf('id="settings-language-catalog"');
    const catalogEnd = settingsHtml.indexOf(">", catalogStart);
    const catalogMarkup = settingsHtml.slice(catalogStart, catalogEnd);
    const ensureStart = settingsController.indexOf("private async ensureLanguageCatalogPopulated");
    const ensureEnd = settingsController.indexOf("\n  }", ensureStart) + 4;
    const ensureMethod = settingsController.slice(ensureStart, ensureEnd);

    expect(catalogMarkup).toContain('class="settings-language-catalog"');
    expect(catalogMarkup).not.toContain("hidden");
    expect(settingsHtml).toContain('aria-expanded="true"');
    expect(settingsController).toContain('if (name === "editor") void this.ensureLanguageCatalogPopulated();');
    expect(ensureMethod).toContain("await this.populateLanguageCatalog();");
    expect(ensureMethod).not.toContain(".focus()");
    expect(settingsController).toContain('button.textContent = visible ? "Hide languages" : "Show languages"');
  });

  test("gives the provider catalog wider, consistently inset rows", () => {
    expect(settingsStyles).toContain("max-width: 520px");
    expect(settingsStyles).toContain("padding: 0 12px 8px");
    expect(settingsStyles).toContain("scrollbar-gutter: stable");
    expect(settingsStyles).toContain("padding: 12px 2px");
  });
});
