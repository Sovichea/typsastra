import type { SyntaxNode, Tree } from "@lezer/common";

const PROSE_NODE_NAMES = new Set([
  "Content",
  "Heading",
  "TermItem",
  "content",
  "heading",
  "term",
]);

const DELIMITER_NODE_NAMES = new Set([
  "LeftBrace",
  "RightBrace",
  "LeftBracket",
  "RightBracket",
  "LeftParen",
  "RightParen",
  "punctuation",
]);

export function isTypstProseSyntaxNode(node: SyntaxNode | null): boolean {
  for (let current = node; current; current = current.parent) {
    const names = current.name.split(/[ _]+/u);
    if (names.some(name => PROSE_NODE_NAMES.has(name))) return true;
  }
  return false;
}

export function isTypstDelimiterAt(tree: Tree, position: number): boolean {
  const node = tree.resolveInner(position, 1);
  return DELIMITER_NODE_NAMES.has(node.name);
}
