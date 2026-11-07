export type BibliographyStyleOption = {
  id: string;
  label: string;
};

/**
 * Styles bundled with the Typst version Typsastra targets. These are static on
 * purpose: references stay offline and no CSL repository is consulted.
 */
export const BIBLIOGRAPHY_STYLES: readonly BibliographyStyleOption[] = [
  { id: "apa", label: "APA" },
  { id: "ieee", label: "IEEE" },
  { id: "mla", label: "MLA" },
  { id: "chicago-author-date", label: "Chicago author-date" },
  { id: "chicago-notes", label: "Chicago notes" },
  { id: "vancouver", label: "Vancouver" },
  { id: "harvard-cite-them-right", label: "Harvard" },
  { id: "american-medical-association", label: "American Medical Association" },
  { id: "annual-reviews", label: "Annual Reviews" },
  { id: "biomed-central", label: "BioMed Central" },
  { id: "bmj", label: "BMJ" },
  { id: "cell", label: "Cell" },
  { id: "council-of-science-editors", label: "Council of Science Editors" },
  { id: "council-of-science-editors-author-date", label: "Council of Science Editors author-date" },
  { id: "elsevier-harvard", label: "Elsevier Harvard" },
  { id: "elsevier-with-titles", label: "Elsevier with titles" },
  { id: "gb-7714-2005-numeric", label: "GB/T 7714-2005 numeric" },
  { id: "iso-690-author-date", label: "ISO 690 author-date" },
  { id: "iso-690-numeric", label: "ISO 690 numeric" },
  { id: "nature", label: "Nature" },
  { id: "springer-basic", label: "Springer basic" },
  { id: "springer-basic-author-date", label: "Springer basic author-date" },
  { id: "springer-mathphys", label: "Springer MathPhys" },
  { id: "springer-vancouver", label: "Springer Vancouver" },
];

export const DEFAULT_BIBLIOGRAPHY_STYLE = "apa";

export function bibliographyStyleLabel(style: string | null | undefined): string {
  if (!style) return "";
  return BIBLIOGRAPHY_STYLES.find(candidate => candidate.id === style)?.label ?? style;
}
