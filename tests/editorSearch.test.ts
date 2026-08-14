import { describe, expect, test } from "bun:test";
import { EditorState } from "@codemirror/state";
import { SearchQuery, getSearchQuery, search, setSearchQuery } from "@codemirror/search";
import { codeFolding, foldEffect } from "@codemirror/language";
import {
  editorMatchQuery,
  editorSelectionMatchRangeAllowed,
  firstSearchMatch,
  firstVisibleSearchMatch,
  foldedRangeForSearchMatch,
  mergeVisibleSearchRanges,
  searchQueryHasVisibleMatch
} from "../src/editor/extensions";
import { collapseSearchSelection, TypsastraSearchQuery } from "../src/editor/search";

describe("editor search navigation", () => {
  test("disables match paint and full-document markers in low memory mode", async () => {
    const controllerSource = await Bun.file(
      new URL("../src/editor/editorController.ts", import.meta.url),
    ).text();
    const css = await Bun.file(new URL("../src/style.css", import.meta.url)).text();

    expect(controllerSource).toContain("if (this.port.isLowMemoryMode())");
    expect(controllerSource).toContain("this.matchMarkerTargets.clear()");
    expect(css).toContain(".low-memory-mode .cm-editor .cm-searchMatch");
  });

  test("uses a case-insensitive literal query for selected text", () => {
    const state = EditorState.create({
      doc: "Typsastra typsastra TYPSASTRA Typ-sastra",
      selection: { anchor: 0, head: 9 }
    });
    const query = editorMatchQuery(state);

    expect(query).not.toBeNull();
    expect(Array.from(query!.getCursor(state))).toEqual([
      { from: 0, to: 9, precise: true },
      { from: 10, to: 19, precise: true },
      { from: 20, to: 29, precise: true }
    ]);
  });

  test("does not create selection search queries for cursors or multiline selections", () => {
    const cursor = EditorState.create({ doc: "word", selection: { anchor: 2 } });
    const multiline = EditorState.create({ doc: "one\ntwo", selection: { anchor: 0, head: 7 } });
    const whitespace = EditorState.create({ doc: "word     word", selection: { anchor: 4, head: 9 } });

    expect(editorMatchQuery(cursor)).toBeNull();
    expect(editorMatchQuery(multiline)).toBeNull();
    expect(editorMatchQuery(whitespace)).toBeNull();
  });

  test("keeps phrase selection search available across wrapped visual rows", () => {
    const state = EditorState.create({
      doc: "approved specifications approved specifications",
      selection: { anchor: 0, head: 23 }
    });

    expect(Array.from(editorMatchQuery(state)!.getCursor(state))).toEqual([
      { from: 0, to: 23, precise: true },
      { from: 24, to: 47, precise: true }
    ]);
  });

  test("matches a selected Khmer consonant only at complete grapheme boundaries", () => {
    const state = EditorState.create({
      doc: "ន ន៍ ន់ នាំ កន",
      selection: { anchor: 0, head: 1 },
    });
    const rawMatches = Array.from(editorMatchQuery(state)!.getCursor(state));
    const matches = rawMatches.filter(match =>
      editorSelectionMatchRangeAllowed(state, match.from, match.to)
    );

    expect(rawMatches.length).toBeGreaterThan(matches.length);
    expect(matches.map(match => state.sliceDoc(match.from, match.to))).toEqual(["ន", "ន"]);
    expect(matches.map(match => match.from)).toEqual([0, 13]);
  });

  test("keeps explicit Find queries substring-based for Khmer", () => {
    let state = EditorState.create({
      doc: "ន ន៍ ន់ នាំ",
      extensions: [search()],
    });
    state = state.update({ effects: setSearchQuery.of(new SearchQuery({ search: "ន" })) }).state;
    expect(editorSelectionMatchRangeAllowed(state, 2, 3)).toBe(true);
  });

  test("matches diacritics exactly by default", () => {
    const state = EditorState.create({ doc: "cafe café résumé" });
    const plain = new TypsastraSearchQuery({ search: "cafe" });
    const accented = new TypsastraSearchQuery({ search: "résumé" });

    expect(Array.from(plain.getCursor(state))).toEqual([
      { from: 0, to: 4, precise: true }
    ]);
    expect(Array.from(accented.getCursor(state))).toEqual([
      { from: 10, to: 18, precise: true }
    ]);
  });

  test("can ignore generic diacritics without leaving decomposed marks behind", () => {
    const state = EditorState.create({ doc: "café résumé" });
    const cafe = new TypsastraSearchQuery({ search: "cafe", matchDiacritics: false });
    const resume = new TypsastraSearchQuery({ search: "resume", matchDiacritics: false });

    expect(Array.from(cafe.getCursor(state))).toEqual([
      { from: 0, to: 4, precise: true }
    ]);
    expect(Array.from(resume.getCursor(state))).toEqual([
      { from: 5, to: 13, precise: true }
    ]);
  });

  test("does not strip complex-script marks when diacritic matching is disabled", () => {
    const state = EditorState.create({ doc: "ក" });
    const query = new TypsastraSearchQuery({ search: "កំ", matchDiacritics: false });

    expect(Array.from(query.getCursor(state))).toEqual([]);
  });

  test("keeps regular-expression searches authoritative", () => {
    const state = EditorState.create({ doc: "café cafe" });
    const query = new TypsastraSearchQuery({
      search: "cafe",
      regexp: true,
      matchDiacritics: false
    });

    expect(Array.from(query.getCursor(state))).toEqual([
      { from: 5, to: 9, precise: true, match: expect.any(Array) }
    ]);
  });

  test("installs the custom query into CodeMirror search state", () => {
    let state = EditorState.create({ doc: "résumé", extensions: [search()] });
    const query = new TypsastraSearchQuery({ search: "resume", matchDiacritics: false });
    state = state.update({ effects: setSearchQuery.of(query) }).state;

    expect(getSearchQuery(state)).toBe(query);
    expect(query.create().matchAll(state, 100)).toEqual([
      { from: 0, to: 6, precise: true }
    ]);
  });

  test("clears a previous search match before reopening an empty search", () => {
    const state = EditorState.create({
      doc: "café",
      selection: { anchor: 0, head: 4 }
    });

    expect(collapseSearchSelection(state).main).toMatchObject({ from: 4, to: 4 });
  });

  test("ships an incremental current/total result counter", async () => {
    const source = await Bun.file(new URL("../src/editor/extensions.ts", import.meta.url)).text();
    const searchSource = await Bun.file(new URL("../src/editor/search.ts", import.meta.url)).text();
    const css = await Bun.file(new URL("../src/style.css", import.meta.url)).text();

    expect(source).toContain("cm-search-match-count");
    expect(source).toContain("performance.now() - startedAt < 4");
    expect(source).toContain("`${current}/${total}`");
    expect(searchSource).toContain("queueMicrotask(() =>");
    expect(searchSource).not.toContain("mount(): void {\n    this.searchField.select();\n    this.view.dispatch");
    expect(css).toContain(".cm-panel.cm-search .cm-search-match-count");
  });

  test("uses compact accessible app icons for search actions and toggles", async () => {
    const source = await Bun.file(new URL("../src/editor/search.ts", import.meta.url)).text();
    const caretSource = await Bun.file(new URL("../src/ui/editorCaretInput.ts", import.meta.url)).text();
    const css = await Bun.file(new URL("../src/style.css", import.meta.url)).text();

    expect(source).toContain('createAppIcon(icon, { size: 16 })');
    expect(source).toContain('iconButton("next", "Next match", "arrowDown"');
    expect(source).toContain('iconToggle(this.caseField, "Match case", "caseSensitive")');
    expect(source).toContain('iconToggle(this.diacriticsField, "Match diacritics", "languages")');
    expect(source).toContain('field.setAttribute("aria-label", label)');
    expect(css).toContain(".cm-panel.cm-search .cm-search-icon-toggle:has(input:checked)");
    expect(css).toContain("width: 100% !important");
    expect(css).toContain("height: calc(var(--editor-line-height-px, 23.8px) + 10px) !important");
    expect(source).toContain("editorCaretInput(this.searchField)");
    expect(source).toContain("editorCaretInput(this.replaceField)");
    expect(caretSource).toContain('field.addEventListener("keydown"');
    expect(caretSource).toContain("CARET_MOVEMENT_KEYS.has(event.key)");
    expect(caretSource).toContain("scheduleCaretUpdate()");
    expect(caretSource).toContain('field.addEventListener("pointermove"');
    expect(css).toContain(".typsastra-caret-input-shell:focus-within.typsastra-caret-input-active");
    expect(css).toContain("animation: none");
    expect(css).toContain(".cm-panel.cm-search .cm-search-editor-caret");
    expect(css).toContain("border-left: 2px solid var(--editor-cursor-color, #3db489)");
    expect(css).toContain("height: var(--editor-line-height-px, 23.8px)");
    expect(css).toContain("grid-template-columns:");
    expect(css).toContain("minmax(120px, 1fr)");
    expect(css).toContain(".cm-editor .cm-searchMatch {");
    expect(css).toContain("--ui-search-match-background: color-mix(in srgb, var(--ui-warning-color) 30%, var(--ui-bg))");
    expect(css).toContain("background: var(--ui-search-match-background)");
    expect(css).toContain("outline: none");
    const matchHighlightCss = css.slice(
      css.indexOf(".cm-editor .cm-selectionMatch"),
      css.indexOf(".cm-editor .cm-searchMatch-selected"),
    );
    expect(matchHighlightCss).not.toContain("padding-block");
    expect(matchHighlightCss).not.toContain("box-decoration-break");
    expect(css).toContain(".cm-editor .cm-searchMatch-selected");
    expect(css).toContain("background: transparent !important");
    expect(css).toContain("grid-column: 1");
    expect(source).not.toContain('right: 20px');
  });

  test("centers search navigation results when document boundaries allow it", async () => {
    const source = await Bun.file(new URL("../src/editor/extensions.ts", import.meta.url)).text();

    expect(source).toContain('scrollToMatch: range => EditorView.scrollIntoView(range, { y: "center" })');
    expect(source).toContain('EditorView.scrollIntoView(selection.main, { y: "center" })');
  });

  test("draws selection matches without splitting shaped text into DOM spans", async () => {
    const source = await Bun.file(new URL("../src/editor/extensions.ts", import.meta.url)).text();

    expect(source).toContain('class: "cm-selectionMatchLayer"');
    expect(source).toContain("RectangleMarker.forRange(");
    expect(source).not.toContain('Decoration.mark({ class: "cm-selectionMatch" })');
  });

  test("recognizes a match in the visible editor range", () => {
    const state = EditorState.create({ doc: "first target\nsecond line\ntarget again" });
    const query = new SearchQuery({ search: "target" });

    expect(searchQueryHasVisibleMatch(state, query, [{ from: 20, to: state.doc.length }])).toBe(true);
    expect(firstVisibleSearchMatch(state, query, [{ from: 20, to: state.doc.length }]))
      .toEqual({ from: 25, to: 31, precise: true });
  });

  test("falls back to the first document match when the viewport has none", () => {
    const state = EditorState.create({ doc: "first target\nsecond line\nnothing here" });
    const query = new SearchQuery({ search: "target" });
    const visible = [{ from: 25, to: state.doc.length }];

    expect(searchQueryHasVisibleMatch(state, query, visible)).toBe(false);
    expect(firstSearchMatch(state, query)).toEqual({ from: 6, to: 12, precise: true });
  });

  test("does not treat a nearby off-canvas match as visible", () => {
    const state = EditorState.create({ doc: `target${" ".repeat(300)}visible canvas` });
    const query = new SearchQuery({ search: "target" });
    const visible = [{ from: 306, to: state.doc.length }];

    expect(searchQueryHasVisibleMatch(state, query, visible)).toBe(false);
  });

  test("keeps wrapped visual rows separate from off-canvas text on the same logical line", () => {
    const ranges = mergeVisibleSearchRanges([
      { from: 0, to: 20 },
      { from: 20, to: 40 },
      { from: 80, to: 100 }
    ]);

    expect(ranges).toEqual([
      { from: 0, to: 40 },
      { from: 80, to: 100 }
    ]);
    const state = EditorState.create({ doc: `${"a".repeat(60)}target${"a".repeat(40)}` });
    const query = new SearchQuery({ search: "target" });
    expect(searchQueryHasVisibleMatch(state, query, ranges)).toBe(false);
  });

  test("does not navigate for an empty query", () => {
    const state = EditorState.create({ doc: "target" });
    const query = new SearchQuery({ search: "" });

    expect(searchQueryHasVisibleMatch(state, query, [{ from: 0, to: state.doc.length }])).toBe(false);
    expect(firstSearchMatch(state, query)).toBeNull();
  });

  test("does not count a folded match as visible", () => {
    let state = EditorState.create({
      doc: "before [hidden target] after",
      extensions: [codeFolding()]
    });
    state = state.update({ effects: foldEffect.of({ from: 7, to: 22 }) }).state;
    const query = new SearchQuery({ search: "target" });
    const match = firstSearchMatch(state, query);

    expect(match).not.toBeNull();
    expect(foldedRangeForSearchMatch(state, match!)).toEqual({ from: 7, to: 22 });
    expect(searchQueryHasVisibleMatch(state, query, [{ from: 0, to: state.doc.length }])).toBe(false);
  });

  test("still accepts an unfolded match in the same viewport", () => {
    let state = EditorState.create({
      doc: "[hidden target] visible target",
      extensions: [codeFolding()]
    });
    state = state.update({ effects: foldEffect.of({ from: 0, to: 15 }) }).state;
    const query = new SearchQuery({ search: "target" });

    expect(searchQueryHasVisibleMatch(state, query, [{ from: 0, to: state.doc.length }])).toBe(true);
  });
});
