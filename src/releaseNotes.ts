export type ReleaseSummary = {
  version: string;
  title: string;
  highlights: readonly string[];
  detailsUrl: string;
};

const releaseSummaries: Record<string, ReleaseSummary> = {
  "0.5.2": {
    version: "0.5.2",
    title: "Responsive previews and safer editing workflows",
    highlights: [
      "Debounced PDF render-on-type is available again for responsive short-document editing.",
      "Contextual quotation editing, clearer wrapped indentation, and Khmer caret fixes improve everyday authoring.",
      "Save As, file duplication, dependency-aware preview guards, and lifecycle fixes make projects safer to manage.",
      "Updates can be staged until restart, while WebView storage monitoring surfaces unusual profile growth."
    ],
    detailsUrl: "https://github.com/Sovichea/typsastra/releases/tag/v0.5.2"
  },
  "0.5.1": {
    version: "0.5.1",
    title: "Examples, multilingual tools, and safer typography",
    highlights: [
      "A versioned, guided examples workspace with task-oriented tutorials.",
      "Script-specific font assignments with drag ordering, Unicode coverage, and independent fine scaling.",
      "Deterministic document-script spellcheck and word completion.",
      "A private global scaled-font cache that is reused across projects and never exported."
    ],
    detailsUrl: "https://github.com/Sovichea/typsastra/releases/tag/v0.5.1"
  }
};

export function releaseSummaryForVersion(version: string): ReleaseSummary | null {
  return releaseSummaries[version] ?? null;
}

export function shouldShowReleaseSummary(version: string, lastSeenVersion: string | null): boolean {
  return releaseSummaryForVersion(version) !== null && lastSeenVersion !== version;
}
