import type { EditorState } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { isTypstProseSyntaxNode } from "./typstSyntax";

/**
 * Tinymist's PDF source map resolves textual Typst content. A source expression
 * may render something (for example #image) without producing a text position,
 * so rendered output alone is not enough to make forward sync eligible.
 */
export function isForwardSyncContentPosition(state: EditorState, position: number): boolean {
  if (position < 0 || position > state.doc.length) return false;
  const tree = syntaxTree(state);
  return isTypstProseSyntaxNode(tree.resolveInner(position, -1))
    || isTypstProseSyntaxNode(tree.resolveInner(position, 1));
}
