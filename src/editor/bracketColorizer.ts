import { RangeSetBuilder, StateEffect, type Text } from "@codemirror/state";
import { ensureSyntaxTree, syntaxTree, syntaxTreeAvailable } from "@codemirror/language";
import type { Tree } from "@lezer/common";
import { isTypstDelimiterAt } from "./typstSyntax";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";

const BRACKET_COLOR_COUNT = 5;
const VIEWPORT_BUFFER_CHARS = 2_000;
const SCROLL_SETTLE_DELAY_MS = 16;
const PARSE_SLICE_MS = 8;
const PARSE_RETRY_DELAY_MS = 16;
const MAX_PARSE_RETRIES = 120;
const publishBracketColors = StateEffect.define<DecorationSet>();
const requestBracketRefresh = StateEffect.define<void>();

type BracketSummary = {
  sum: number;
  minimum: number;
};

const EMPTY_SUMMARY: BracketSummary = { sum: 0, minimum: 0 };

function combineSummaries(left: BracketSummary, right: BracketSummary): BracketSummary {
  return {
    sum: left.sum + right.sum,
    minimum: Math.min(left.minimum, left.sum + right.minimum),
  };
}

function summarizeBrackets(text: string): BracketSummary {
  let sum = 0;
  let minimum = 0;
  for (const character of text) {
    if (isOpeningBracket(character)) sum += 1;
    else if (isBracket(character)) sum -= 1;
    minimum = Math.min(minimum, sum);
  }
  return { sum, minimum };
}

function endingDepth(summary: BracketSummary, initialDepth = 0): number {
  return summary.sum + Math.max(initialDepth, -summary.minimum);
}

/**
 * Stores one bracket summary per document line and a segment tree over those
 * summaries. A viewport can recover its starting depth in O(log lineCount)
 * without allocating or scanning the entire document prefix.
 */
export class BracketDepthIndex {
  private summaries: BracketSummary[] = [];
  private tree: BracketSummary[] = [];
  private leafCount = 1;

  constructor(doc: Text) {
    this.summaries = this.summarizeLines(doc, 1, doc.lines);
    this.rebuildTree();
  }

  update(update: ViewUpdate): void {
    if (!update.docChanged) return;

    let oldFrom = update.startState.doc.length;
    let oldTo = 0;
    let newFrom = update.state.doc.length;
    let newTo = 0;
    update.changes.iterChangedRanges((fromA, toA, fromB, toB) => {
      oldFrom = Math.min(oldFrom, fromA);
      oldTo = Math.max(oldTo, toA);
      newFrom = Math.min(newFrom, fromB);
      newTo = Math.max(newTo, toB);
    });

    const oldStartLine = Math.max(1, update.startState.doc.lineAt(oldFrom).number - 1);
    const oldEndLine = Math.min(update.startState.doc.lines, update.startState.doc.lineAt(oldTo).number + 1);
    const newStartLine = Math.max(1, update.state.doc.lineAt(newFrom).number - 1);
    const newEndLine = Math.min(update.state.doc.lines, update.state.doc.lineAt(newTo).number + 1);
    const replacement = this.summarizeLines(update.state.doc, newStartLine, newEndLine);
    const previousCount = oldEndLine - oldStartLine + 1;
    this.summaries.splice(oldStartLine - 1, oldEndLine - oldStartLine + 1, ...replacement);
    if (previousCount !== replacement.length) {
      this.rebuildTree();
      return;
    }
    for (let index = 0; index < replacement.length; index += 1) {
      this.updateTreeLeaf(newStartLine - 1 + index, replacement[index]);
    }
  }

  depthAt(doc: Text, position: number): number {
    const line = doc.lineAt(position);
    const completeLines = this.query(0, line.number - 1);
    const linePrefix = summarizeBrackets(doc.sliceString(line.from, position));
    return endingDepth(linePrefix, endingDepth(completeLines));
  }

  private summarizeLines(doc: Text, fromLine: number, toLine: number): BracketSummary[] {
    const result: BracketSummary[] = [];
    for (let lineNumber = fromLine; lineNumber <= toLine; lineNumber += 1) {
      result.push(summarizeBrackets(doc.line(lineNumber).text));
    }
    return result;
  }

  private rebuildTree(): void {
    this.leafCount = 1;
    while (this.leafCount < this.summaries.length) this.leafCount *= 2;
    this.tree = Array.from({ length: this.leafCount * 2 }, () => EMPTY_SUMMARY);
    for (let index = 0; index < this.summaries.length; index += 1) {
      this.tree[this.leafCount + index] = this.summaries[index];
    }
    for (let index = this.leafCount - 1; index > 0; index -= 1) {
      this.tree[index] = combineSummaries(this.tree[index * 2], this.tree[index * 2 + 1]);
    }
  }

  private updateTreeLeaf(index: number, summary: BracketSummary): void {
    let treeIndex = this.leafCount + index;
    this.tree[treeIndex] = summary;
    while (treeIndex > 1) {
      treeIndex >>= 1;
      this.tree[treeIndex] = combineSummaries(this.tree[treeIndex * 2], this.tree[treeIndex * 2 + 1]);
    }
  }

  private query(from: number, to: number): BracketSummary {
    let left = from + this.leafCount;
    let right = to + this.leafCount;
    let leftResult = EMPTY_SUMMARY;
    let rightResult = EMPTY_SUMMARY;
    while (left < right) {
      if ((left & 1) === 1) leftResult = combineSummaries(leftResult, this.tree[left++]);
      if ((right & 1) === 1) rightResult = combineSummaries(this.tree[--right], rightResult);
      left >>= 1;
      right >>= 1;
    }
    return combineSummaries(leftResult, rightResult);
  }
}

/**
 * Build and publish colors for the current viewport. The return value is the
 * actual readiness signal used by tab presentation—requesting a refresh is no
 * longer treated as if the decorations were already installed.
 */
export function prepareVisibleBracketColors(view: EditorView): boolean {
  return view.plugin(bracketColorizer)?.refreshNow() ?? true;
}

export function refreshVisibleBracketColors(view: EditorView): void {
  view.dispatch({ effects: requestBracketRefresh.of(undefined) });
}

function isBracket(character: string): boolean {
  return character === "(" || character === ")" || character === "[" || character === "]" || character === "{" || character === "}";
}

function isOpeningBracket(character: string): boolean {
  return character === "(" || character === "[" || character === "{";
}

function isTypstPunctuationBracket(tree: Tree, position: number): boolean {
  return isTypstDelimiterAt(tree, position);
}

type VisibleBracketDecorations = {
  decorations: DecorationSet;
  syntaxReady: boolean;
};

function visibleBracketDecorations(view: EditorView, depthIndex: BracketDepthIndex): VisibleBracketDecorations {
  if (view.visibleRanges.length === 0) {
    return { decorations: Decoration.none, syntaxReady: true };
  }

  const firstVisible = view.visibleRanges[0];
  const lastVisible = view.visibleRanges[view.visibleRanges.length - 1];
  const from = Math.max(0, firstVisible.from - VIEWPORT_BUFFER_CHARS);
  const to = Math.min(view.state.doc.length, lastVisible.to + VIEWPORT_BUFFER_CHARS);
  const tree = ensureSyntaxTree(view.state, to, PARSE_SLICE_MS) ?? syntaxTree(view.state);
  const syntaxReady = syntaxTreeAvailable(view.state, to);
  let depth = depthIndex.depthAt(view.state.doc, from);

  const builder = new RangeSetBuilder<Decoration>();
  const text = view.state.doc.sliceString(from, to);
  for (let offset = 0; offset < text.length; offset += 1) {
    const character = text[offset];
    if (!isBracket(character)) continue;

    const position = from + offset;
    if (isTypstPunctuationBracket(tree, position)) {
      const colorDepth = isOpeningBracket(character) ? depth : Math.max(0, depth - 1);
      builder.add(
        position,
        position + 1,
        Decoration.mark({ class: `bracket-color-${colorDepth % BRACKET_COLOR_COUNT}` }),
      );
    }

    if (isOpeningBracket(character)) depth += 1;
    else depth = Math.max(0, depth - 1);
  }

  return { decorations: builder.finish(), syntaxReady };
}

class BracketColorizerPlugin {
  decorations: DecorationSet;
  private depthIndex: BracketDepthIndex;
  private refreshTimer: number | null = null;
  private parseRetries = 0;

  constructor(private readonly view: EditorView) {
    this.depthIndex = new BracketDepthIndex(view.state.doc);
    const result = visibleBracketDecorations(view, this.depthIndex);
    this.decorations = result.syntaxReady ? result.decorations : Decoration.none;
    if (!result.syntaxReady) this.scheduleParserRetry();
  }

  update(update: ViewUpdate): void {
    this.depthIndex.update(update);
    const requested = update.transactions.some(transaction =>
      transaction.effects.some(effect => effect.is(requestBracketRefresh))
    );
    const publications = update.transactions.flatMap(transaction =>
      transaction.effects.filter(effect => effect.is(publishBracketColors))
    );
    const publication = publications[publications.length - 1];

    if (publication?.is(publishBracketColors)) {
      this.decorations = publication.value;
      this.parseRetries = 0;
      return;
    }

    if (requested) {
      this.applyRefresh();
      return;
    }

    if (update.docChanged) {
      this.decorations = this.decorations.map(update.changes);
      this.parseRetries = 0;
      this.scheduleRefresh(16);
    } else if (update.viewportChanged) {
      this.parseRetries = 0;
      this.scheduleRefresh(SCROLL_SETTLE_DELAY_MS);
    }
  }

  refreshNow(): boolean {
    const result = visibleBracketDecorations(this.view, this.depthIndex);
    if (result.syntaxReady) {
      this.view.dispatch({ effects: publishBracketColors.of(result.decorations) });
      return true;
    }
    this.scheduleParserRetry();
    return false;
  }

  private applyRefresh(): boolean {
    const result = visibleBracketDecorations(this.view, this.depthIndex);
    if (result.syntaxReady) {
      this.decorations = result.decorations;
      this.parseRetries = 0;
      return true;
    }
    this.scheduleParserRetry();
    return false;
  }

  destroy(): void {
    if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
  }

  private scheduleRefresh(delay: number): void {
    if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => {
      this.refreshTimer = null;
      if (!this.view.dom.isConnected) return;
      this.refreshNow();
    }, delay);
  }

  private scheduleParserRetry(): void {
    if (this.parseRetries >= MAX_PARSE_RETRIES) return;
    this.parseRetries += 1;
    this.scheduleRefresh(PARSE_RETRY_DELAY_MS);
  }
}

export const bracketColorizer = ViewPlugin.fromClass(BracketColorizerPlugin, {
  decorations: plugin => plugin.decorations,
});
