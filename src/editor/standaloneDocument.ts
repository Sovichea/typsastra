import { StateEffect, StateField, type EditorState } from "@codemirror/state";

/**
 * True while the editor shows a standalone document that is not part of a
 * project. Gutter affordances that open project tools (Image Tools, Table
 * Tools) read this and render nothing.
 */
export const setStandaloneDocumentEffect = StateEffect.define<boolean>();

export const standaloneDocumentField = StateField.define<boolean>({
  create: () => false,
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setStandaloneDocumentEffect)) value = effect.value;
    }
    return value;
  },
});

export function isStandaloneDocument(state: EditorState): boolean {
  return state.field(standaloneDocumentField, false) ?? false;
}
