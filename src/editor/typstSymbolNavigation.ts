import { EditorState } from "@codemirror/state";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { filePathKey, resolveTypstPath } from "../platform/paths";
import { findLetBindingDeclarations, type LetBindingDeclaration } from "./unusedBindings";
import { typstLanguage } from "./typstLanguage";

export type TypstFunctionCall = {
  from: number;
  to: number;
  name: string;
};

export type TypstImportItem = {
  /** Name exported by the imported module. */
  name: string;
  /** Name available in the importing module. */
  alias: string;
};

export type TypstImport = {
  path: string;
  wildcard: boolean;
  items: TypstImportItem[];
};

export type TypstSymbolDefinition = {
  path: string;
  name: string;
  /** Zero-based line, matching LSP coordinates. */
  line: number;
  /** Zero-based UTF-16 offset within the line. */
  character: number;
  kind: LetBindingDeclaration["kind"];
};

export type TypstSymbolResolutionOptions = {
  /** Click offset in the entry file, used to prefer the nearest preceding binding. */
  preferredOffset?: number;
  /** Current editor text, so the active file does not need a disk read. */
  entrySource?: string;
};

type ParsedTypstFile = {
  definitions: LetBindingDeclaration[];
  imports: TypstImport[];
};

type ResolutionContext = {
  workspaceRoot: string;
  readFile: (path: string) => Promise<string | null>;
  cache: Map<string, ParsedTypstFile | null>;
  visited: Set<string>;
};

const TYPST_KEYWORDS = new Set([
  "let",
  "set",
  "show",
  "import",
  "include",
  "if",
  "else",
  "for",
  "in",
  "while",
  "break",
  "continue",
  "return",
  "context",
  "as",
  "none",
  "auto",
  "true",
  "false",
]);

/**
 * Returns the identifier when the cursor is over a Typst function call.
 * The syntax tree distinguishes real function tokens from prose, comments,
 * strings, and non-call variable references.
 */
export function typstFunctionCallAt(
  state: EditorState,
  position: number,
): TypstFunctionCall | null {
  if (position < 0 || position > state.doc.length) return null;
  const line = state.doc.lineAt(position);
  const tree = ensureSyntaxTree(
    state,
    Math.min(state.doc.length, line.to + 1),
    250,
  ) ?? syntaxTree(state);
  let leaf = tree.resolveInner(position, 1);
  if (leaf.name !== "function" && position > line.from) {
    const previous = tree.resolveInner(position - 1, 1);
    if (previous.name === "function") leaf = previous;
  }
  if (leaf.name !== "function") return null;
  const from = leaf.from;
  const to = leaf.to;
  if (to <= from) return null;
  const name = state.doc.sliceString(from, to);
  if (!/^[\p{L}_][\p{L}\p{N}_-]*$/u.test(name) || TYPST_KEYWORDS.has(name)) {
    return null;
  }
  const before = from > line.from ? state.doc.sliceString(from - 1, from) : "";
  if (before === "." || before === "@" || before === "<") return null;
  const after = state.doc.sliceString(to, Math.min(state.doc.length, to + 32));
  if (!/^\s*(?:\(|\[)/u.test(after)) return null;
  return { from, to, name };
}

/** Finds `#import` statements in a Typst source file. */
export function findTypstImports(source: string): TypstImport[] {
  const { state, tree } = parseTypstSource(source);
  return importsFromState(state, tree);
}

/** Finds `#let` bindings in a Typst source file. */
export function findTypstDefinitions(source: string): LetBindingDeclaration[] {
  const { state, tree } = parseTypstSource(source);
  return findLetBindingDeclarations(state, tree);
}

/**
 * Resolves a function name through the entry file's local bindings and import
 * graph. This intentionally covers local project code, not packages or the
 * Typst standard library.
 */
export async function resolveTypstSymbol(
  name: string,
  entryPath: string,
  workspaceRoot: string,
  readFile: (path: string) => Promise<string | null>,
  options: TypstSymbolResolutionOptions = {},
): Promise<TypstSymbolDefinition | null> {
  const context: ResolutionContext = {
    workspaceRoot,
    readFile,
    cache: new Map(),
    visited: new Set(),
  };
  return resolveInFile(
    name,
    entryPath,
    context,
    true,
    options.preferredOffset,
    options.entrySource,
  );
}

function parseTypstSource(source: string): {
  state: EditorState;
  tree: ReturnType<typeof syntaxTree>;
} {
  const state = EditorState.create({
    doc: source,
    extensions: [typstLanguage],
  });
  const tree = ensureSyntaxTree(state, state.doc.length, 1_000) ?? syntaxTree(state);
  return { state, tree };
}

function importsFromState(
  state: EditorState,
  tree: ReturnType<typeof syntaxTree> = syntaxTree(state),
): TypstImport[] {
  const imports: TypstImport[] = [];
  const cursor = tree.cursor();
  do {
    if (cursor.name !== "keyword") continue;
    if (state.doc.sliceString(cursor.from, cursor.to) !== "import") continue;
    const parsed = parseImportAt(state.doc.sliceString(cursor.to));
    if (parsed) imports.push(parsed);
  } while (cursor.next());
  return imports;
}

function parseImportAt(sourceAfterKeyword: string): TypstImport | null {
  const pathMatch = /^\s+"((?:\\.|[^"\\])*)"/u.exec(sourceAfterKeyword);
  if (!pathMatch) return null;
  const afterPath = sourceAfterKeyword.slice(pathMatch[0].length);
  const colon = /^\s*:\s*/u.exec(afterPath);
  if (!colon) return null;

  const list = readImportList(afterPath.slice(colon[0].length));
  const wildcard = list.includes("*");
  const items: TypstImportItem[] = [];
  const cleaned = list
    .replace(/\/\/[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  for (const rawItem of cleaned.split(",")) {
    const item = rawItem.trim();
    if (!item || item === "*") continue;
    const match = /^([\p{L}_][\p{L}\p{N}_-]*)(?:\s+as\s+([\p{L}_][\p{L}\p{N}_-]*))?$/u.exec(item);
    if (!match) continue;
    items.push({ name: match[1], alias: match[2] ?? match[1] });
  }
  return { path: pathMatch[1], wildcard, items };
}

function readImportList(source: string): string {
  let index = 0;
  while (index < source.length && /\s/u.test(source[index])) index += 1;
  if (source[index] === "(") {
    let depth = 0;
    for (let cursor = index; cursor < source.length; cursor += 1) {
      if (source[cursor] === "(") depth += 1;
      else if (source[cursor] === ")") {
        depth -= 1;
        if (depth === 0) return source.slice(index + 1, cursor);
      }
    }
    return source.slice(index + 1);
  }
  const end = source.slice(index).search(/[\n;]/u);
  return end === -1 ? source.slice(index) : source.slice(index, index + end);
}

async function parseTypstFile(
  path: string,
  context: ResolutionContext,
  sourceOverride?: string,
): Promise<ParsedTypstFile | null> {
  const key = filePathKey(path);
  if (context.cache.has(key)) return context.cache.get(key) ?? null;
  const source = sourceOverride
    ?? await context.readFile(path).catch(() => null);
  if (source === null) {
    context.cache.set(key, null);
    return null;
  }
  const { state, tree } = parseTypstSource(source);
  const parsed = {
    definitions: findLetBindingDeclarations(state, tree),
    imports: importsFromState(state, tree),
  };
  context.cache.set(key, parsed);
  return parsed;
}

async function resolveInFile(
  name: string,
  path: string,
  context: ResolutionContext,
  isEntry: boolean,
  preferredOffset?: number,
  entrySource?: string,
): Promise<TypstSymbolDefinition | null> {
  const visitKey = `${filePathKey(path)}\0${name}`;
  if (context.visited.has(visitKey)) return null;
  context.visited.add(visitKey);

  const parsed = await parseTypstFile(path, context, isEntry ? entrySource : undefined);
  if (!parsed) return null;

  const local = pickDefinition(
    parsed.definitions.filter(definition => definition.name === name),
    isEntry ? preferredOffset : undefined,
    isEntry,
  );
  if (local) return { path, ...definitionLocation(local) };

  for (const entry of parsed.imports) {
    const importedPath = resolveTypstPath(path, context.workspaceRoot, entry.path);
    if (!importedPath) continue;
    if (entry.wildcard) {
      const found = await resolveInFile(name, importedPath, context, false);
      if (found) return found;
    }
    const importItem = entry.items.find(item => item.alias === name);
    if (!importItem) continue;
    const found = await resolveInFile(importItem.name, importedPath, context, false);
    if (found) return found;
  }

  if (isEntry) {
    // A binding declared after the call is not usually in scope, but it is
    // still a better navigation target than doing nothing.
    const fallback = pickDefinition(
      parsed.definitions.filter(definition => definition.name === name),
    );
    if (fallback) return { path, ...definitionLocation(fallback) };
  }
  return null;
}

function pickDefinition(
  definitions: LetBindingDeclaration[],
  preferredOffset?: number,
  entry = false,
): LetBindingDeclaration | null {
  if (definitions.length === 0) return null;
  const functions = definitions.filter(definition => definition.kind === "function");
  const candidates = functions.length > 0 ? functions : definitions;
  if (preferredOffset === undefined) return candidates[0];
  const preceding = candidates.filter(definition => definition.from <= preferredOffset);
  if (preceding.length > 0) return preceding[preceding.length - 1];
  return entry ? null : candidates[0];
}

function definitionLocation(definition: LetBindingDeclaration): Omit<TypstSymbolDefinition, "path"> {
  return {
    name: definition.name,
    line: definition.line,
    character: definition.character,
    kind: definition.kind,
  };
}
