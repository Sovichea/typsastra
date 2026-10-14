import type { EditorView } from "@codemirror/view";

export type SurroundWithOption = {
  id: string;
  label: string;
  description: string;
  prefix: string;
  suffix: string;
  searchTerms: readonly string[];
};

export type SurroundWithCompletionItem = {
  label: string;
  detail?: string;
  labelDetails?: { description?: string; detail?: string };
};

/**
 * Curated Typst forms whose final content argument supports bracket syntax.
 * Keep this list deliberately conservative: ordinary functions must not leak
 * into Surround With merely because they appear in completion results.
 */
export const SURROUND_WITH_OPTIONS: readonly SurroundWithOption[] = [
  { id: "content", label: "#[…]", description: "Content block", prefix: "#[", suffix: "]", searchTerms: ["content", "block"] },
  { id: "emph", label: "#emph[…]", description: "Emphasis", prefix: "#emph[", suffix: "]", searchTerms: ["emphasis", "italic"] },
  { id: "strong", label: "#strong[…]", description: "Strong emphasis", prefix: "#strong[", suffix: "]", searchTerms: ["bold", "strong"] },
  { id: "block", label: "#block[…]", description: "Block container", prefix: "#block[", suffix: "]", searchTerms: ["container", "layout"] },
  { id: "par", label: "#par[…]", description: "Paragraph container", prefix: "#par[", suffix: "]", searchTerms: ["paragraph", "layout"] },
  { id: "box", label: "#box[…]", description: "Inline box", prefix: "#box[", suffix: "]", searchTerms: ["inline", "container"] },
  { id: "highlight", label: "#highlight[…]", description: "Highlighted content", prefix: "#highlight[", suffix: "]", searchTerms: ["mark", "background"] },
  { id: "underline", label: "#underline[…]", description: "Underlined content", prefix: "#underline[", suffix: "]", searchTerms: ["line", "decoration"] },
  { id: "overline", label: "#overline[…]", description: "Overlined content", prefix: "#overline[", suffix: "]", searchTerms: ["line", "decoration"] },
  { id: "strike", label: "#strike[…]", description: "Struck-through content", prefix: "#strike[", suffix: "]", searchTerms: ["strikethrough", "delete"] },
  { id: "smallcaps", label: "#smallcaps[…]", description: "Small capitals", prefix: "#smallcaps[", suffix: "]", searchTerms: ["small caps", "capital"] },
  { id: "sub", label: "#sub[…]", description: "Subscript", prefix: "#sub[", suffix: "]", searchTerms: ["subscript"] },
  { id: "super", label: "#super[…]", description: "Superscript", prefix: "#super[", suffix: "]", searchTerms: ["superscript"] },
  { id: "heading", label: "#heading[…]", description: "Heading", prefix: "#heading[", suffix: "]", searchTerms: ["title", "section"] },
  { id: "quote", label: "#quote[…]", description: "Quotation", prefix: "#quote[", suffix: "]", searchTerms: ["quotation", "citation"] },
  { id: "align", label: "#align[…]", description: "Aligned content", prefix: "#align[", suffix: "]", searchTerms: ["alignment", "layout"] },
  { id: "align-center", label: "#align(center)[…]", description: "Center content", prefix: "#align(center)[", suffix: "]", searchTerms: ["align", "center", "centre", "horizontal"] },
  { id: "align-left", label: "#align(left)[…]", description: "Align content to the left", prefix: "#align(left)[", suffix: "]", searchTerms: ["align", "left", "horizontal"] },
  { id: "align-right", label: "#align(right)[…]", description: "Align content to the right", prefix: "#align(right)[", suffix: "]", searchTerms: ["align", "right", "horizontal"] },
  { id: "par-justify", label: "#par(justify: true)[…]", description: "Justify a paragraph", prefix: "#par(justify: true)[", suffix: "]", searchTerms: ["paragraph", "justify", "alignment"] },
  { id: "block-full-width", label: "#block(width: 100%)[…]", description: "Place content in a full-width block", prefix: "#block(width: 100%)[", suffix: "]", searchTerms: ["block", "width", "full", "layout"] },
  { id: "figure", label: "#figure[…]", description: "Figure body", prefix: "#figure[", suffix: "]", searchTerms: ["caption", "float"] },
  { id: "figure-caption", label: "#figure(caption: [Caption])[…]", description: "Figure with an editable caption placeholder", prefix: "#figure(caption: [Caption])[", suffix: "]", searchTerms: ["figure", "caption", "label"] },
  { id: "text", label: "#text[…]", description: "Styled text", prefix: "#text[", suffix: "]", searchTerms: ["font", "style"] },
  { id: "text-size-12pt", label: "#text(size: 12pt)[…]", description: "Set text size to 12 pt", prefix: "#text(size: 12pt)[", suffix: "]", searchTerms: ["text", "size", "12pt", "font"] },
  { id: "text-fill-blue", label: "#text(fill: blue)[…]", description: "Set text color to blue", prefix: "#text(fill: blue)[", suffix: "]", searchTerms: ["text", "fill", "color", "colour", "blue"] },
  { id: "hide", label: "#hide[…]", description: "Hidden content", prefix: "#hide[", suffix: "]", searchTerms: ["invisible"] },
];

function bracketCompletionFamily(label: string): string | null {
  const match = /^#?([\p{L}\p{M}\p{N}_-]+)(?:\.bracket|\[\])$/u.exec(label.trim());
  return match?.[1] ?? null;
}

/**
 * Extends the stable fallback with bracket-capable functions advertised by
 * Tinymist. Explicit `.bracket`/`[]` metadata is required so ordinary
 * callables are never assumed to accept content.
 */
export function mergeDiscoveredSurroundWithOptions(
  items: readonly SurroundWithCompletionItem[],
  fallback: readonly SurroundWithOption[] = SURROUND_WITH_OPTIONS,
): SurroundWithOption[] {
  const options = [...fallback];
  const known = new Set(options.map(option => option.id));
  const discovered = new Map<string, SurroundWithOption>();
  for (const item of items) {
    const family = bracketCompletionFamily(item.label);
    if (!family || known.has(family) || discovered.has(family)) continue;
    const description = item.labelDetails?.description
      ?? item.labelDetails?.detail
      ?? item.detail
      ?? "Bracket-capable Typst content";
    discovered.set(family, {
      id: family,
      label: `#${family}[…]`,
      description,
      prefix: `#${family}[`,
      suffix: "]",
      searchTerms: [family, "content"],
    });
  }
  return options.concat([...discovered.values()].sort((left, right) => left.id.localeCompare(right.id)));
}

function normalizedSearch(value: string): string {
  return value.toLocaleLowerCase().replace(/^#/, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function fuzzyTokenScore(value: string, query: string): number | null {
  if (!query) return 0;
  if (value === query) return 0;
  if (value.startsWith(query)) return 10 + (value.length - query.length) * 0.01;
  const contiguousIndex = value.indexOf(query);
  if (contiguousIndex >= 0) {
    const boundary = contiguousIndex === 0 || /\s/u.test(value[contiguousIndex - 1] ?? "");
    return (boundary ? 20 : 40) + contiguousIndex + (value.length - query.length) * 0.01;
  }
  let queryIndex = 0;
  let firstIndex = -1;
  let previousIndex = -1;
  let gaps = 0;
  let index = 0;
  for (const character of value) {
    if (character === query[queryIndex]) {
      if (firstIndex < 0) firstIndex = index;
      if (previousIndex >= 0) gaps += index - previousIndex - 1;
      previousIndex = index;
      queryIndex += 1;
    }
    if (queryIndex === query.length) {
      return 100 + firstIndex * 2 + gaps * 4 + (value.length - query.length) * 0.01;
    }
    index += 1;
  }
  return null;
}

function fuzzyFieldsScore(fields: readonly string[], tokens: readonly string[]): number | null {
  let total = 0;
  for (const token of tokens) {
    const scores = fields
      .map(field => fuzzyTokenScore(field, token))
      .filter((score): score is number => score !== null);
    if (!scores.length) return null;
    total += Math.min(...scores);
  }
  return total;
}

export function filterSurroundWithOptions(
  query: string,
  options: readonly SurroundWithOption[] = SURROUND_WITH_OPTIONS,
): SurroundWithOption[] {
  const normalizedQuery = normalizedSearch(query);
  if (!normalizedQuery) return [...options];
  const tokens = normalizedQuery.split(/\s+/u);
  return options
    .map((option, index) => {
      const nameScore = fuzzyFieldsScore([normalizedSearch(option.id)], tokens);
      const metadataScore = fuzzyFieldsScore([
        normalizedSearch(option.label),
        normalizedSearch(option.description),
        ...option.searchTerms.map(normalizedSearch),
      ], tokens);
      return {
        option,
        index,
        score: Math.min(
          nameScore ?? Number.POSITIVE_INFINITY,
          metadataScore === null ? Number.POSITIVE_INFINITY : metadataScore + 200,
        ),
      };
    })
    .filter(result => Number.isFinite(result.score))
    .sort((left, right) => left.score - right.score || left.index - right.index)
    .map(result => result.option);
}

export function surroundEditorRange(
  editor: EditorView,
  from: number,
  to: number,
  option: SurroundWithOption,
): boolean {
  if (from < 0 || to <= from || to > editor.state.doc.length) return false;
  const selected = editor.state.sliceDoc(from, to);
  const inserted = `${option.prefix}${selected}${option.suffix}`;
  const innerFrom = from + option.prefix.length;
  editor.dispatch({
    changes: { from, to, insert: inserted },
    selection: { anchor: innerFrom, head: innerFrom + selected.length },
    scrollIntoView: true,
    userEvent: "input.surround",
  });
  editor.focus();
  return true;
}
