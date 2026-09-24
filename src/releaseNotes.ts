export type ReleaseSummary = {
  version: string;
  title: string;
  highlights: readonly string[];
  detailsUrl: string;
};

const releaseSummaries: Record<string, ReleaseSummary> = {
  "0.9.0": {
    version: "0.9.0",
    title: "Table authoring and project templates",
    highlights: [
      "The Table Tool builds Typst tables from a spreadsheet-style grid with styles, explicit rules, merged cells, CSV import, and linked `//@table:` directives that keep the builder and source in sync.",
      "Create New Project offers searchable Typst Universe templates, an offline library of downloaded templates, managed user templates, and a blank project, all stored as portable .typsastra archives.",
      "The bundled Khmer segmenter is updated to v0.3.2 with reviewed phrase-collision exclusions and out-of-vocabulary diagnostics.",
      "Inverse sync no longer moves or docks the preview, Table Tools keeps its explorer visible, and Image Tools adds non-destructive cropping and selects the saved copy after saving."
    ],
    detailsUrl: "https://github.com/Sovichea/typsastra/releases/tag/v0.9.0"
  },
  "0.8.1": {
    version: "0.8.1",
    title: "Unicode PDF reliability",
    highlights: [
      "The optional Enhanced Unicode Engine v0.4.0 provides verified, transactional PDF export with explicit compiler provenance while Tinymist remains authoritative for live services.",
      "Standalone PDFium viewing gains Unicode-aware search and selection, formatted copy, links, outlines, clearer invalid-document errors, and more reliable viewport restoration.",
      "Project and external images can be dragged or pasted into Typst documents with collision-safe imports and plain-image or captioned-figure insertion.",
      "Global grapheme-aware editing, safer workspace updates, richer image and PDF metadata, and focused preview lifecycle fixes improve everyday authoring."
    ],
    detailsUrl: "https://github.com/Sovichea/typsastra/releases/tag/v0.8.1"
  },
  "0.8.0": {
    version: "0.8.0",
    title: "Unicode PDF reliability",
    highlights: [
      "The optional Enhanced Unicode Engine v0.4.0 provides verified, transactional PDF export with explicit compiler provenance while Tinymist remains authoritative for live services.",
      "Standalone PDFium viewing gains Unicode-aware search and selection, formatted copy, links, outlines, clearer invalid-document errors, and more reliable viewport restoration.",
      "Project and external images can be dragged or pasted into Typst documents with collision-safe imports and plain-image or captioned-figure insertion.",
      "Global grapheme-aware editing, safer workspace updates, richer image and PDF metadata, and focused preview lifecycle fixes improve everyday authoring."
    ],
    detailsUrl: "https://github.com/Sovichea/typsastra/releases/tag/v0.8.0"
  },
  "0.7.0": {
    version: "0.7.0",
    title: "Resource-aware authoring",
    highlights: [
      "Secure Markdown live preview renders common GFM content, workspace images, and links without starting Tinymist or discarding the current PDF session.",
      "Image Tools inventories project raster assets, previews resize and re-encoding results, saves optimized copies, and can update their static Typst references.",
      "Selected-text and diagnostic scrollbar markers, structured compiler errors, persistent tab syntax state, pair editing, and a refined search panel improve editing and navigation.",
      "Scaled-font cache controls, safer project import, system Tinymist discovery, native macOS menus, and Linux reliability fixes strengthen desktop workflows."
    ],
    detailsUrl: "https://github.com/Sovichea/typsastra/releases/tag/v0.7.0"
  },
  "0.6.3": {
    version: "0.6.3",
    title: "Refined multilingual authoring",
    highlights: [
      "Context-aware Typst completion now learns preferred forms, supplies editable argument defaults, and recovers safely after Tinymist restarts.",
      "Khmer editing and language tools gain improved segmentation, AltGr input, corrected caret placement, and immediate user-dictionary completion.",
      "Diacritic-aware search, Surround With, auto-save, extra scroll space, and persistent window state streamline everyday editing.",
      "Workspace font directories, additional scaled fonts, dependency guardrails, and bounded preview generations make projects safer to maintain."
    ],
    detailsUrl: "https://github.com/Sovichea/typsastra/releases/tag/v0.6.3"
  },
  "0.6.1": {
    version: "0.6.1",
    title: "Lower-memory PDF loading",
    highlights: [
      "Progressive PDF range loading avoids transferring an entire large PDF into the WebView before preview can begin.",
      "Large release-build previews use substantially less peak memory while retaining responsive settled-page rendering.",
      "Immutable preview generations prevent Windows file-lock failures when switching between Normal and Draft modes.",
      "Typsastra v0.6.1 otherwise retains the complete v0.6.0 feature set and project compatibility."
    ],
    detailsUrl: "https://github.com/Sovichea/typsastra/releases/tag/v0.6.1"
  },
  "0.6.0": {
    version: "0.6.0",
    title: "Draft Preview and private font workflows",
    highlights: [
      "Draft Preview replaces supported images with layout-preserving placeholders and cached hover thumbnails for responsive image-heavy authoring.",
      "Private local font directories make uninstalled fonts available to typography, diagnostics, preview, source mapping, and PDF export without copying fonts into projects.",
      "Preview navigation retains scroll position, exposes clickable links, and recovers source synchronization more reliably across cache and workspace changes.",
      "Contextual completion, persistent compiler diagnostics, safer project guardrails, and refined editor interaction improve everyday document work."
    ],
    detailsUrl: "https://github.com/Sovichea/typsastra/releases/tag/v0.6.0"
  },
  "0.5.3": {
    version: "0.5.3",
    title: "Reliable previews and safer image-heavy workflows",
    highlights: [
      "File-backed PDF transport and cache-confined artifacts reduce preview memory pressure and protect workspace files.",
      "Source synchronization now recovers more reliably after external edits, cache migration, and system resume.",
      "Large direct PDFs require confirmation and remain visually and behaviorally distinct from live Typst previews.",
      "Image-heavy documents receive non-blocking, navigable optimization guidance without changing source assets."
    ],
    detailsUrl: "https://github.com/Sovichea/typsastra/releases/tag/v0.5.3"
  },
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
