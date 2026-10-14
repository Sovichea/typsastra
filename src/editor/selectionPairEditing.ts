import { EditorSelection } from "@codemirror/state";
import { EditorView, type Command } from "@codemirror/view";

export const EDITOR_DELIMITER_PAIRS = {
  '"': '"',
  "(": ")",
  "[": "]",
  "{": "}",
  "*": "*",
  "_": "_",
  "`": "`",
} as const;

export type EditorOpeningDelimiter = keyof typeof EDITOR_DELIMITER_PAIRS;

export type PairedSelection = {
  opening: EditorOpeningDelimiter;
  closing: string;
  content: string;
};

export function pairedSelection(selected: string): PairedSelection | null {
  for (const opening of Object.keys(EDITOR_DELIMITER_PAIRS) as EditorOpeningDelimiter[]) {
    const closing = EDITOR_DELIMITER_PAIRS[opening];
    const prefix = opening;
    if (selected.length < prefix.length + closing.length) continue;
    if (selected.startsWith(prefix) && selected.endsWith(closing)) {
      return {
        opening,
        closing,
        content: selected.slice(prefix.length, selected.length - closing.length),
      };
    }
  }
  return null;
}

export function pairedSelectionContent(selected: string): string | null {
  return pairedSelection(selected)?.content ?? null;
}

/**
 * Wraps bare selections, removes an existing matching pair, or replaces a
 * different existing pair. The complete result remains selected so repeated
 * delimiter keys can toggle or switch pairs without selecting the text again.
 */
export function replaceSelectedDelimiters(
  view: EditorView,
  opening: EditorOpeningDelimiter,
): boolean {
  if (view.state.readOnly || view.state.selection.ranges.some(range => range.empty)) return false;
  const closing: string = EDITOR_DELIMITER_PAIRS[opening];
  const transaction = view.state.changeByRange(range => {
    const selected = view.state.doc.sliceString(range.from, range.to);
    const existing = pairedSelection(selected);
    const prefix = opening;
    const insert = existing?.opening === opening
      ? existing.content
      : `${prefix}${existing?.content ?? selected}${closing}`;
    const selectionFrom = range.from;
    const selectionTo = selectionFrom + insert.length;
    return {
      changes: { from: range.from, to: range.to, insert },
      range: range.anchor > range.head
        ? EditorSelection.range(selectionTo, selectionFrom)
        : EditorSelection.range(selectionFrom, selectionTo),
    };
  });
  view.dispatch(view.state.update(transaction, {
    scrollIntoView: true,
    userEvent: "input.type",
  }));
  return true;
}

export const replaceSelectedPair: Command = view => replaceSelectedDelimiters(view, "[");

export const selectionPairReplacementExtension = EditorView.inputHandler.of((view, _from, _to, text) => {
  if (view.composing || !(text in EDITOR_DELIMITER_PAIRS)) return false;
  return replaceSelectedDelimiters(view, text as EditorOpeningDelimiter);
});
