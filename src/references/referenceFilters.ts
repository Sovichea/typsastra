import type { BibliographyEntry } from "./bibliography";

export type ReferenceFilter = "all" | "cited" | "uncited" | "problems";

export type ReferenceFilterOptions = {
  query: string;
  filter: ReferenceFilter;
  citedKeys: ReadonlySet<string>;
};

export function filterReferenceEntries(
  entries: readonly BibliographyEntry[],
  options: ReferenceFilterOptions,
): BibliographyEntry[] {
  const needle = options.query.trim().toLocaleLowerCase();
  return entries.filter(entry => {
    if (options.filter === "cited" && !options.citedKeys.has(entry.key)) return false;
    if (options.filter === "uncited" && options.citedKeys.has(entry.key)) return false;
    if (options.filter === "problems") return false;
    return !needle || referenceEntryMatches(entry, needle);
  });
}

export function referenceEntryMatches(entry: BibliographyEntry, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return true;
  const haystack = [
    entry.key,
    entry.title,
    entry.entryType,
    entry.year ?? "",
    entry.relativePath,
    ...entry.authors,
    ...Object.values(entry.fields),
  ].join("\n").toLocaleLowerCase();
  return haystack.includes(needle);
}
