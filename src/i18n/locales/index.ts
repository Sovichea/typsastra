import type { LocaleDefinition } from "../types";
import { englishLocale } from "./en";

/**
 * Register additional locales here. Each catalog is keyed by English source
 * text, for example `{ "Save": "រក្សាទុក" }`.
 */
export const builtinLocales: readonly LocaleDefinition[] = [englishLocale];

export { englishLocale };
