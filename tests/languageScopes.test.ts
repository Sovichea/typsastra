import { describe, expect, test } from "bun:test";
import { Text } from "@codemirror/state";
import {
  detectedLanguageAtCaret,
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
    expect(service.configurableScripts().map(entry => entry.script.iso15924)).toEqual(["Latn", "Hani"]);
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

  test("reports exact CJK scripts and leaves Han language-neutral", () => {
    expect(scriptAtCaret(Text.of(["漢字"]), 0)?.iso15924).toBe("Hani");
    expect(scriptAtCaret(Text.of(["ひらがな"]), 0)?.iso15924).toBe("Hira");
    expect(scriptAtCaret(Text.of(["カタカナ"]), 0)?.iso15924).toBe("Kana");
    expect(scriptAtCaret(Text.of(["ㄅㄆㄇ"]), 0)?.iso15924).toBe("Bopo");
    expect(scriptAtCaret(Text.of(["한글"]), 0)?.iso15924).toBe("Hang");

    const service = new DocumentLanguageService();
    service.configure([], [], installed);
    const han = service.languageAt(Text.of(["漢字"]), 0);
    expect(han?.script.label).toBe("Han");
    expect(han?.languageTag).toBeNull();
    expect(han?.state).toBe("unconfigured");
  });

  test("uses neighboring scripts rather than Typst language settings to classify Han", () => {
    const japanese = Text.of(["日本語の文章"]);
    const misleadingScope = Text.of(['#text(lang: "zh-TW")[日本語だけです]']);
    const pureHanScope = Text.of(['#text(lang: "ja")[日本語]']);

    expect(detectedLanguageAtCaret(japanese, 0)).toBe("ja");
    expect(detectedLanguageAtCaret(misleadingScope, misleadingScope.sliceString(0).indexOf("日"))).toBe("ja");
    expect(detectedLanguageAtCaret(pureHanScope, pureHanScope.sliceString(0).indexOf("日"))).toBeNull();
    expect(detectedLanguageAtCaret(Text.of(["漢字 ㄅㄆㄇ"]), 0)).toBe("zh-TW");
    expect(detectedLanguageAtCaret(Text.of(["漢字 한글"]), 0)).toBe("ko");
  });

  test("shows a contextually detected language without activating a provider", () => {
    const service = new DocumentLanguageService();
    service.configure([], [], installed);
    const selection = service.languageAt(Text.of(["日本語の文章"]), 0);
    const hiragana = service.languageAt(Text.of(["ひらがな"]), 0);
    const katakana = service.languageAt(Text.of(["カタカナ"]), 0);

    expect(selection?.script.iso15924).toBe("Hani");
    expect(selection?.languageTag).toBe("ja");
    expect(selection?.provider).toBeNull();
    expect(selection?.state).toBe("detected");
    expect(hiragana?.languageTag).toBe("ja");
    expect(hiragana?.state).toBe("detected");
    expect(katakana?.languageTag).toBe("ja");
    expect(katakana?.state).toBe("detected");
  });

  test("offers culturally neutral language identification choices for pure Han", () => {
    const service = new DocumentLanguageService();
    service.configure([], [], installed);
    const options = service.optionsForScript("Hani");

    expect(new Set(options.map(option => option.languageTag))).toEqual(
      new Set(["ja", "zh-CN", "zh-TW", "zh-HK", "ko", "nan-TW"]),
    );
    expect(options.every(option => option.installed === false)).toBe(true);

    service.configure([{ script: "Hani", languageTag: "zh-TW" }], [], installed);
    const selected = service.languageAt(Text.of(["漢字"]), 0);
    expect(selected?.displayName).toBe("Chinese — Traditional (Taiwan)");
    expect(selected?.state).toBe("detected");
  });

  test("detects Greek and Cyrillic without assuming a language", () => {
    expect(scriptAtCaret(Text.of(["Ελληνικά"]), 0)?.iso15924).toBe("Grek");
    expect(scriptAtCaret(Text.of(["Русский"]), 0)?.iso15924).toBe("Cyrl");
  });
});
