import type { Text } from "@codemirror/state";
import type {
  LanguageCatalogCapabilities,
  LanguageProviderCapabilities,
} from "../../languageSupport";
import { typographyScripts, type DocumentScript } from "../documentTypography";

export type ScriptLanguageAssignment = {
  /** ISO 15924 script code. */
  script: string;
  languageTag: string;
};

export type ScriptLanguageOption = {
  script: DocumentScript;
  languageTag: string;
  displayName: string;
  installed: boolean;
};

export type CaretLanguageSelection = {
  script: DocumentScript;
  languageTag: string | null;
  displayName: string | null;
  provider: LanguageProviderCapabilities | null;
  state: "ready" | "unconfigured" | "missing" | "unavailable" | "detected";
  automatic: boolean;
};

export interface CompletionProviderSelection {
  provider: LanguageProviderCapabilities;
  languageTag: string;
  scripts: string[];
  source: "document-language";
  generation: number;
}

export class DocumentLanguageService {
  private assignments: ScriptLanguageAssignment[] = [];
  private catalog: LanguageCatalogCapabilities[] = [];
  private installed: LanguageProviderCapabilities[] = [];
  private generation = 0;

  configure(
    assignments: readonly ScriptLanguageAssignment[],
    catalog: readonly LanguageCatalogCapabilities[] = this.catalog,
    installed: readonly LanguageProviderCapabilities[] = this.installed,
  ): void {
    const nextAssignments = assignments.map((entry) => ({ ...entry }));
    const nextCatalog = catalog.map((entry) => ({ ...entry, scripts: [...entry.scripts] }));
    const nextInstalled = installed.map((entry) => ({ ...entry, scripts: [...entry.scripts] }));
    if (
      JSON.stringify(nextAssignments) === JSON.stringify(this.assignments)
      && JSON.stringify(nextCatalog) === JSON.stringify(this.catalog)
      && JSON.stringify(nextInstalled) === JSON.stringify(this.installed)
    ) return;
    this.assignments = nextAssignments;
    this.catalog = nextCatalog;
    this.installed = nextInstalled;
    this.generation += 1;
  }

  currentGeneration(): number {
    return this.generation;
  }

  completionProvider(matchingProviders: readonly LanguageProviderCapabilities[]): CompletionProviderSelection | null {
    const matches = matchingProviders.filter((provider) => {
      const script = provider.scripts.find((value) => this.resolvedLanguageTag(value) !== null);
      return Boolean(script && sameLanguage(provider.languageTag, this.resolvedLanguageTag(script)!));
    });
    const unique = matches.filter((provider, index, all) =>
      all.findIndex((candidate) => candidate.id === provider.id) === index);
    if (unique.length !== 1) return null;
    const provider = unique[0]!;
    return {
      provider,
      languageTag: provider.languageTag,
      scripts: provider.scripts,
      source: "document-language",
      generation: this.generation,
    };
  }

  configuredProviders(): LanguageProviderCapabilities[] {
    return this.installed.filter((provider) => provider.scripts.some((script) => {
      const languageTag = this.resolvedLanguageTag(script);
      return languageTag !== null && sameLanguage(provider.languageTag, languageTag);
    }));
  }

  optionsForScript(scriptCode: string): ScriptLanguageOption[] {
    const script = scriptByCode(scriptCode);
    if (!script) return [];
    const byTag = new Map<string, ScriptLanguageOption>();
    for (const candidate of identificationOptionsForScript(scriptCode)) {
      byTag.set(normalizeTag(candidate.languageTag), {
        script,
        languageTag: candidate.languageTag,
        displayName: candidate.displayName,
        installed: this.installed.some((provider) => sameLanguage(provider.languageTag, candidate.languageTag)
          && provider.scripts.some((value) => sameScript(value, scriptCode))),
      });
    }
    for (const candidate of [...this.catalog, ...this.installed]) {
      if (!candidate.scripts.some((value) => sameScript(value, scriptCode))) continue;
      const key = normalizeTag(candidate.languageTag);
      const existing = byTag.get(key);
      byTag.set(key, {
        script,
        languageTag: candidate.languageTag,
        displayName: candidate.displayName,
        installed: existing?.installed === true
          || this.installed.some((provider) => normalizeTag(provider.languageTag) === key
            && provider.scripts.some((value) => sameScript(value, scriptCode))),
      });
    }
    return [...byTag.values()].sort((left, right) =>
      left.displayName.localeCompare(right.displayName)
      || left.languageTag.localeCompare(right.languageTag));
  }

  configurableScripts(): Array<{ script: DocumentScript; options: ScriptLanguageOption[] }> {
    return typographyScripts.flatMap((script) => {
      const options = this.optionsForScript(script.iso15924);
      return options.length > 1 ? [{ script, options }] : [];
    });
  }

  resolvedLanguageTag(scriptCode: string): string | null {
    const explicit = this.assignments.find((entry) => sameScript(entry.script, scriptCode));
    if (explicit) return explicit.languageTag;
    const options = this.optionsForScript(scriptCode);
    return options.length === 1 ? options[0]!.languageTag : null;
  }

  languageAt(doc: Text, position: number): CaretLanguageSelection | null {
    const script = scriptAtCaret(doc, position);
    if (!script) return null;
    const options = this.optionsForScript(script.iso15924);
    const explicit = this.assignments.find((entry) => sameScript(entry.script, script.iso15924));
    if (options.length === 0 && !explicit) {
      const detected = detectedLanguageAtCaret(doc, position, script.iso15924);
      return {
        script,
        languageTag: detected,
        displayName: detected,
        provider: null,
        state: detected ? "detected" : "unavailable",
        automatic: Boolean(detected),
      };
    }
    const automatic = !explicit && options.length === 1;
    const languageTag = explicit?.languageTag ?? (automatic ? options[0]!.languageTag : null);
    if (!languageTag) {
      const detected = detectedLanguageAtCaret(doc, position, script.iso15924);
      const detectedOption = detected
        ? options.find((candidate) => sameLanguage(candidate.languageTag, detected))
        : null;
      return detected ? {
        script,
        languageTag: detected,
        displayName: detectedOption?.displayName ?? detected,
        provider: null,
        state: "detected",
        automatic: true,
      } : {
        script,
        languageTag: null,
        displayName: null,
        provider: null,
        state: "unconfigured",
        automatic: false,
      };
    }
    const option = options.find((candidate) => sameLanguage(candidate.languageTag, languageTag));
    const provider = this.installed.find((candidate) =>
      candidate.scripts.some((value) => sameScript(value, script.iso15924))
      && sameLanguage(candidate.languageTag, languageTag)) ?? null;
    const advertisedProvider = [...this.catalog, ...this.installed].some((candidate) =>
      candidate.scripts.some((value) => sameScript(value, script.iso15924))
      && sameLanguage(candidate.languageTag, languageTag));
    return {
      script,
      languageTag,
      displayName: option?.displayName ?? languageTag,
      provider,
      state: provider ? "ready" : advertisedProvider ? "missing" : "detected",
      automatic,
    };
  }
}

export function selectDocumentLanguageProvider(
  providers: readonly LanguageProviderCapabilities[],
  entry: ScriptLanguageAssignment,
): LanguageProviderCapabilities | null {
  const requested = localeParts(entry.languageTag);
  if (!requested) return null;
  const candidates = providers.filter((provider) =>
    provider.scripts.some((script) => sameScript(script, entry.script))
    && localeParts(provider.languageTag)?.language === requested.language
  );
  const exact = candidates.find((provider) => normalizeTag(provider.languageTag) === normalizeTag(entry.languageTag));
  if (exact) return exact;
  if (requested.region) return null;
  const languageOnly = candidates.find((provider) => !localeParts(provider.languageTag)?.region);
  return languageOnly ?? (candidates.length === 1 ? candidates[0]! : null);
}

export function providerSupportsDocumentScript(
  provider: Pick<LanguageProviderCapabilities, "scripts">,
  scriptCode: string,
): boolean {
  return provider.scripts.some((value) => sameScript(value, scriptCode));
}

export function sameLanguage(left: string, right: string): boolean {
  const leftLocale = localeParts(left);
  const rightLocale = localeParts(right);
  if (!leftLocale || !rightLocale || leftLocale.language !== rightLocale.language) return false;
  return !rightLocale.region || !leftLocale.region || leftLocale.region === rightLocale.region;
}

export function detectedLanguageAtCaret(
  doc: Text,
  position: number,
  scriptCode = scriptAtCaret(doc, position)?.iso15924 ?? "",
): string | null {
  if (sameScript(scriptCode, "Hira") || sameScript(scriptCode, "Kana")) return "ja";
  if (sameScript(scriptCode, "Hang")) return "ko";
  if (sameScript(scriptCode, "Bopo")) return "zh-TW";
  if (!sameScript(scriptCode, "Hani")) return null;
  const bounded = Math.max(0, Math.min(position, doc.length));
  const source = doc.sliceString(0, doc.length);
  const paragraphStart = Math.max(0, source.lastIndexOf("\n\n", bounded - 1) + 2, bounded - 512);
  const nextBreak = source.indexOf("\n\n", bounded);
  const paragraphEnd = Math.min(nextBreak < 0 ? source.length : nextBreak, bounded + 512);
  const before = source.slice(paragraphStart, bounded);
  const after = source.slice(bounded, paragraphEnd);
  const left = nearestLanguageEvidence([...before].reverse());
  const right = nearestLanguageEvidence([...after]);
  if (!left) return right?.languageTag ?? null;
  if (!right) return left.languageTag;
  return left.distance <= right.distance ? left.languageTag : right.languageTag;
}

function identificationOptionsForScript(scriptCode: string): Array<{ languageTag: string; displayName: string }> {
  if (sameScript(scriptCode, "Hira") || sameScript(scriptCode, "Kana")) {
    return [{ languageTag: "ja", displayName: "Japanese" }];
  }
  if (sameScript(scriptCode, "Hang")) {
    return [{ languageTag: "ko", displayName: "Korean" }];
  }
  if (sameScript(scriptCode, "Bopo")) {
    return [{ languageTag: "zh-TW", displayName: "Chinese — Traditional (Taiwan)" }];
  }
  if (sameScript(scriptCode, "Hani")) {
    return [
      { languageTag: "ja", displayName: "Japanese" },
      { languageTag: "zh-CN", displayName: "Chinese — Simplified" },
      { languageTag: "zh-TW", displayName: "Chinese — Traditional (Taiwan)" },
      { languageTag: "zh-HK", displayName: "Chinese — Traditional (Hong Kong)" },
      { languageTag: "ko", displayName: "Korean" },
      { languageTag: "nan-TW", displayName: "Taiwanese Hokkien" },
    ];
  }
  return [];
}

function nearestLanguageEvidence(characters: readonly string[]): { languageTag: string; distance: number } | null {
  let distance = 0;
  for (const character of characters) {
    if (/\p{Script=Hiragana}|\p{Script=Katakana}/u.test(character)) return { languageTag: "ja", distance };
    if (/\p{Script=Hangul}/u.test(character)) return { languageTag: "ko", distance };
    if (/\p{Script=Bopomofo}/u.test(character)) return { languageTag: "zh-TW", distance };
    distance += character.length;
  }
  return null;
}

export function scriptAtCaret(doc: Text, position: number, radius = 64): DocumentScript | null {
  const bounded = Math.max(0, Math.min(position, doc.length));
  const line = doc.lineAt(bounded);
  const before = doc.sliceString(Math.max(line.from, bounded - radius), bounded);
  const after = doc.sliceString(bounded, Math.min(line.to, bounded + radius));
  const left = nearestScriptBefore(before);
  const right = nearestScriptAfter(after);
  if (!left) return right?.script ?? null;
  if (!right) return left.script;
  return left.distance <= right.distance ? left.script : right.script;
}

function nearestScriptBefore(text: string): { script: DocumentScript; distance: number } | null {
  let distance = 0;
  for (const character of [...text].reverse()) {
    const script = scriptForCharacter(character);
    if (script) return { script, distance };
    distance += character.length;
  }
  return null;
}

function nearestScriptAfter(text: string): { script: DocumentScript; distance: number } | null {
  let distance = 0;
  for (const character of text) {
    const script = scriptForCharacter(character);
    if (script) return { script, distance };
    distance += character.length;
  }
  return null;
}

function scriptForCharacter(character: string): DocumentScript | null {
  return typographyScripts.find((script) => {
    script.pattern.lastIndex = 0;
    return script.pattern.test(character);
  }) ?? null;
}

function scriptByCode(scriptCode: string): DocumentScript | null {
  return typographyScripts.find((script) => sameScript(script.iso15924, scriptCode)) ?? null;
}

function sameScript(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function normalizeTag(tag: string): string {
  const locale = localeParts(tag);
  return locale ? `${locale.language}${locale.region ? `-${locale.region}` : ""}` : "";
}

function localeParts(tag: string): { language: string; region: string | null } | null {
  const parts = tag.trim().replace(/_/g, "-").split("-");
  if (parts.length > 2) return null;
  const [rawLanguage, rawRegion] = parts;
  if (!rawLanguage || !/^[A-Za-z]{2,3}$/.test(rawLanguage)) return null;
  if (rawRegion && !/^(?:[A-Za-z]{2}|\d{3})$/.test(rawRegion)) return null;
  return {
    language: rawLanguage.toLowerCase(),
    region: rawRegion ? (/^\d{3}$/.test(rawRegion) ? rawRegion : rawRegion.toUpperCase()) : null,
  };
}
