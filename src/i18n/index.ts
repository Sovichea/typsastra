import { applyDomTranslations, applyLocalizedHtml } from "./dom";
import { builtinLocales, englishLocale } from "./locales";
import {
  resolveMessage,
  taggedTemplateKey,
  taggedTemplateValues,
} from "./translate";
import type { LocaleDefinition, LocaleId, TranslationValues } from "./types";

const localeStorageKey = "typsastra.ui-locale";
const localeChangedEvent = "typsastra:locale-changed";

const locales = new Map<LocaleId, LocaleDefinition>();
for (const locale of builtinLocales) locales.set(locale.id, locale);

const sourceLocale = locales.get(englishLocale.id) ?? englishLocale;
let activeLocale = sourceLocale;

function readStoredLocale(): string | null {
  try {
    return globalThis.localStorage?.getItem(localeStorageKey) ?? null;
  } catch {
    return null;
  }
}

function storeLocale(id: LocaleId): void {
  try {
    globalThis.localStorage?.setItem(localeStorageKey, id);
  } catch {
    // Storage can be unavailable in restricted webviews; the in-memory locale
    // remains active for the current session.
  }
}

function applyDocumentLocale(): void {
  if (typeof document === "undefined") return;
  document.documentElement.lang = activeLocale.id;
}

/** Registers a locale catalog. Re-registering an id replaces its catalog. */
export function registerLocale(definition: LocaleDefinition): void {
  if (!definition.id.trim()) throw new Error("A locale id is required.");
  locales.set(definition.id, definition);
  if (activeLocale.id === definition.id) {
    activeLocale = definition;
    localizeDom();
    dispatchLocaleChanged();
  }
}

/** All registered locales, ordered by registration. */
export function availableLocales(): readonly LocaleDefinition[] {
  return [...locales.values()];
}

export function getLocale(): LocaleId {
  return activeLocale.id;
}

export function getLocaleDefinition(id: LocaleId): LocaleDefinition | undefined {
  return locales.get(id);
}

/**
 * Activates a registered locale, persists the choice, and re-localizes markup
 * that was translated by `localizeDom`.
 */
export function setLocale(id: LocaleId): void {
  const next = locales.get(id);
  if (!next) throw new Error(`Unknown locale: ${id}`);
  activeLocale = next;
  storeLocale(next.id);
  applyDocumentLocale();
  localizeDom();
  dispatchLocaleChanged();
}

export function initializeI18n(): void {
  const stored = readStoredLocale();
  const initial = stored ? locales.get(stored) : undefined;
  activeLocale = initial ?? sourceLocale;
  applyDocumentLocale();
  localizeDom();
}

/**
 * Resolves a UI message. English source text is the key, so existing markup and
 * call sites stay readable and translators can work from extracted strings.
 */
export function t(message: string, values?: TranslationValues): string;
export function t(strings: TemplateStringsArray, ...values: unknown[]): string;
export function t(messageOrStrings: string | TemplateStringsArray, ...values: unknown[]): string {
  if (typeof messageOrStrings === "string") {
    return resolveMessage(
      messageOrStrings,
      values[0] as TranslationValues | undefined,
      activeLocale.catalog,
      sourceLocale.catalog
    );
  }
  return resolveMessage(
    taggedTemplateKey(messageOrStrings),
    taggedTemplateValues(values),
    activeLocale.catalog,
    sourceLocale.catalog
  );
}

/**
 * Selects a count-aware source message and translates it. Both forms should
 * contain `{count}` when the number belongs in the sentence.
 */
export function tn(
  count: number,
  singular: string,
  plural: string,
  values?: TranslationValues
): string {
  return t(count === 1 ? singular : plural, { count, ...values });
}

/** Translates authored markup below `root` without disturbing English source text. */
export function localizeDom(root?: ParentNode): void {
  if (!root) {
    if (typeof document === "undefined") return;
    root = document;
  }
  applyDomTranslations(root, message => t(message));
}

/** Sets UI markup and localizes its text and translated attributes. */
export function setLocalizedHtml(element: Element, html: string): void {
  applyLocalizedHtml(element, html, message => t(message));
}

export function onLocaleChange(listener: (locale: LocaleId) => void): () => void {
  if (typeof document === "undefined") return () => {};
  const handler = (event: Event) => {
    listener((event as CustomEvent<LocaleId>).detail);
  };
  document.addEventListener(localeChangedEvent, handler);
  return () => document.removeEventListener(localeChangedEvent, handler);
}

function dispatchLocaleChanged(): void {
  if (typeof document === "undefined") return;
  document.dispatchEvent(new CustomEvent<LocaleId>(localeChangedEvent, {
    detail: activeLocale.id,
  }));
}
