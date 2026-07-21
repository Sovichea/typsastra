import { describe, expect, test } from "bun:test";
import {
  DocumentLanguageService,
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

describe("document-script language routing", () => {
  test("routes completion only through the language assigned to the matching script", () => {
    const service = new DocumentLanguageService();
    service.configure([
      { script: "latin", family: "Latin", scale: 1, language: "fr-FR" },
      { script: "khmer", family: "Khmer", scale: 1, language: "km" },
    ]);
    expect(service.completionProvider(installed.slice(0, 2))?.provider.id).toBe("fr");
    expect(service.completionProvider([installed[2]!])?.provider.id).toBe("km");
  });

  test("does not guess for an unconfigured script", () => {
    const service = new DocumentLanguageService();
    service.configure([{ script: "latin", family: "Latin", scale: 1, language: null }]);
    expect(service.completionProvider([installed[0]!])).toBeNull();
  });

  test("does not fall through from an unavailable French provider to English", () => {
    expect(selectDocumentLanguageProvider([installed[0]!], {
      script: "latin",
      language: "fr-FR",
    })).toBeNull();
  });

  test("requires the provider script to match the configured document script", () => {
    expect(selectDocumentLanguageProvider([installed[3]!], {
      script: "khmer",
      language: "ar",
    })).toBeNull();
  });

  test("prefers an exact regional provider and refuses ambiguous regional guesses", () => {
    const enGb = provider("en-gb", "en-GB", ["Latn"]);
    expect(selectDocumentLanguageProvider([installed[0]!, enGb], {
      script: "latin",
      language: "en-US",
    })?.id).toBe("en");
    expect(selectDocumentLanguageProvider([installed[0]!, enGb], {
      script: "latin",
      language: "en",
    })).toBeNull();
  });
});
