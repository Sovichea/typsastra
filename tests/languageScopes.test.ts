import { describe, expect, test } from "bun:test";
import { Text } from "@codemirror/state";
import {
  DocumentLanguageService,
  scriptAtCaret,
  selectDocumentLanguageProvider,
} from "../src/editor/languageScopes/documentLanguage";
import type { LanguageProviderCapabilities } from "../src/languageSupport";

const provider = (id: string, languageTag: string, scripts: string[]): LanguageProviderCapabilities => ({
  schemaVersion: 1,
  id,
  pattern: scripts.includes("Latn") ? "[A-Za-z]+" : scripts.includes("Khmr") ? "[\\u1780-\\u17ff]+" : "[\\u0600-\\u06ff]+",
  displayName: id,
  languageTag,
  scripts,
  engine: "test",
  supportLevel: "basic",
  stability: "stable",
  boundaryMode: "unicode-word",
  boundaryQuality: "general",
  correctionQuality: "dictionary",
  supportsSpellcheck: true,
  supportsCorrections: true,
  supportsCompletion: true,
  supportsSegmentation: false,
  supportsCustomDictionary: true,
  hasEditingPolicy: false,
  providerType: "dictionary-only",
  version: "1",
  license: "test",
});

const installed = [
  provider("en", "en-US", ["Latn"]),
  provider("fr", "fr-FR", ["Latn"]),
  provider("km", "km", ["Khmr"]),
  provider("ar", "ar", ["Arab"]),
];

describe("document language routing", () => {
  test("routes completion through an explicit project script-language assignment", () => {
    const service = new DocumentLanguageService();
    service.configure([
      { script: "Latn", languageTag: "fr-FR" },
      { script: "Khmr", languageTag: "km" },
    ], [], installed);
    expect(service.completionProvider(installed.slice(0, 2))?.provider.id).toBe("fr");
    expect(service.completionProvider([installed[2]!])?.provider.id).toBe("km");
  });

  test("resolves a single-language script automatically but not an ambiguous script", () => {
    const service = new DocumentLanguageService();
    service.configure([], [], installed);
    expect(service.resolvedLanguageTag("Khmr")).toBe("km");
    expect(service.resolvedLanguageTag("Latn")).toBeNull();
    expect(service.configurableScripts().map(entry => entry.script.iso15924)).toEqual(["Latn"]);
  });

  test("does not fall through from an unavailable French provider to English", () => {
    expect(selectDocumentLanguageProvider([installed[0]!], {
      script: "Latn",
      languageTag: "fr-FR",
    })).toBeNull();
  });

  test("requires the provider script to match the configured document script", () => {
    expect(selectDocumentLanguageProvider([installed[3]!], {
      script: "Khmr",
      languageTag: "ar",
    })).toBeNull();
  });

  test("prefers an exact regional provider and refuses ambiguous regional guesses", () => {
    const enGb = provider("en-gb", "en-GB", ["Latn"]);
    expect(selectDocumentLanguageProvider([installed[0]!, enGb], {
      script: "Latn",
      languageTag: "en-US",
    })?.id).toBe("en");
    expect(selectDocumentLanguageProvider([installed[0]!, enGb], {
      script: "Latn",
      languageTag: "en",
    })).toBeNull();
  });

  test("reports the resolved script-language pair under the caret", () => {
    const service = new DocumentLanguageService();
    service.configure([{ script: "Latn", languageTag: "en-US" }], [], installed);
    const doc = Text.of(["English ខ្មែរ"]);

    expect(service.languageAt(doc, 3)?.provider?.id).toBe("en");
    expect(service.languageAt(doc, doc.length)?.provider?.id).toBe("km");
    expect(service.languageAt(doc, doc.length)?.automatic).toBe(true);
  });

  test("uses the nearest strong script and prefers preceding text at boundaries", () => {
    const doc = Text.of(["English — ខ្មែរ"]);
    expect(scriptAtCaret(doc, 7)?.iso15924).toBe("Latn");
    expect(scriptAtCaret(doc, 8)?.iso15924).toBe("Latn");
    expect(scriptAtCaret(doc, 10)?.iso15924).toBe("Khmr");
    expect(scriptAtCaret(Text.of(["ខ្មែរ"]), 0)?.iso15924).toBe("Khmr");
  });
});
