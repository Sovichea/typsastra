import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { typstLanguage } from "../editor/typstLanguage";

export type CitationSite = {
  key: string;
  from: number;
  to: number;
  line: number;
  column: number;
};

export type BibliographyCall = {
  from: number;
  to: number;
  sources: string[];
  style: string | null;
};

export type TypstReferenceScan = {
  citations: CitationSite[];
  bibliographyCalls: BibliographyCall[];
};

type Token = {
  name: string;
  from: number;
  to: number;
  text: string;
};

/**
 * Scans the syntax tree produced by the Typst stream language so comments,
 * strings, and code references do not become markup citations by accident.
 */
export function scanTypstReferences(source: string): TypstReferenceScan {
  const tokens = typstTokens(source);
  const lineStarts = sourceLineStarts(source);
  const citations: CitationSite[] = [];
  const bibliographyCalls: BibliographyCall[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.name === "reference") {
      const key = token.text.slice(1);
      if (!isMarkupReference(source, token.from, key)) continue;
      const position = offsetPosition(lineStarts, token.from);
      citations.push({ key, from: token.from, to: token.to, ...position });
      continue;
    }

    if (token.name !== "function") continue;
    const call = callAt(source, token.to);
    if (!call) continue;

    if (token.text === "cite") {
      for (let argumentIndex = index + 1; argumentIndex < tokens.length; argumentIndex += 1) {
        const argument = tokens[argumentIndex];
        if (argument.from < call.argsFrom) continue;
        if (argument.to > call.argsTo) break;
        if (argument.name !== "label") continue;
        const key = argument.text.slice(1, -1);
        if (!key) continue;
        const position = offsetPosition(lineStarts, token.from);
        citations.push({ key, from: token.from, to: call.to, ...position });
      }
    } else if (token.text === "bibliography") {
      const style = /(?:^|,)\s*style\s*:\s*"((?:\\.|[^"\\])*)"/u.exec(source.slice(call.argsFrom, call.argsTo));
      bibliographyCalls.push({
        from: token.from,
        to: call.to,
        sources: stringLiterals(firstArgument(source.slice(call.argsFrom, call.argsTo)))
          .map(unescapeTypstString),
        style: style ? unescapeTypstString(style[1]) : null,
      });
    }
  }

  return { citations, bibliographyCalls };
}

function typstTokens(source: string): Token[] {
  const state = EditorState.create({ doc: source, extensions: [typstLanguage] });
  const tree = ensureSyntaxTree(state, source.length, 5_000) ?? syntaxTree(state);
  const cursor = tree.cursor();
  const tokens: Token[] = [];
  do {
    if (cursor.name !== "Document") {
      tokens.push({
        name: cursor.name,
        from: cursor.from,
        to: cursor.to,
        text: source.slice(cursor.from, cursor.to),
      });
    }
  } while (cursor.next());
  return tokens;
}

function isMarkupReference(source: string, from: number, key: string): boolean {
  if (!key) return false;
  const previous = from > 0 ? source[from - 1] : "";
  // The Typst editor excludes email domains from label-looking references.
  return !/[\p{L}\p{N}]/u.test(previous);
}

function callAt(
  source: string,
  nameEnd: number,
): { argsFrom: number; argsTo: number; to: number } | null {
  let index = nameEnd;
  while (index < source.length && /\s/u.test(source[index])) index += 1;
  if (source[index] !== "(") return null;
  const argsFrom = index + 1;
  let depth = 1;
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (index = argsFrom; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (inLineComment) {
      if (character === "\n") inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (character === "*" && next === "/") {
        inBlockComment = false;
        index += 1;
      }
      continue;
    }
    if (inString) {
      if (character === "\\") index += 1;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
    } else if (character === "/" && next === "/") {
      inLineComment = true;
      index += 1;
    } else if (character === "/" && next === "*") {
      inBlockComment = true;
      index += 1;
    } else if (character === "(") {
      depth += 1;
    } else if (character === ")") {
      depth -= 1;
      if (depth === 0) return { argsFrom, argsTo: index, to: index + 1 };
    }
  }
  return null;
}

function firstArgument(args: string): string {
  let depth = 0;
  let inString = false;
  for (let index = 0; index < args.length; index += 1) {
    const character = args[index];
    if (inString) {
      if (character === "\\") index += 1;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
    } else if (character === "(" || character === "[" || character === "{") {
      depth += 1;
    } else if (character === ")" || character === "]" || character === "}") {
      depth -= 1;
    } else if (character === "," && depth === 0) {
      return args.slice(0, index);
    }
  }
  return args;
}

function stringLiterals(value: string): string[] {
  const literals: string[] = [];
  let inString = false;
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (!inString) {
      if (character === '"') {
        inString = true;
        start = index + 1;
      }
      continue;
    }
    if (character === "\\") {
      index += 1;
    } else if (character === '"') {
      literals.push(value.slice(start, index));
      inString = false;
    }
  }
  return literals;
}

function unescapeTypstString(value: string): string {
  return value.replace(/\\(["\\])/gu, "$1");
}

function sourceLineStarts(source: string): number[] {
  const starts = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source.charCodeAt(index) === 10) starts.push(index + 1);
  }
  return starts;
}

function offsetPosition(
  lineStarts: readonly number[],
  offset: number,
): { line: number; column: number } {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (lineStarts[middle] <= offset) low = middle + 1;
    else high = middle - 1;
  }
  const lineIndex = Math.max(0, high);
  return {
    line: lineIndex + 1,
    column: offset - lineStarts[lineIndex] + 1,
  };
}
