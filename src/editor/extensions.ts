import { Extension, Compartment, EditorSelection, EditorState, StateEffect, RangeSetBuilder, Prec } from "@codemirror/state";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { lineNumbers, highlightActiveLineGutter, highlightActiveLine, drawSelection, dropCursor, keymap, EditorView, ViewPlugin, Decoration, DecorationSet, ViewUpdate, RectangleMarker, layer, tooltips } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, insertNewlineAndIndent, insertTab } from "@codemirror/commands";
import {
  SearchQuery,
  closeSearchPanel,
  getSearchQuery,
  search,
  searchKeymap,
  searchPanelOpen
} from "@codemirror/search";
import { TypsastraSearchPanel } from "./search";
import { baseEditorLayoutTheme, editorFontTheme, typstColorHighlighting, typstFontHighlighting, typstFunctionHighlighting, typstSemanticHighlighting, typstVariableHighlighting } from "./themes";
import {
  codeFolding,
  foldGutter,
  foldKeymap,
  foldedRanges,
  foldService,
  indentUnit,
  syntaxHighlighting,
  unfoldEffect
} from "@codemirror/language";
import { typstLanguage } from "./typstLanguage";
import { editorDiagnosticsExtension } from "./diagnostics";
import { indentationMarkers } from '@replit/codemirror-indentation-markers';

import * as uiwThemes from "@uiw/codemirror-themes-all";
import { oneDark } from "@codemirror/theme-one-dark";
import {
  createTypstAutocomplete,
  isInsideTypstFunctionArgumentsAt,
  isTypstFunctionArgumentContextAt,
  type ProviderCapabilities
} from "./autocomplete";
import {
  acceptCompletion,
  completionKeymap,
  completionStatus,
  closeBrackets,
  moveCompletionSelection,
  startCompletion
} from "@codemirror/autocomplete";
import { bracketMatching } from "@codemirror/language";
import { toggleLineComment } from "@codemirror/commands";
import { bracketColorizer } from "./bracketColorizer";
import { createHoverTooltip } from "./hover";
import type { TinymistLspClient } from "../compiler/lsp";
import {
  EXPLORER_IMAGE_DRAG_TYPE,
  clipboardImageFiles,
  explorerImageDragPath,
  moveImageDropCaret,
  readClipboardImageFiles,
  type ClipboardImageData,
} from "./imageDrop";
import { typstFunctionFoldService } from "./folding";
import { deleteNextGrapheme, deletePreviousGraphemeOrPair, graphemeBoundaries, graphemePointerSelection, graphemeSelectionBoundaryFilter, moveNextGrapheme, movePreviousGrapheme, selectNextGrapheme, selectPreviousGrapheme, type GraphemePointerDebugEvent } from "./grapheme";
import { editingPolicyRegistry } from "./editingPolicies/registry";
import { showInvisibleCharacters } from "./invisibles";
import { TYPSASTRA_GREEN, TYPSASTRA_GREEN_GLOW } from "../ui/brandColors";
import { wrappedLineIndentation } from "./wrappedIndent";
import { contextualDoubleQuoteExtension } from "./quoteEditing";
import { imageOptimizationWarningsExtension } from "./imageWarnings";
import { selectionPairReplacementExtension } from "./selectionPairEditing";

export const themeCompartment = new Compartment();
export const wrapCompartment = new Compartment();
export const editorFontCompartment = new Compartment();
export const lineNumbersCompartment = new Compartment();
export const activeLineCompartment = new Compartment();
export const closeBracketsCompartment = new Compartment();
export const indentationGuidesCompartment = new Compartment();
export const tabSizeCompartment = new Compartment();
export const completionCompartment = new Compartment();
export const showZwsCompartment = new Compartment();
export const languageCompartment = new Compartment();

const selectionStateClass = EditorView.editorAttributes.compute(["selection"], state => ({
  class: state.selection.ranges.some(range => !range.empty) ? "cm-has-selection" : ""
}));

export function visibleIndentationMarkers(): Extension {
  const inactive = "color-mix(in srgb, var(--ui-text) 38%, transparent)";
  const active = "color-mix(in srgb, var(--ui-accent-color) 58%, var(--ui-text))";
  return indentationMarkers({
    thickness: 1,
    activeThickness: 1,
    colors: {
      light: inactive,
      dark: inactive,
      activeLight: active,
      activeDark: active,
    },
  });
}

/**
 * Keeps one viewport of non-document space after the final line. A CSS
 * pseudo-element provides the space, so CodeMirror does not create a line,
 * line number, or editable document content for it.
 */
export function scrollPastDocumentEnd(): Extension {
  return ViewPlugin.fromClass(class {
    private readonly resizeObserver: ResizeObserver;

    constructor(private readonly view: EditorView) {
      this.resizeObserver = new ResizeObserver(() => this.updateHeight());
      this.resizeObserver.observe(view.scrollDOM);
      this.updateHeight();
    }

    destroy(): void {
      this.resizeObserver.disconnect();
      this.view.contentDOM.style.removeProperty("--typsastra-scroll-past-end-height");
      this.view.dom.style.removeProperty("--typsastra-gutter-width");
    }

    private updateHeight(): void {
      // Reserve five visible lines for the final document line and the cursor
      // when the user reaches the end, while still providing almost a full
      // viewport of breathing room below the document. Short editor panes
      // still retain five blank lines rather than collapsing the spacer.
      // `defaultLineHeight` can retain CodeMirror's unstyled metric while
      // Typsastra applies its own CSS line-height. Read the rendered metric so
      // the visual spacer is measured in actual displayed lines.
      const renderedLineHeight = Number.parseFloat(
        getComputedStyle(this.view.contentDOM).lineHeight
      );
      const lineHeight = Number.isFinite(renderedLineHeight) && renderedLineHeight > 0
        ? renderedLineHeight
        : this.view.defaultLineHeight;
      const reservedLinesHeight = lineHeight * 5;
      const height = Math.max(
        reservedLinesHeight,
        this.view.scrollDOM.clientHeight - reservedLinesHeight
      );
      const gutterWidth = this.view.dom.querySelector<HTMLElement>(".cm-gutters")?.getBoundingClientRect().width ?? 0;
      this.view.contentDOM.style.setProperty("--typsastra-scroll-past-end-height", `${height}px`);
      this.view.dom.style.setProperty("--typsastra-gutter-width", `${gutterWidth}px`);
    }
  });
}

const completionNavigationHandler = Prec.highest(EditorView.domEventHandlers({
  keydown(event, view) {
    let handled = false;
    const completionActive = completionStatus(view.state) === "active";
    const insideFunctionArguments = isInsideTypstFunctionArgumentsAt(
      view.state.doc,
      view.state.selection.main.head
    );
    if (event.ctrlKey && !event.altKey && !event.metaKey && event.code === "Space") {
      // Escape can dismiss the menu while an asynchronous LSP query is still
      // settling. Resetting the selection transaction aborts that stale query
      // before explicitly starting a new one, so Ctrl+Space can reopen the
      // same token without requiring another edit.
      view.dispatch({ selection: view.state.selection });
      queueMicrotask(() => startCompletion(view));
      handled = true;
    } else if (event.key === "ArrowDown") {
      handled = moveCompletionSelection(true)(view);
    } else if (event.key === "ArrowUp") {
      handled = moveCompletionSelection(false)(view);
    } else if (event.key === "PageDown") {
      handled = moveCompletionSelection(true, "page")(view);
    } else if (event.key === "PageUp") {
      handled = moveCompletionSelection(false, "page")(view);
    } else if (event.key === "Enter" && event.ctrlKey && insideFunctionArguments) {
      handled = insertNewlineAndIndent(view);
      if (handled) queueMicrotask(() => startCompletion(view));
    } else if (event.key === "Tab" && completionActive) {
      handled = acceptCompletion(view);
    } else if (event.key === "Enter") {
      handled = acceptCompletion(view);
    }
    if (!handled) return false;
    event.preventDefault();
    return true;
  }
}));

const functionArgumentCompletionTrigger = EditorView.updateListener.of(update => {
  if (!update.docChanged) return;
  let enteredArgumentSlot = false;
  update.changes.iterChanges((_fromA, _toA, _fromB, _toB, inserted) => {
    if (/[,\s]$/u.test(inserted.toString())) enteredArgumentSlot = true;
  });
  if (!enteredArgumentSlot) return;

  const head = update.state.selection.main.head;
  if (!isTypstFunctionArgumentContextAt(update.state.doc, head)) return;
  window.setTimeout(() => {
    if (!update.view.dom.isConnected) return;
    const currentHead = update.view.state.selection.main.head;
    if (!isTypstFunctionArgumentContextAt(update.view.state.doc, currentHead)) return;
    if (completionStatus(update.view.state) === null) startCompletion(update.view);
  }, 0);
});

type SearchRange = { from: number; to: number };

export function selectedEditorClipboardText(state: EditorState): string | null {
  const selected = state.selection.ranges
    .filter(range => !range.empty)
    .map(range => state.sliceDoc(range.from, range.to));
  return selected.length > 0 ? selected.join(state.lineBreak) : null;
}

function writeEditorClipboardText(event: ClipboardEvent, view: EditorView): boolean {
  const text = selectedEditorClipboardText(view.state);
  if (text === null) return false;
  event.clipboardData?.setData("text/plain", text);
  event.preventDefault();
  // WebView2's browser-owned clipboard payload can paste normally while not
  // being retained by Windows clipboard history. Finish the copy through
  // Tauri's native text clipboard so Windows receives a standard text item.
  void writeText(text).catch(error => {
    console.error("Failed to write editor selection to the native clipboard:", error);
  });
  return true;
}

export function firstSearchMatch(
  state: EditorState,
  query: SearchQuery,
  from = 0,
  to = state.doc.length
): SearchRange | null {
  if (!query.valid) return null;
  const cursor = query.getCursor(state, from, to);
  const result = cursor.next();
  return result.done ? null : result.value;
}

const MAX_SELECTION_SEARCH_LENGTH = 200;

/**
 * Returns the query that should drive editor match feedback. An open search
 * panel is authoritative. Otherwise, a single non-empty selection becomes a
 * literal, case-insensitive query for lightweight selection matching.
 */
export function editorMatchQuery(state: EditorState): SearchQuery | null {
  if (searchPanelOpen(state)) {
    const query = getSearchQuery(state);
    return query.valid ? query : null;
  }

  if (state.selection.ranges.length !== 1) return null;
  const selection = state.selection.main;
  const length = selection.to - selection.from;
  if (length <= 0 || length > MAX_SELECTION_SEARCH_LENGTH) return null;

  const selectedText = state.sliceDoc(selection.from, selection.to);
  if (!selectedText.trim() || /[\r\n]/u.test(selectedText)) return null;
  return new SearchQuery({
    search: selectedText,
    caseSensitive: false,
    literal: true
  });
}

export function editorSelectionMatchRangeAllowed(
  state: EditorState,
  from: number,
  to: number,
): boolean {
  if (searchPanelOpen(state)) return true;
  const selection = state.selection.main;
  const selectedText = state.sliceDoc(selection.from, selection.to);
  if (!/[\u1780-\u17ff]/u.test(selectedText)) return true;
  if (from < 0 || to <= from || to > state.doc.length) return false;
  const line = state.doc.lineAt(from);
  if (to > line.to) return false;
  const localFrom = from - line.from;
  const localTo = to - line.from;
  const boundaries = graphemeBoundaries(line.text);
  return boundaries.some(boundary => boundary.from === localFrom)
    && boundaries.some(boundary => boundary.to === localTo);
}

const caseInsensitiveSelectionMatches = layer({
  above: false,
  class: "cm-selectionMatchLayer",
  update(update): boolean {
    return update.docChanged
      || update.selectionSet
      || update.viewportChanged
      || update.geometryChanged
      || searchPanelOpen(update.state) !== searchPanelOpen(update.startState);
  },
  markers(view) {
    if (searchPanelOpen(view.state)) return [];
    const query = editorMatchQuery(view.state);
    if (!query) return [];

    const markers: RectangleMarker[] = [];
    for (const visible of view.visibleRanges) {
      const cursor = query.getCursor(view.state, visible.from, visible.to);
      for (let result = cursor.next(); !result.done; result = cursor.next()) {
        const { from, to } = result.value;
        if (!editorSelectionMatchRangeAllowed(view.state, from, to)) continue;
        // The native selection layer already paints the selected occurrence.
        // Drawing matches in a view layer keeps Khmer text in a single DOM text
        // run, preserving its shaping and line wrapping across every platform.
        const selection = view.state.selection.main;
        if (from < selection.to && to > selection.from) continue;
        markers.push(...RectangleMarker.forRange(
          view,
          "cm-selectionMatch",
          EditorSelection.range(from, to),
        ));
      }
    }
    return markers;
  }
});

export function foldedRangeForSearchMatch(
  state: EditorState,
  match: SearchRange
): SearchRange | null {
  let folded: SearchRange | null = null;
  const matchTo = Math.max(match.to, Math.min(state.doc.length, match.from + 1));
  foldedRanges(state).between(
    Math.max(0, match.from - 1),
    Math.min(state.doc.length, matchTo + 1),
    (from, to) => {
      if (!folded && from < matchTo && to > match.from) folded = { from, to };
    }
  );
  return folded;
}

export function searchQueryHasVisibleMatch(
  state: EditorState,
  query: SearchQuery,
  visibleRanges: readonly SearchRange[]
): boolean {
  return firstVisibleSearchMatch(state, query, visibleRanges) !== null;
}

export function firstVisibleSearchMatch(
  state: EditorState,
  query: SearchQuery,
  visibleRanges: readonly SearchRange[]
): SearchRange | null {
  if (!query.valid) return null;
  for (const range of visibleRanges) {
    // Include a small boundary margin for regular expressions and matches that
    // begin just outside a wrapped viewport range.
    const cursor = query.getCursor(
      state,
      Math.max(0, range.from - 250),
      Math.min(state.doc.length, range.to + 250)
    );
    for (let result = cursor.next(); !result.done; result = cursor.next()) {
      if (
        result.value.to > range.from
        && result.value.from < range.to
        && !foldedRangeForSearchMatch(state, result.value)
      ) return result.value;
      if (result.value.from >= range.to) break;
    }
  }
  return null;
}

export function mergeVisibleSearchRanges(ranges: readonly SearchRange[]): SearchRange[] {
  const sorted = ranges
    .filter(range => range.to >= range.from)
    .map(range => ({ from: range.from, to: range.to }))
    .sort((a, b) => a.from - b.from || a.to - b.to);
  const merged: SearchRange[] = [];
  for (const range of sorted) {
    const previous = merged[merged.length - 1];
    if (previous && range.from <= previous.to) {
      previous.to = Math.max(previous.to, range.to);
    } else {
      merged.push(range);
    }
  }
  return merged;
}

function editorVisibleCanvasRanges(view: EditorView): SearchRange[] {
  const scrollRect = view.scrollDOM.getBoundingClientRect();
  const contentRect = view.contentDOM.getBoundingClientRect();
  const left = Math.max(scrollRect.left, contentRect.left) + 1;
  const right = Math.max(
    left,
    Math.min(scrollRect.right, scrollRect.left + view.scrollDOM.clientWidth, contentRect.right) - 1
  );
  const top = Math.max(scrollRect.top, contentRect.top) + 1;
  const bottom = Math.max(top, Math.min(scrollRect.bottom, contentRect.bottom) - 1);
  const step = Math.max(2, view.defaultLineHeight / 2);
  const ranges: SearchRange[] = [];
  const sampleRow = (y: number) => {
    const leftPosition = view.posAtCoords({ x: left, y });
    const rightPosition = view.posAtCoords({ x: right, y });
    if (leftPosition === null && rightPosition === null) return;
    const from = Math.min(leftPosition ?? rightPosition!, rightPosition ?? leftPosition!);
    const to = Math.max(leftPosition ?? rightPosition!, rightPosition ?? leftPosition!);
    ranges.push({ from, to });
  };
  for (let y = top; y < bottom; y += step) sampleRow(y);
  sampleRow(bottom);
  return mergeVisibleSearchRanges(ranges);
}

const visibleFirstSearchNavigation = ViewPlugin.fromClass(class {
  private frame: number | null = null;

  update(update: ViewUpdate): void {
    const query = getSearchQuery(update.state);
    const previousQuery = getSearchQuery(update.startState);
    const panelOpened = searchPanelOpen(update.state) && !searchPanelOpen(update.startState);
    if (
      !searchPanelOpen(update.state)
      || (!panelOpened && query.eq(previousQuery) && !update.geometryChanged)
    ) return;
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      const currentQuery = getSearchQuery(update.view.state);
      if (!searchPanelOpen(update.view.state) || !currentQuery.eq(query) || !currentQuery.valid) return;
      const visibleCanvas = editorVisibleCanvasRanges(update.view);
      const visible = firstVisibleSearchMatch(update.view.state, currentQuery, visibleCanvas);
      const target = visible ?? firstSearchMatch(update.view.state, currentQuery);
      if (!target) return;
      const folded = foldedRangeForSearchMatch(update.view.state, target);
      const selection = EditorSelection.single(target.from, target.to);
      const effects = [
        ...(folded ? [unfoldEffect.of(folded)] : []),
        ...(visible ? [] : [EditorView.scrollIntoView(selection.main, { y: "center" })])
      ];
      update.view.dispatch({
        selection,
        effects,
        userEvent: "select.search"
      });
    });
  }

  destroy(): void {
    if (this.frame !== null) cancelAnimationFrame(this.frame);
  }
});

const searchMatchCounter = ViewPlugin.fromClass(class {
  private generation = 0;
  private frame: number | null = null;

  constructor(private readonly view: EditorView) {}

  update(update: ViewUpdate): void {
    if (
      searchPanelOpen(update.state)
      && (
        !searchPanelOpen(update.startState)
        || !getSearchQuery(update.state).eq(getSearchQuery(update.startState))
        || update.docChanged
        || update.selectionSet
      )
    ) {
      this.schedule();
    } else if (!searchPanelOpen(update.state)) {
      this.cancel();
    }
  }

  private statusElement(): HTMLElement | null {
    const panel = this.view.dom.querySelector<HTMLElement>(".cm-panel.cm-search");
    if (!panel) return null;
    let status = panel.querySelector<HTMLElement>(".cm-search-match-count");
    if (status) return status;
    status = document.createElement("span");
    status.className = "cm-search-match-count";
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    panel.append(status);
    return status;
  }

  private schedule(): void {
    const generation = ++this.generation;
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      if (generation !== this.generation || !searchPanelOpen(this.view.state)) return;
      const query = getSearchQuery(this.view.state);
      const status = this.statusElement();
      if (!status) return;
      if (!query.valid) {
        status.textContent = "0/0";
        status.title = "No matches";
        return;
      }

      const state = this.view.state;
      const selection = state.selection.main;
      const cursor = query.getCursor(state);
      let total = 0;
      let current = 0;
      status.textContent = "0/0";
      status.title = "Counting matches";

      const scan = () => {
        if (generation !== this.generation || this.view.state !== state) return;
        const startedAt = performance.now();
        for (let processed = 0; processed < 500 && performance.now() - startedAt < 4; processed++) {
          const result = cursor.next();
          if (result.done) {
            status.textContent = `${current}/${total}`;
            status.title = total === 0
              ? "No matches"
              : current > 0
                ? `Match ${current} of ${total}`
                : `${total} matches`;
            this.frame = null;
            return;
          }
          total += 1;
          if (result.value.from === selection.from && result.value.to === selection.to) current = total;
        }
        status.textContent = `${current}/${total}`;
        this.frame = requestAnimationFrame(scan);
      };
      scan();
    });
  }

  private cancel(): void {
    this.generation += 1;
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
  }

  destroy(): void {
    this.cancel();
  }
});

function foldedTypstPlaceholderSuffix(state: EditorState, range: { from: number; to: number }): string {
  const foldedText = state.doc.sliceString(range.from, range.to).trimEnd();
  const lastChar = foldedText[foldedText.length - 1] ?? "";
  return /[)\]}]/.test(lastChar) ? lastChar : "";
}

function foldedTypstPlaceholderDOM(_view: EditorView, onclick: (event: Event) => void, suffix: string | null): HTMLElement {
  const placeholder = document.createElement("span");
  placeholder.className = "cm-foldPlaceholder";
  placeholder.textContent = ` ... ${suffix ?? ""}`;
  placeholder.title = "This content is folded. Click to expand.";
  placeholder.addEventListener("click", onclick);
  return placeholder;
}

function typstFoldMarkerDOM(open: boolean): HTMLElement {
  const marker = document.createElement("span");
  const label = open ? "Fold line" : "Unfold line";
  marker.textContent = open ? "-" : "+";
  marker.dataset.folded = String(!open);
  marker.title = label;
  marker.setAttribute("aria-label", label);
  return marker;
}

const preventEscapedBracketAutoClose = EditorView.inputHandler.of((view, from, to, text) => {
  const bracketsToPrevent = ["$", "(", "[", "{", "'", "*", "_"];
  if (bracketsToPrevent.includes(text)) {
    if (from > 0 && view.state.doc.sliceString(from - 1, from) === "\\") {
      view.dispatch({
        changes: { from, to, insert: text },
        selection: { anchor: from + text.length },
        userEvent: "input.type"
      });
      return true;
    }
  }
  return false;
});

const ctrlClickForceUpdateEffect = StateEffect.define<null>();
const linkDecoration = Decoration.mark({ class: "cm-ctrl-link", attributes: { style: "text-decoration: underline; cursor: pointer;" } });

export function typstImportPathRange(state: EditorState, position: number): { from: number; to: number } | null {
  const line = state.doc.lineAt(position);
  const pathPatterns = [
    /#(?:include|import)\s+"((?:\\.|[^"\\])*)"/g,
    /#?(?:bibliography|image)\s*\(\s*"((?:\\.|[^"\\])*)"/g
  ];
  for (const pathPattern of pathPatterns) {
    for (const match of line.text.matchAll(pathPattern)) {
      if (match.index === undefined) continue;
      const quotedPath = match[1];
      const openingQuote = match[0].indexOf('"');
      const from = line.from + match.index + openingQuote + 1;
      const to = from + quotedPath.length;
      if (position >= from && position < to) return { from, to };
    }
  }
  return null;
}

export function typstCtrlClickTextRange(state: EditorState, position: number): { from: number; to: number } | null {
  const importPath = typstImportPathRange(state, position);
  if (importPath) return importPath;

  const line = state.doc.lineAt(position);
  const patterns = [
    /(?:@|<)([\p{L}\p{N}_:-]+)>?/gu,
    /([\p{L}\p{N}_][\p{L}\p{N}_-]*)/gu
  ];

  for (const pattern of patterns) {
    for (const match of line.text.matchAll(pattern)) {
      if (match.index === undefined) continue;
      const text = match[1];
      const textOffset = match[0].indexOf(text);
      const from = line.from + match.index + textOffset;
      const to = from + text.length;
      if (position >= from && position < to) return { from, to };
    }
  }

  return state.wordAt(position);
}

export const ctrlClickLinkPlugin = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  hoveredPos: number | null = null;
  isCtrlDown = false;
  view: EditorView;

  constructor(view: EditorView) {
    this.view = view;
    this.decorations = Decoration.none;
  }

  update(update: ViewUpdate) {
    if (update.docChanged || update.transactions.some(tr => tr.effects.some(e => e.is(ctrlClickForceUpdateEffect)))) {
      this.decorations = this.computeDecorations();
    }
  }

  computeDecorations(): DecorationSet {
    if (!this.isCtrlDown || this.hoveredPos === null) return Decoration.none;
    const textRange = typstCtrlClickTextRange(this.view.state, this.hoveredPos);
    if (textRange) {
      return Decoration.set([linkDecoration.range(textRange.from, textRange.to)]);
    }
    return Decoration.none;
  }

  updateDecorations(pos: number | null, isCtrlDown: boolean) {
    let changed = false;
    if (this.hoveredPos !== pos) {
      this.hoveredPos = pos;
      changed = true;
    }
    if (this.isCtrlDown !== isCtrlDown) {
      this.isCtrlDown = isCtrlDown;
      changed = true;
    }
    if (changed) {
      this.view.dispatch({ effects: ctrlClickForceUpdateEffect.of(null) });
    }
  }
}, {
  decorations: v => v.decorations,
  eventHandlers: {
    mousemove(e) {
      const pos = this.view.posAtCoords({ x: e.clientX, y: e.clientY });
      if (pos !== null) {
        (this as any).updateDecorations(pos, e.ctrlKey || e.metaKey);
      }
    },
    keydown(e) {
      const isCtrl = e.ctrlKey || e.metaKey || e.key === "Control" || e.key === "Meta";
      (this as any).updateDecorations(this.hoveredPos, isCtrl);
    },
    keyup(e) {
      const isCtrl = e.ctrlKey || e.metaKey;
      (this as any).updateDecorations(this.hoveredPos, isCtrl);
    },
    mouseleave(e) {
      (this as any).updateDecorations(null, e.ctrlKey || e.metaKey);
    }
  }
});

const zwsMark = Decoration.mark({
  class: "cm-zws-mark"
});

const invisibleBlockMark = Decoration.mark({
  class: "cm-invisible-block-mark"
});

const trailingSpaceDecoration = Decoration.mark({
  class: "cm-trailing-space-mark"
});

const showZeroWidthSpacesPlugin = ViewPlugin.fromClass(class {
  decorations: DecorationSet;

  constructor(view: EditorView) {
    this.decorations = this.getDeco(view);
  }

  update(update: ViewUpdate) {
    if (update.docChanged || update.viewportChanged) {
      this.decorations = this.getDeco(update.view);
    }
  }

  getDeco(view: EditorView) {
    const builder = new RangeSetBuilder<Decoration>();
    const ranges: { from: number; to: number; deco: Decoration }[] = [];
    for (const { from, to } of view.visibleRanges) {
      const text = view.state.doc.sliceString(from, to);

      for (let i = 0; i < text.length; i++) {
        const char = text[i];
        if (char === "\u200b") {
          ranges.push({ from: from + i + 1, to: from + i + 2, deco: zwsMark });
        } else if (char === "\u200c") {
          ranges.push({ from: from + i, to: from + i + 1, deco: zwsMark });
        } else if (char === "\u00ad" || char === "\u200d" || char === "\u200e" || char === "\u200f" || char === "\u2060") {
          ranges.push({ from: from + i, to: from + i + 1, deco: invisibleBlockMark });
        }
      }

      for (let line = view.state.doc.lineAt(from); line.from <= to; line = view.state.doc.line(line.number + 1)) {
        const lineText = line.text;
        const match = /[ \t]+$/u.exec(lineText);
        if (match) {
          const trailingFrom = line.from + match.index;
          const trailingTo = line.to;
          const start = Math.max(trailingFrom, from);
          const end = Math.min(trailingTo, to);
          if (start < end) {
            ranges.push({ from: start, to: end, deco: trailingSpaceDecoration });
          }
        }
        if (line.to >= to || line.number >= view.state.doc.lines) break;
      }
    }
    ranges.sort((a, b) => a.from - b.from || a.to - b.to);
    for (const range of ranges) {
      builder.add(range.from, range.to, range.deco);
    }
    return builder.finish();
  }
}, {
  decorations: v => v.decorations
});

export const showZeroWidthSpaces: Extension = [
  showInvisibleCharacters.of(true),
  showZeroWidthSpacesPlugin
];

export function getEditorExtensions(
  getClient: () => TinymistLspClient | undefined,
  getUri: () => string,
  flushLspSync: () => void | Promise<void>,
  onNavigateToDefinition?: (uri: string, line: number, character: number) => void,
  getProviders?: () => ProviderCapabilities[],
  onGraphemePointerDebug?: (event: GraphemePointerDebugEvent) => void,
  onExplorerImageDrop?: (path: string, position: number, view: EditorView) => void,
  onClipboardImagePaste?: (
    images: readonly ClipboardImageData[],
    selection: { from: number; to: number },
    view: EditorView,
  ) => void,
): Extension[] {
  return [
    ctrlClickLinkPlugin,
    ...editingPolicyRegistry.editorExtensions(),
    graphemePointerSelection(onGraphemePointerDebug),
    graphemeSelectionBoundaryFilter,
    showZwsCompartment.of(showZeroWidthSpaces),
    selectionPairReplacementExtension,
    preventEscapedBracketAutoClose,
    contextualDoubleQuoteExtension,
    EditorView.domEventHandlers({
      dragover: (event, view) => {
        if (!event.dataTransfer?.types.includes(EXPLORER_IMAGE_DRAG_TYPE)) return false;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
        moveImageDropCaret(view, { x: event.clientX, y: event.clientY });
        return true;
      },
      drop: (event, view) => {
        const path = explorerImageDragPath(event.dataTransfer);
        if (!path || !onExplorerImageDrop) return false;
        const position = moveImageDropCaret(view, { x: event.clientX, y: event.clientY });
        if (position === null) return false;
        event.preventDefault();
        onExplorerImageDrop(path, position, view);
        return true;
      },
      paste: (event, view) => {
        const files = clipboardImageFiles(event.clipboardData);
        if (files.length === 0 || !onClipboardImagePaste) return false;
        event.preventDefault();
        const selection = view.state.selection.main;
        const document = view.state.doc;
        void readClipboardImageFiles(files).then(images => {
          if (view.state.doc !== document) return;
          onClipboardImagePaste(images, { from: selection.from, to: selection.to }, view);
        }).catch(error => console.error("Failed to read pasted clipboard image:", error));
        return true;
      },
      copy: (event, view) => writeEditorClipboardText(event, view),
      cut: (event, view) => {
        if (!writeEditorClipboardText(event, view)) return false;
        view.dispatch(view.state.replaceSelection(""));
        return true;
      },
      mousedown: (event, view) => {
        if (searchPanelOpen(view.state)) closeSearchPanel(view);
        if ((event.ctrlKey || event.metaKey) && event.button === 0) {
          console.log("[Ctrl+Click] Detected! Pos:", view.posAtCoords({ x: event.clientX, y: event.clientY }));
          const client = getClient();
          const uri = getUri();
          const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
          if (client && uri && pos !== null && onNavigateToDefinition) {
            const lspPos = client.lspPositionFromEditorPosition(view.state.doc, pos);
            console.log("[Ctrl+Click] Requesting definition for", uri, lspPos);
            void client.getDefinition(uri, lspPos).then((locations) => {
              console.log("[Ctrl+Click] Definition result:", locations);
              if (locations && locations.length > 0) {
                const loc = locations[0];
                const targetUri = loc.targetUri ?? loc.uri;
                const targetRange = loc.targetRange ?? loc.range;
                if (targetUri && targetRange) {
                  onNavigateToDefinition(targetUri, targetRange.start.line, targetRange.start.character ?? 0);
                }
              } else {
                console.log("[Ctrl+Click] Requesting references for", uri, lspPos);
                void client.getReferences(uri, lspPos).then((refs) => {
                  console.log("[Ctrl+Click] References result:", refs);
                  if (refs && refs.length > 0) {
                    const loc = refs[0];
                    const targetUri = loc.targetUri ?? loc.uri;
                    const targetRange = loc.targetRange ?? loc.range;
                    if (targetUri && targetRange) {
                      onNavigateToDefinition(targetUri, targetRange.start.line, targetRange.start.character ?? 0);
                    }
                  }
                });
              }
            });
            event.preventDefault();
            return true;
          }
        }
        return false;
      }
    }),
    foldService.of(typstFunctionFoldService),
    imageOptimizationWarningsExtension,
    lineNumbersCompartment.of(lineNumbers()),
    foldGutter({
      markerDOM: typstFoldMarkerDOM
    }),
    activeLineCompartment.of([highlightActiveLineGutter(), highlightActiveLine()]),
    drawSelection(), selectionStateClass, dropCursor(), history(),
    languageCompartment.of(typstLanguage),
    baseEditorLayoutTheme,
    scrollPastDocumentEnd(),
    wrappedLineIndentation,
    codeFolding({
      preparePlaceholder: foldedTypstPlaceholderSuffix,
      placeholderDOM: foldedTypstPlaceholderDOM
    }),
    editorDiagnosticsExtension,
    indentationGuidesCompartment.of(visibleIndentationMarkers()),
    tabSizeCompartment.of([EditorState.tabSize.of(2), indentUnit.of("  ")]),
    wrapCompartment.of(EditorView.lineWrapping),
    tooltips({ parent: document.body }),
    search({
      top: true,
      createPanel: view => new TypsastraSearchPanel(view),
      scrollToMatch: range => EditorView.scrollIntoView(range, { y: "center" })
    }),
    visibleFirstSearchNavigation,
    searchMatchCounter,
    caseInsensitiveSelectionMatches,
    closeBracketsCompartment.of(closeBrackets()),
    bracketMatching(),
    bracketColorizer,
    createHoverTooltip(getClient, getUri),
    completionCompartment.of(createTypstAutocomplete(getClient, getUri, flushLspSync, true, getProviders)),
    functionArgumentCompletionTrigger,
    completionNavigationHandler,
    themeCompartment.of(getThemeExtension("default")),
    editorFontCompartment.of(editorFontTheme()),
    keymap.of([
      { key: "Mod-/", run: toggleLineComment },
      { key: "Backspace", run: deletePreviousGraphemeOrPair },
      { key: "Delete", run: deleteNextGrapheme },
      { key: "ArrowLeft", run: movePreviousGrapheme },
      { key: "ArrowRight", run: moveNextGrapheme },
      { key: "Shift-ArrowLeft", run: selectPreviousGrapheme },
      { key: "Shift-ArrowRight", run: selectNextGrapheme },
      ...completionKeymap,
      { key: "Tab", run: insertTab }, 
      ...defaultKeymap, 
      ...historyKeymap, 
      ...searchKeymap, 
      ...foldKeymap
    ])
  ];
}

export function getThemeExtension(themeName: string): Extension {
    const baseExtensions = [];
    
    switch (themeName) {
        case "typsastraLight": baseExtensions.push(uiwThemes.githubLight); break;
        case "typsastraDark": baseExtensions.push(uiwThemes.githubDark); break;
        case "githubLight": baseExtensions.push(uiwThemes.githubLight); break;
        case "githubDark": baseExtensions.push(uiwThemes.githubDark); break;
        case "dracula": baseExtensions.push(uiwThemes.dracula); break;
        case "material": baseExtensions.push(uiwThemes.materialDark); break;
        case "materialLight": baseExtensions.push(uiwThemes.materialLight); break;
        case "nord": baseExtensions.push(uiwThemes.nord); break;
        case "oneDark": baseExtensions.push(oneDark); break;
        case "default":
        default:
            baseExtensions.push(syntaxHighlighting(typstColorHighlighting));
            break;
    }
    
    baseExtensions.push(syntaxHighlighting(typstFontHighlighting));
    baseExtensions.push(syntaxHighlighting(typstVariableHighlighting));
    baseExtensions.push(syntaxHighlighting(typstFunctionHighlighting));
    baseExtensions.push(syntaxHighlighting(typstSemanticHighlighting));
    return baseExtensions;
}

type ThemeColorVariables = {
  bg: string;
  text: string;
  border: string;
  hover: string;
  select: string;
  accent?: string;
  autocompleteSelect?: string;
  autocompleteSelectText?: string;
  header: string;
  mode: "dark" | "light";
  monospace: string;
  cursor: string;
  cursorContrast: string;
  cursorShadow: string;
  cursorGlow: string;
  cursorContrastShadow: string;
  cursorContrastGlow: string;
  selection: string;
  selectionFocus: string;
  selectionOutline: string;
  bracketMatchOutline: string;
  bracketMismatchBg: string;
  brackets: [string, string, string, string, string];
  functionColor: string;
  variableColor: string;
};

const lightEditorVisibility = {
  cursor: "#005cc5",
  cursorContrast: "#d73a49",
  cursorShadow: "rgba(255, 255, 255, 0.95)",
  cursorGlow: "rgba(0, 92, 197, 0.45)",
  cursorContrastShadow: "rgba(255, 255, 255, 0.95)",
  cursorContrastGlow: "rgba(215, 58, 73, 0.35)",
  selection: "rgba(3, 102, 214, 0.22)",
  selectionFocus: "rgba(3, 102, 214, 0.3)",
  selectionOutline: "rgba(3, 102, 214, 0.32)",
  bracketMatchOutline: "#005cc5",
  bracketMismatchBg: "rgba(215, 58, 73, 0.16)",
  brackets: ["#005cc5", "#6f42c1", "#22863a", "#d73a49", "#b31d28"],
  functionColor: "#005cc5",
  variableColor: "#5b21b6"
} satisfies Pick<ThemeColorVariables, "cursor" | "cursorContrast" | "cursorShadow" | "cursorGlow" | "cursorContrastShadow" | "cursorContrastGlow" | "selection" | "selectionFocus" | "selectionOutline" | "bracketMatchOutline" | "bracketMismatchBg" | "brackets" | "functionColor" | "variableColor">;

const darkEditorVisibility = {
  cursor: "#79c0ff",
  cursorContrast: "#ff7b72",
  cursorShadow: "rgba(0, 0, 0, 0.95)",
  cursorGlow: "rgba(121, 192, 255, 0.75)",
  cursorContrastShadow: "rgba(0, 0, 0, 0.95)",
  cursorContrastGlow: "rgba(255, 123, 114, 0.65)",
  selection: "rgba(56, 139, 253, 0.28)",
  selectionFocus: "rgba(56, 139, 253, 0.36)",
  selectionOutline: "rgba(121, 192, 255, 0.42)",
  bracketMatchOutline: "#79c0ff",
  bracketMismatchBg: "rgba(255, 123, 114, 0.22)",
  brackets: ["#79c0ff", "#d2a8ff", "#7ee787", "#ffa657", "#ff7b72"],
  functionColor: "#79c0ff",
  variableColor: "#d2a8ff"
} satisfies Pick<ThemeColorVariables, "cursor" | "cursorContrast" | "cursorShadow" | "cursorGlow" | "cursorContrastShadow" | "cursorContrastGlow" | "selection" | "selectionFocus" | "selectionOutline" | "bracketMatchOutline" | "bracketMismatchBg" | "brackets" | "functionColor" | "variableColor">;

const themeColors: Record<string, ThemeColorVariables> = {
  default: { bg: "#fcfcfc", text: "#333333", border: "#e0e0e0", hover: "#e4e6f1", select: "#d7e8f5", header: "#616161", mode: "light", monospace: "#005cc5", ...lightEditorVisibility },
  typsastraLight: {
    bg: "#f7faf8", text: "#24352e", border: "#cedbd4", hover: "#e8f1ec", select: "#d8ebe1", accent: "#23865f", header: "#5b6f64", mode: "light", monospace: "#167a57",
    ...lightEditorVisibility,
    autocompleteSelect: "#23865f",
    cursor: "#167a57",
    cursorContrast: "#9c3f71",
    cursorGlow: "rgba(22, 122, 87, 0.48)",
    cursorContrastGlow: "rgba(156, 63, 113, 0.36)",
    selection: "rgba(35, 134, 95, 0.20)",
    selectionFocus: "rgba(35, 134, 95, 0.29)",
    selectionOutline: "rgba(35, 134, 95, 0.38)",
    bracketMatchOutline: "#23865f",
    brackets: ["#167a57", "#7656a8", "#247ba0", "#b26a1f", "#b33a3a"],
    functionColor: "#167a57",
    variableColor: "#7656a8"
  },
  typsastraDark: {
    bg: "#17211d", text: "#d8e5de", border: "#34463d", hover: "#202e28", select: "#294137", accent: "#45bf8a", header: "#8fa69a", mode: "dark", monospace: "#69d3a6",
    ...darkEditorVisibility,
    autocompleteSelect: "#32986d",
    cursor: "#69d3a6",
    cursorContrast: "#f28fbd",
    cursorGlow: "rgba(105, 211, 166, 0.72)",
    cursorContrastGlow: "rgba(242, 143, 189, 0.62)",
    selection: "rgba(69, 191, 138, 0.24)",
    selectionFocus: "rgba(69, 191, 138, 0.34)",
    selectionOutline: "rgba(105, 211, 166, 0.42)",
    bracketMatchOutline: "#69d3a6",
    brackets: ["#69d3a6", "#c7a0f3", "#75c8e8", "#e8b56a", "#f28b82"],
    functionColor: "#69d3a6",
    variableColor: "#c7a0f3"
  },
  githubLight: { bg: "#ffffff", text: "#24292f", border: "#d0d7de", hover: "#f3f4f6", select: "#ddf4ff", header: "#57606a", mode: "light", monospace: "#0550ae", ...lightEditorVisibility, functionColor: "#0969da", variableColor: "#6639ba" },
  githubDark: { bg: "#0d1117", text: "#c9d1d9", border: "#30363d", hover: "#161b22", select: "#21262d", header: "#8b949e", mode: "dark", monospace: "#a5d6ff", ...darkEditorVisibility },
  dracula: {
    bg: "#282a36", text: "#f8f8f2", border: "#44475a", hover: "#44475a", select: "#6272a4", header: "#6272a4", mode: "dark", monospace: "#8be9fd",
    ...darkEditorVisibility,
    cursor: "#8be9fd",
    cursorContrast: "#ff79c6",
    cursorGlow: "rgba(139, 233, 253, 0.75)",
    cursorContrastGlow: "rgba(255, 121, 198, 0.7)",
    bracketMatchOutline: "#8be9fd",
    bracketMismatchBg: "rgba(255, 85, 85, 0.22)",
    brackets: ["#8be9fd", "#ff79c6", "#50fa7b", "#f1fa8c", "#ffb86c"],
    functionColor: "#8be9fd",
    variableColor: "#bd93f9"
  },
  material: {
    bg: "#263238", text: "#eeffff", border: "#37474f", hover: "#2c3b41", select: "#314549", header: "#546e7a", mode: "dark", monospace: "#80cbc4",
    ...darkEditorVisibility,
    cursor: "#80cbc4",
    cursorContrast: "#ff5370",
    cursorGlow: "rgba(128, 203, 196, 0.75)",
    cursorContrastGlow: "rgba(255, 83, 112, 0.7)",
    bracketMatchOutline: "#80cbc4",
    bracketMismatchBg: "rgba(255, 83, 112, 0.22)",
    brackets: ["#80cbc4", "#c792ea", "#c3e88d", "#ffcb6b", "#ff5370"],
    functionColor: "#82aaff",
    variableColor: "#c792ea"
  },
  materialLight: {
    bg: "#fafafa", text: "#90a4ae", border: "#e0e0e0", hover: "#f0f0f0", select: "#e0e0e0", header: "#90a4ae", mode: "light", monospace: "#39adb5",
    ...lightEditorVisibility,
    cursor: "#00796b",
    cursorContrast: "#c2185b",
    cursorGlow: "rgba(0, 121, 107, 0.42)",
    cursorContrastGlow: "rgba(194, 24, 91, 0.34)",
    bracketMatchOutline: "#00796b",
    bracketMismatchBg: "rgba(198, 40, 40, 0.14)",
    brackets: ["#00796b", "#5e35b1", "#2e7d32", "#c62828", "#ef6c00"],
    functionColor: "#005cc5",
    variableColor: "#6a1b9a"
  },
  nord: {
    bg: "#2e3440", text: "#d8dee9", border: "#434c5e", hover: "#3b4252", select: "#434c5e", header: "#4c566a", mode: "dark", monospace: "#88c0d0",
    ...darkEditorVisibility,
    cursor: "#88c0d0",
    cursorContrast: "#bf616a",
    cursorGlow: "rgba(136, 192, 208, 0.72)",
    cursorContrastGlow: "rgba(191, 97, 106, 0.65)",
    bracketMatchOutline: "#88c0d0",
    bracketMismatchBg: "rgba(191, 97, 106, 0.22)",
    brackets: ["#88c0d0", "#b48ead", "#a3be8c", "#ebcb8b", "#bf616a"],
    functionColor: "#88c0d0",
    variableColor: "#b48ead"
  },
  oneDark: { bg: "#282c34", text: "#abb2bf", border: "#181a1f", hover: "#2c313a", select: "#292d3e", header: "#5c6370", mode: "dark", monospace: "#56b6c2", ...darkEditorVisibility, functionColor: "#61afef", variableColor: "#c678dd" }
};

export async function applyUIThemeVariables(themeName: string) {
    const colors = themeColors[themeName] || themeColors.default;
    document.documentElement.style.colorScheme = colors.mode;
    document.documentElement.style.setProperty("--ui-bg", colors.bg);
    document.documentElement.style.setProperty("--ui-text", colors.text);
    document.documentElement.style.setProperty("--ui-border", colors.border);
    document.documentElement.style.setProperty("--ui-hover", colors.hover);
    document.documentElement.style.setProperty("--ui-select", colors.select);
    document.documentElement.style.setProperty("--ui-accent-color", colors.accent ?? colors.functionColor);
    document.documentElement.style.setProperty(
        "--ui-search-match-background",
        `color-mix(in srgb, ${colors.brackets[3]} 30%, ${colors.bg})`
    );
    document.documentElement.style.setProperty(
        "--autocomplete-select-bg",
        colors.autocompleteSelect ?? (colors.mode === "dark" ? "#3b82f6" : "#0969da")
    );
    document.documentElement.style.setProperty(
        "--autocomplete-select-text",
        colors.autocompleteSelectText ?? "#ffffff"
    );
    document.documentElement.style.setProperty("--ui-header-text", colors.header);
    document.documentElement.style.setProperty("--ui-monospace-color", colors.monospace);
    document.documentElement.style.setProperty("--editor-cursor-color", TYPSASTRA_GREEN);
    document.documentElement.style.setProperty("--editor-cursor-contrast-color", colors.cursorContrast);
    document.documentElement.style.setProperty("--editor-cursor-shadow", colors.cursorShadow);
    document.documentElement.style.setProperty("--editor-cursor-glow", TYPSASTRA_GREEN_GLOW);
    document.documentElement.style.setProperty("--editor-cursor-contrast-shadow", colors.cursorContrastShadow);
    document.documentElement.style.setProperty("--editor-cursor-contrast-glow", colors.cursorContrastGlow);
    document.documentElement.style.setProperty("--editor-selection-color", colors.selection);
    document.documentElement.style.setProperty("--editor-selection-focus-color", colors.selectionFocus);
    document.documentElement.style.setProperty("--editor-selection-outline", colors.selectionOutline);
    document.documentElement.style.setProperty("--editor-bracket-match-outline", colors.bracketMatchOutline);
    document.documentElement.style.setProperty("--editor-bracket-mismatch-bg", colors.bracketMismatchBg);
    colors.brackets.forEach((color, index) => {
        document.documentElement.style.setProperty(`--editor-bracket-${index}`, color);
    });
    document.documentElement.style.setProperty("--editor-function-color", colors.functionColor);
    document.documentElement.style.setProperty("--editor-variable-color", colors.variableColor);
    
    try {
        await getCurrentWindow().setTheme(colors.mode);
    } catch (e) {
        console.warn("Failed to set native window theme", e);
    }
}
