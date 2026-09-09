import { describe, expect, test } from "bun:test";
import { displayLanguageTag } from "../src/editor/documentLanguageStatusController";

describe("document language status", () => {
  test("provides an accessible status item and document-language dialog", async () => {
    const html = await Bun.file(new URL("../index.html", import.meta.url)).text();

    expect(html).toContain('id="document-language-status"');
    expect(html).toContain('aria-controls="document-language-overlay"');
    expect(html).toContain('id="document-language-overlay"');
    expect(html).toContain('aria-labelledby="document-language-title"');
    expect(html).toContain('id="document-language-assignments"');
    expect(html).toContain('id="document-language-spellcheck"');
    expect(html).toContain('id="document-language-completion"');
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain('id="document-language-apply"');
    expect(html).toContain("Scripts with one available language, such as Khmer, are resolved automatically");
  });

  test("uses a compact content-sized dialog", async () => {
    const css = await Bun.file(new URL("../src/style.css", import.meta.url)).text();
    const start = css.indexOf(".document-language-dialog {");
    const rule = css.slice(start, css.indexOf("}", start));

    expect(rule).toContain("width: min(540px, 100%)");
    expect(rule).toContain("height: auto");
  });

  test("updates the status on caret and document changes", async () => {
    const initialization = await Bun.file(new URL("../src/editor/editorInitializationController.ts", import.meta.url)).text();
    expect(initialization).toContain("update.selectionSet || update.docChanged");
    expect(initialization).toContain("updateDocumentLanguageStatus()");
  });

  test("loads provider capabilities before resolving document languages", async () => {
    const app = await Bun.file(new URL("../src/appController.ts", import.meta.url)).text();
    const providers = app.indexOf('timeStartup("initialize language providers"');
    const languages = app.indexOf('timeStartup("initialize document languages"');

    expect(providers).toBeGreaterThan(0);
    expect(languages).toBeGreaterThan(providers);
  });

  test("formats the selected language and region for the status bar", () => {
    expect(displayLanguageTag("en-US", "English")).toBe("English — United States");
    expect(displayLanguageTag("km", "Khmer")).toBe("Khmer");
  });

  test("toggles the existing spellcheck and word-autocomplete settings", async () => {
    const controller = await Bun.file(new URL("../src/editor/documentLanguageStatusController.ts", import.meta.url)).text();
    const app = await Bun.file(new URL("../src/appController.ts", import.meta.url)).text();

    expect(controller).toContain("setSpellcheckEnabled(!this.deps.spellcheckEnabled())");
    expect(controller).toContain("setWordCompletionEnabled(!this.deps.wordCompletionEnabled())");
    expect(app).toContain("settings.editor.spellcheck = enabled");
    expect(app).toContain("settings.editor.wordCompletion = enabled");
  });

  test("keeps unavailable explicit assignments when rendering the modal", async () => {
    const controller = await Bun.file(new URL("../src/editor/documentLanguageStatusController.ts", import.meta.url)).text();
    expect(controller).toContain("options.some(option => option.languageTag.toLowerCase() === assigned.toLowerCase())");
    expect(controller).toContain("select.value = assigned");
    expect(controller).toContain("!visibleScripts.has(entry.script.toLowerCase())");
  });
});
