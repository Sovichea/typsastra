/** A locale identifier such as `en`, `km`, or `pt-BR`. */
export type LocaleId = string;

/**
 * Translations keyed by their English source text. Source text is the message
 * key so static markup and dynamic UI share one catalog.
 */
export type LocaleCatalog = Readonly<Record<string, string>>;

/** Values substituted into `{name}` or numbered `{0}` placeholders. */
export type TranslationValues = Readonly<Record<string, string | number>>;

export interface LocaleDefinition {
  id: LocaleId;
  /** The locale's own name, for example `English` or `ខ្មែរ`. */
  label: string;
  catalog: LocaleCatalog;
}
