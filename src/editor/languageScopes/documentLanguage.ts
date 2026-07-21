import type { LanguageProviderCapabilities } from "../../languageSupport";
import { typographyScripts, type DocumentScriptFont } from "../documentTypography";

export interface CompletionProviderSelection {
  provider: LanguageProviderCapabilities;
  languageTag: string;
  scripts: string[];
  source: "document-script";
  generation: number;
}

export class DocumentLanguageService {
  private entries: DocumentScriptFont[] = [];
  private generation = 0;

  configure(entries: readonly DocumentScriptFont[]): void {
    const next = entries.map((entry) => ({ ...entry }));
    if (JSON.stringify(next) === JSON.stringify(this.entries)) return;
    this.entries = next;
    this.generation += 1;
  }

  currentGeneration(): number {
    return this.generation;
  }

  completionProvider(matchingProviders: readonly LanguageProviderCapabilities[]): CompletionProviderSelection | null {
    const matches = this.entries.flatMap((entry) => {
      const provider = selectDocumentLanguageProvider(matchingProviders, entry);
      return provider ? [provider] : [];
    }).filter((provider, index, all) => all.findIndex((candidate) => candidate.id === provider.id) === index);
    if (matches.length !== 1) return null;
    const provider = matches[0]!;
    return {
      provider,
      languageTag: provider.languageTag,
      scripts: provider.scripts,
      source: "document-script",
      generation: this.generation,
    };
  }
}

export function selectDocumentLanguageProvider(
  providers: readonly LanguageProviderCapabilities[],
  entry: Pick<DocumentScriptFont, "script" | "language">,
): LanguageProviderCapabilities | null {
  if (!entry.language) return null;
  const requested = localeParts(entry.language);
  if (!requested) return null;
  const candidates = providers.filter((provider) =>
    providerSupportsDocumentScript(provider, entry.script)
    && localeParts(provider.languageTag)?.language === requested.language
  );
  const exact = candidates.find((provider) => normalizeTag(provider.languageTag) === normalizeTag(entry.language!));
  if (exact) return exact;
  if (requested.region) return null;
  const languageOnly = candidates.find((provider) => !localeParts(provider.languageTag)?.region);
  return languageOnly ?? (candidates.length === 1 ? candidates[0]! : null);
}

export function providerSupportsDocumentScript(
  provider: Pick<LanguageProviderCapabilities, "scripts">,
  scriptId: string,
): boolean {
  const script = typographyScripts.find((candidate) => candidate.id === scriptId);
  return Boolean(script && provider.scripts.some((value) =>
    value.toLowerCase() === script.iso15924.toLowerCase()));
}

export function sameLanguage(left: string, right: string): boolean {
  const leftLocale = localeParts(left);
  const rightLocale = localeParts(right);
  if (!leftLocale || !rightLocale || leftLocale.language !== rightLocale.language) return false;
  return !rightLocale.region || !leftLocale.region || leftLocale.region === rightLocale.region;
}

function normalizeTag(tag: string): string {
  const locale = localeParts(tag);
  return locale ? `${locale.language}${locale.region ? `-${locale.region}` : ""}` : "";
}

function localeParts(tag: string): { language: string; region: string | null } | null {
  const [rawLanguage, rawRegion] = tag.trim().replace(/_/g, "-").split("-");
  if (!rawLanguage || !/^[A-Za-z]{2,3}$/.test(rawLanguage)) return null;
  const language = rawLanguage.toLowerCase();
  const region = rawRegion && /^(?:[A-Za-z]{2}|\d{3})$/.test(rawRegion)
    ? rawRegion.toUpperCase()
    : null;
  return { language, region };
}
