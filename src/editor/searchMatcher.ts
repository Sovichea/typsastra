import { CharCategory, EditorState, type Text } from "@codemirror/state";
import { SearchCursor, SearchQuery } from "@codemirror/search";

const GENERIC_DIACRITICS = /[\u0300-\u036f\u1ab0-\u1aff\u1dc0-\u1dff\u20d0-\u20ff\ufe20-\ufe2f]/gu;

export interface TypsastraSearchQueryConfig {
  search: string;
  caseSensitive?: boolean;
  literal?: boolean;
  regexp?: boolean;
  replace?: string;
  wholeWord?: boolean;
  matchDiacritics?: boolean;
  test?: (match: string, state: EditorState, from: number, to: number) => boolean;
}

export type SearchRange = { from: number; to: number; precise: boolean };
type SearchResult = SearchRange & { match?: RegExpExecArray };
type SearchRuntime = {
  spec: SearchQuery;
  nextMatch(state: EditorState, curFrom: number, curTo: number): SearchResult | null;
  prevMatch(state: EditorState, curFrom: number, curTo: number): SearchResult | null;
  getReplacement(result: SearchResult): string;
  matchAll(state: EditorState, limit: number): SearchResult[] | null;
  highlight(state: EditorState, from: number, to: number, add: (from: number, to: number) => void): void;
};

type RuntimeSearchQuery = SearchQuery & { create(): SearchRuntime };

export type EditorSearchMatch = {
  from: number;
  to: number;
  lineNumber: number;
  lineFrom: number;
  lineText: string;
  lineRanges: Array<{ from: number; to: number }>;
};

export type EditorSearchMatchResult = {
  matches: EditorSearchMatch[];
  truncated: boolean;
  error: string | null;
};

function unquote(text: string, literal: boolean): string {
  return literal
    ? text
    : text.replace(/\\([nrt\\])/g, (_match, character: string) =>
      character === "n" ? "\n" : character === "r" ? "\r" : character === "t" ? "\t" : "\\"
    );
}

function normalizeSearchText(text: string, caseSensitive: boolean, matchDiacritics: boolean): string {
  let normalized = text;
  if (!matchDiacritics) normalized = normalized.replace(GENERIC_DIACRITICS, "");
  return caseSensitive ? normalized : normalized.toLowerCase();
}

function canonicalSearchText(text: string, caseSensitive: boolean): string {
  return normalizeSearchText(text.normalize("NFKD"), caseSensitive, true);
}

function isGenericDiacritic(character: string): boolean {
  GENERIC_DIACRITICS.lastIndex = 0;
  return GENERIC_DIACRITICS.test(character);
}

function extendOverIgnoredDiacritics(state: EditorState, to: number): number {
  let end = to;
  while (end < state.doc.length) {
    const character = String.fromCodePoint(state.doc.sliceString(end, Math.min(state.doc.length, end + 2)).codePointAt(0)!);
    if (!isGenericDiacritic(character)) break;
    end += character.length;
  }
  return end;
}

function characterBefore(state: EditorState, position: number): string {
  if (position <= 0) return "";
  const characters = Array.from(state.doc.sliceString(Math.max(0, position - 2), position));
  return characters[characters.length - 1] ?? "";
}

function characterAfter(state: EditorState, position: number): string {
  if (position >= state.doc.length) return "";
  return Array.from(state.doc.sliceString(position, Math.min(state.doc.length, position + 2)))[0] ?? "";
}

function isWholeWord(state: EditorState, from: number, to: number): boolean {
  const categorize = state.charCategorizer(state.selection.main.head);
  const before = characterBefore(state, from);
  const first = characterAfter(state, from);
  const last = characterBefore(state, to);
  const after = characterAfter(state, to);
  return (categorize(before) !== CharCategory.Word || categorize(first) !== CharCategory.Word)
    && (categorize(after) !== CharCategory.Word || categorize(last) !== CharCategory.Word);
}

function asEditorState(state: EditorState | Text): EditorState {
  return "doc" in state ? state : EditorState.create({ doc: state });
}

class DiacriticSearchCursor implements Iterator<SearchRange> {
  done = false;
  value: SearchRange = { from: 0, to: 0, precise: false };

  constructor(
    private readonly cursor: SearchCursor,
    private readonly state: EditorState,
    private readonly query: TypsastraSearchQuery
  ) {}

  next(): this {
    return this.advance(false);
  }

  nextOverlapping(): this {
    return this.advance(true);
  }

  private advance(overlapping: boolean): this {
    for (;;) {
      const result = overlapping ? this.cursor.nextOverlapping() : this.cursor.next();
      if (result.done) {
        this.done = true;
        return this;
      }
      const from = result.value.from;
      const to = this.query.matchDiacritics
        ? result.value.to
        : extendOverIgnoredDiacritics(this.state, result.value.to);
      const matchedText = this.state.sliceDoc(from, to);
      if (
        this.query.matchDiacritics
        && canonicalSearchText(matchedText, this.query.caseSensitive)
          !== canonicalSearchText(this.query.unquotedSearch, this.query.caseSensitive)
      ) continue;
      if (this.query.wholeWord && !isWholeWord(this.state, from, to)) continue;
      if (this.query.test && !this.query.test(matchedText, this.state, from, to)) continue;
      this.done = false;
      this.value = { from, to, precise: true };
      return this;
    }
  }

  [Symbol.iterator](): Iterator<SearchRange> {
    return this;
  }
}

class LiteralSearchRuntime implements SearchRuntime {
  readonly spec: TypsastraSearchQuery;

  constructor(query: TypsastraSearchQuery) {
    this.spec = query;
  }

  nextMatch(state: EditorState, curFrom: number, curTo: number): SearchRange | null {
    let cursor = this.spec.cursor(state, curTo, state.doc.length);
    let result = cursor.nextOverlapping();
    if (result.done) {
      const end = Math.min(state.doc.length, curFrom + this.spec.unquotedSearch.length + 2);
      cursor = this.spec.cursor(state, 0, end);
      result = cursor.nextOverlapping();
    }
    return result.done || (result.value.from === curFrom && result.value.to === curTo)
      ? null
      : result.value;
  }

  private previousInRange(state: EditorState, from: number, to: number): SearchRange | null {
    for (let position = to;;) {
      const start = Math.max(from, position - 10_000 - this.spec.unquotedSearch.length);
      const cursor = this.spec.cursor(state, start, position);
      let range: SearchRange | null = null;
      while (!cursor.nextOverlapping().done) range = cursor.value;
      if (range) return range;
      if (start === from) return null;
      position -= 10_000;
    }
  }

  prevMatch(state: EditorState, curFrom: number, curTo: number): SearchRange | null {
    const found = this.previousInRange(state, 0, curFrom)
      ?? this.previousInRange(
        state,
        Math.max(0, curTo - this.spec.unquotedSearch.length - 2),
        state.doc.length
      );
    return found && (found.from !== curFrom || found.to !== curTo) ? found : null;
  }

  getReplacement(): string {
    return unquote(this.spec.replace, this.spec.literal);
  }

  matchAll(state: EditorState, limit: number): SearchRange[] | null {
    const cursor = this.spec.cursor(state, 0, state.doc.length);
    const ranges: SearchRange[] = [];
    while (!cursor.next().done) {
      if (ranges.length >= limit) return null;
      ranges.push(cursor.value);
    }
    return ranges;
  }

  highlight(
    state: EditorState,
    from: number,
    to: number,
    add: (from: number, to: number) => void
  ): void {
    const margin = this.spec.unquotedSearch.length + 2;
    const cursor = this.spec.cursor(
      state,
      Math.max(0, from - margin),
      Math.min(state.doc.length, to + margin)
    );
    while (!cursor.next().done) add(cursor.value.from, cursor.value.to);
  }
}

export class TypsastraSearchQuery extends SearchQuery {
  readonly matchDiacritics: boolean;
  readonly unquotedSearch: string;

  constructor(config: TypsastraSearchQueryConfig) {
    super(config);
    this.matchDiacritics = config.matchDiacritics !== false;
    this.unquotedSearch = unquote(config.search, !!config.literal);
  }

  override eq(other: SearchQuery): boolean {
    return super.eq(other)
      && this.matchDiacritics === (
        other instanceof TypsastraSearchQuery ? other.matchDiacritics : true
      );
  }

  override getCursor(state: EditorState | Text, from = 0, to?: number): Iterator<SearchRange> {
    if (this.regexp) return super.getCursor(state, from, to) as Iterator<SearchRange>;
    const editorState = asEditorState(state);
    return this.cursor(editorState, from, to ?? editorState.doc.length);
  }

  cursor(state: EditorState, from: number, to: number): DiacriticSearchCursor {
    const normalize = (text: string) => normalizeSearchText(
      text,
      this.caseSensitive,
      this.matchDiacritics
    );
    return new DiacriticSearchCursor(
      new SearchCursor(state.doc, this.unquotedSearch, from, to, normalize),
      state,
      this
    );
  }

  create(): SearchRuntime {
    if (!this.regexp) return new LiteralSearchRuntime(this);
    const base = new SearchQuery({
      search: this.search,
      caseSensitive: this.caseSensitive,
      literal: this.literal,
      regexp: true,
      replace: this.replace,
      wholeWord: this.wholeWord,
      test: this.test
    }) as RuntimeSearchQuery;
    return base.create();
  }
}

/**
 * Runs the editor's own literal/regex matching against a plain text file.
 * This is shared by the editor search panel and project search so both use the
 * same case, whole-word, diacritic, Unicode, and regex semantics.
 */
export function findEditorSearchMatches(
  text: string,
  config: TypsastraSearchQueryConfig,
  limit = Number.POSITIVE_INFINITY
): EditorSearchMatchResult {
  let state: EditorState;
  let query: TypsastraSearchQuery;
  try {
    state = EditorState.create({ doc: text });
    query = new TypsastraSearchQuery(config);
  } catch (error) {
    return { matches: [], truncated: false, error: String(error) };
  }
  if (!query.valid) {
    return {
      matches: [],
      truncated: false,
      error: config.regexp ? "Invalid regular expression." : null,
    };
  }

  const matches: EditorSearchMatch[] = [];
  try {
    const cursor = query.getCursor(state);
    for (;;) {
      const result = cursor.next();
      if (result.done) break;
      if (matches.length >= limit) return { matches, truncated: true, error: null };
      const from = result.value.from;
      const to = result.value.to;
      const line = state.doc.lineAt(from);
      const lineTo = Math.max(from, Math.min(to, line.to));
      matches.push({
        from,
        to,
        lineNumber: line.number,
        lineFrom: line.from,
        lineText: line.text,
        lineRanges: [{ from: from - line.from, to: lineTo - line.from }],
      });
    }
  } catch (error) {
    return { matches, truncated: false, error: String(error) };
  }
  return { matches, truncated: false, error: null };
}
