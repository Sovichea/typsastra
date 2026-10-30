import type { LocaleCatalog, TranslationValues } from "./types";

const placeholderPattern = /\{([^{}]+)\}/g;

/**
 * Collapses the whitespace authors use to wrap markup while keeping message
 * comparison predictable. Translations are matched against this form.
 */
export function normalizeMessageKey(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** Fills `{name}` and `{0}` placeholders. Unknown placeholders are preserved. */
export function interpolateMessage(template: string, values?: TranslationValues): string {
  if (!values) return template;
  return template.replace(placeholderPattern, (placeholder, name: string) => {
    if (!Object.prototype.hasOwnProperty.call(values, name)) return placeholder;
    const value = values[name];
    return value === undefined ? placeholder : String(value);
  });
}

/**
 * Looks a message up in one catalog. Exact source text wins; a whitespace-
 * normalized key is accepted as a convenience for markup-extracted strings.
 */
export function lookupMessage(catalog: LocaleCatalog, message: string): string | undefined {
  const exact = catalog[message];
  if (exact !== undefined) return exact;
  const normalized = normalizeMessageKey(message);
  if (normalized !== message) return catalog[normalized];
  return undefined;
}

/** Builds the catalog key for a tagged template such as `t`Hello ${name}``. */
export function taggedTemplateKey(strings: readonly string[]): string {
  let key = "";
  for (let index = 0; index < strings.length; index += 1) {
    key += strings[index] ?? "";
    if (index < strings.length - 1) key += `{${index}}`;
  }
  return key;
}

/** Values for a tagged template, keyed by their positional placeholder. */
export function taggedTemplateValues(values: readonly unknown[]): TranslationValues {
  const mapped: Record<string, string> = {};
  values.forEach((value, index) => {
    mapped[String(index)] = String(value);
  });
  return mapped;
}

/**
 * Resolves one message. The active catalog is consulted first, then the source
 * catalog, then the source message itself.
 */
export function resolveMessage(
  message: string,
  values: TranslationValues | undefined,
  activeCatalog: LocaleCatalog,
  sourceCatalog: LocaleCatalog
): string {
  const translated = lookupMessage(activeCatalog, message)
    ?? lookupMessage(sourceCatalog, message)
    ?? message;
  return interpolateMessage(translated, values);
}
