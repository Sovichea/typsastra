import type { LocaleDefinition } from "../types";

/**
 * English is the source locale. English source text is the message key, so a
 * complete English catalog needs no entries: missing translations fall back to
 * the authored text. Add entries here only when the canonical English wording
 * must differ from the text used at the call site.
 */
export const englishLocale: LocaleDefinition = {
  id: "en",
  label: "English",
  catalog: {},
};
