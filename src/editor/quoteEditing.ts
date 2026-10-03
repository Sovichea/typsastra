import { EditorSelection } from "@codemirror/state";
import { EditorView, type Command } from "@codemirror/view";
import { replaceSelectedDelimiters } from "./selectionPairEditing";

export type DoubleQuoteAction = "pair" | "single" | "skip" | "wrap";

function adjacentCodePoint(text: string, side: "start" | "end"): string {
  const codePoints = Array.from(text);
  return side === "start" ? codePoints[0] ?? "" : codePoints[codePoints.length - 1] ?? "";
}

function isContentCodePoint(value: string): boolean {
  return /[\p{L}\p{M}\p{N}\p{Extended_Pictographic}]/u.test(value);
}

function hasOddTrailingBackslashes(text: string): boolean {
  let count = 0;
  for (let index = text.length - 1; index >= 0 && text[index] === "\\"; index--) count++;
  return count % 2 === 1;
}

/**
 * Counts the unescaped quotes before the caret. An odd count means the caret
 * sits inside a string, which is what decides whether a quote that follows is a
 * closer to step over or an opener the user still has to type.
 */
function unescapedQuoteCount(text: string): number {
  let count = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '"' && !hasOddTrailingBackslashes(text.slice(0, index))) count += 1;
  }
  return count;
}

export function doubleQuoteAction(before: string, after: string, hasSelection = false): DoubleQuoteAction {
  if (hasSelection) return "wrap";
  const insideString = unescapedQuoteCount(before) % 2 === 1;
  // Typing the quote that closes the string the caret is already in steps over
  // it. Outside a string that quote is an opener, so the keystroke must still be
  // inserted rather than swallowed.
  if (insideString && after.startsWith('"')) return "skip";
  if (hasOddTrailingBackslashes(before)) return "single";
  // An unescaped quote before the caret means the caret is already inside a
  // string, so this quote closes it. Pairing here would leave three quotes.
  if (before.endsWith('"')) return "single";
  if (isContentCodePoint(adjacentCodePoint(before, "end"))
    || isContentCodePoint(adjacentCodePoint(after, "start"))) {
    return "single";
  }
  return "pair";
}

export const insertContextualDoubleQuote: Command = view => {
  if (view.state.readOnly) return false;
  if (view.state.selection.ranges.every(range => !range.empty)) {
    return replaceSelectedDelimiters(view, '"');
  }
  const transaction = view.state.changeByRange(range => {
    const before = view.state.doc.sliceString(0, range.from);
    const after = view.state.doc.sliceString(range.to);
    const action = doubleQuoteAction(before, after, !range.empty);
    if (action === "skip") {
      return { range: EditorSelection.cursor(range.from + 1) };
    }
    if (action === "wrap") {
      const selected = view.state.doc.sliceString(range.from, range.to);
      return {
        changes: { from: range.from, to: range.to, insert: `"${selected}"` },
        range: EditorSelection.range(range.anchor + 1, range.head + 1),
      };
    }
    const insert = action === "pair" ? '""' : '"';
    return {
      changes: { from: range.from, to: range.to, insert },
      range: EditorSelection.cursor(range.from + 1),
    };
  });
  view.dispatch(view.state.update(transaction, {
    scrollIntoView: true,
    userEvent: "input.type",
  }));
  return true;
};

export const contextualDoubleQuoteExtension = EditorView.inputHandler.of((view, _from, _to, text) => {
  if (text !== '"' || view.composing) return false;
  return insertContextualDoubleQuote(view);
});
