import { RangeSetBuilder, StateEffect, StateField } from "@codemirror/state";
import type { EditorState, Extension } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType } from "@codemirror/view";
import type { DecorationSet, ViewUpdate } from "@codemirror/view";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { relativeFilePath } from "../platform/paths";
import { t } from "../i18n";

export type PathWarningContext = {
  workspaceRoot: string;
  documentPath: string;
};

export type TypstPathWarning = {
  /** Start of the path content, after the opening quote. */
  from: number;
  /** End of the path content, before the closing quote. */
  to: number;
  /** Position after the closing quote, where the fix button is rendered. */
  widgetAt: number;
  path: string;
  rootPath: string;
  message: string;
};

type Token = {
  name: string;
  from: number;
  to: number;
  text: string;
};

const PATH_FUNCTIONS = new Set([
  "image",
  "include",
  "import",
  "bibliography",
  "csv",
  "json",
  "yaml",
  "toml",
  "cbor",
  "xml",
  "read",
  "plugin",
  "embed",
]);

const MAX_PATH_SCAN_LENGTH = 1_000_000;
const PATH_WARNING_DELAY_MS = 250;

/**
 * Finds relative path arguments that climb out of the current document folder.
 * Root-relative paths are more portable when a document moves inside the
 * project, so every path-taking Typst function gets the same warning and fix.
 */
export function findTypstPathWarnings(
  state: EditorState,
  context: PathWarningContext | null,
): TypstPathWarning[] {
  if (!context || state.doc.length > MAX_PATH_SCAN_LENGTH) return [];
  const documentRelative = relativeFilePath(context.workspaceRoot, context.documentPath);
  if (documentRelative === null) return [];

  const tree = ensureSyntaxTree(state, state.doc.length, 1_000) ?? syntaxTree(state);
  const tokens: Token[] = [];
  const cursor = tree.cursor();
  do {
    tokens.push({
      name: cursor.name,
      from: cursor.from,
      to: cursor.to,
      text: state.doc.sliceString(cursor.from, cursor.to),
    });
  } while (cursor.next());

  const warnings: TypstPathWarning[] = [];
  const seen = new Set<string>();
  const addWarning = (token: Token | null): void => {
    if (!token || token.name !== "string" || token.text.length < 2) return;
    const key = `${token.from}:${token.to}`;
    if (seen.has(key)) return;
    seen.add(key);
    const rawPath = token.text.slice(1, -1);
    const path = unescapeTypstPath(rawPath);
    if (!pathNeedsRootFix(path)) return;
    const rootPath = rootRelativePath(documentRelative, path);
    if (!rootPath) return;
    warnings.push({
      from: token.from + 1,
      to: token.to - 1,
      widgetAt: token.to,
      path,
      rootPath,
      message: t`Root-relative paths are encouraged for compatibility. Use "${rootPath}".`,
    });
  };

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.name === "keyword" && (token.text === "include" || token.text === "import")) {
      addWarning(firstStringAfterKeyword(tokens, index));
      continue;
    }
    if (token.name !== "function" || !PATH_FUNCTIONS.has(token.text)) continue;
    if (token.text === "embed" && !isPdfEmbed(tokens, index)) continue;
    const next = tokens[index + 1];
    if (next?.name !== "punctuation" || !next.text.includes("(")) continue;
    addWarning(firstStringInCall(tokens, index));
    if (token.text === "bibliography") {
      for (const stringToken of allStringsInCall(tokens, index)) addWarning(stringToken);
    }
  }

  return warnings.sort((left, right) => left.from - right.from || left.to - right.to);
}

export function rootRelativePath(documentRelativePath: string, sourcePath: string): string | null {
  const parts = documentRelativePath.replace(/\\/g, "/").split("/").filter(Boolean);
  parts.pop();
  for (const part of sourcePath.replace(/\\/g, "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) return null;
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.length > 0 ? `/${parts.join("/")}` : null;
}

function firstStringAfterKeyword(tokens: readonly Token[], keywordIndex: number): Token | null {
  const next = tokens[keywordIndex + 1];
  if (!next) return null;
  if (next.name === "string") return next;
  if (next.name === "punctuation" && next.text.includes("(")) {
    return firstStringInCall(tokens, keywordIndex);
  }
  return null;
}

function firstStringInCall(tokens: readonly Token[], functionIndex: number): Token | null {
  let depth = 0;
  let entered = false;
  for (let index = functionIndex + 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.name === "punctuation") {
      for (const character of token.text) {
        if (character === "(") {
          depth += 1;
          entered = true;
        } else if (character === ")") {
          depth -= 1;
          if (entered && depth === 0) return null;
        }
      }
      continue;
    }
    if (entered && depth === 1 && token.name === "string") return token;
  }
  return null;
}

function allStringsInCall(tokens: readonly Token[], functionIndex: number): Token[] {
  const strings: Token[] = [];
  let depth = 0;
  let entered = false;
  for (let index = functionIndex + 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.name === "punctuation") {
      for (const character of token.text) {
        if (character === "(") {
          depth += 1;
          entered = true;
        } else if (character === ")") {
          depth -= 1;
          if (entered && depth === 0) return strings;
        }
      }
      continue;
    }
    if (entered && token.name === "string") strings.push(token);
  }
  return strings;
}

function isPdfEmbed(tokens: readonly Token[], functionIndex: number): boolean {
  return tokens[functionIndex - 1]?.name === "punctuation"
    && tokens[functionIndex - 1]?.text === "."
    && tokens[functionIndex - 2]?.name === "referenceVariable"
    && tokens[functionIndex - 2]?.text === "pdf";
}

function pathNeedsRootFix(path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  if (!normalized.includes("../")) return false;
  if (/^(?:[A-Za-z]:\/|\/\/|\/|@|(?:https?|file):)/iu.test(normalized)) return false;
  return true;
}

function unescapeTypstPath(value: string): string {
  return value.replace(/\\(["\\])/gu, "$1");
}

function escapeTypstPath(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export function applyPathFix(view: EditorView, warning: TypstPathWarning): void {
  const insert = escapeTypstPath(warning.rootPath);
  view.dispatch({
    changes: { from: warning.from, to: warning.to, insert },
    selection: { anchor: warning.from + insert.length },
    scrollIntoView: true,
    userEvent: "input.complete",
    effects: setPathWarningsEffect.of([]),
  });
  view.focus();
}

class PathFixWidget extends WidgetType {
  constructor(private readonly warning: TypstPathWarning) {
    super();
  }

  eq(other: PathFixWidget): boolean {
    return other.warning.from === this.warning.from
      && other.warning.to === this.warning.to
      && other.warning.rootPath === this.warning.rootPath;
  }

  toDOM(view: EditorView): HTMLElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "cm-path-fix-button";
    button.textContent = t("Use root path");
    button.title = this.warning.message;
    button.setAttribute("aria-label", t`Use root path ${this.warning.rootPath}`);
    button.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      applyPathFix(view, this.warning);
    });
    return button;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

const setPathWarningsEffect = StateEffect.define<readonly TypstPathWarning[]>();

function buildPathWarningDecorations(warnings: readonly TypstPathWarning[]): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const warning of warnings) {
    if (warning.to <= warning.from) continue;
    builder.add(warning.from, warning.to, Decoration.mark({
      class: "cm-relative-path-warning",
      attributes: { title: warning.message },
    }));
    builder.add(warning.widgetAt, warning.widgetAt, Decoration.widget({
      widget: new PathFixWidget(warning),
      side: 1,
    }));
  }
  return builder.finish();
}

const pathWarningsField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, transaction) {
    let next = value.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (effect.is(setPathWarningsEffect)) next = buildPathWarningDecorations(effect.value);
    }
    return next;
  },
  provide: field => EditorView.decorations.from(field),
});

export function pathWarningsExtension(getContext: () => PathWarningContext | null): Extension {
  const contextKey = (): string => {
    const context = getContext();
    return context ? `${context.workspaceRoot}\0${context.documentPath}` : "";
  };
  return [
    pathWarningsField,
    ViewPlugin.fromClass(class {
      private timer: number | null = null;
      private contextKey = contextKey();

      constructor(private readonly view: EditorView) {
        this.schedule(0);
      }

      update(update: ViewUpdate): void {
        const key = contextKey();
        if (!update.docChanged && key === this.contextKey) return;
        this.contextKey = key;
        this.schedule(PATH_WARNING_DELAY_MS);
      }

      destroy(): void {
        if (this.timer !== null) window.clearTimeout(this.timer);
        this.timer = null;
      }

      private schedule(delay: number): void {
        if (this.timer !== null) window.clearTimeout(this.timer);
        this.timer = window.setTimeout(() => {
          this.timer = null;
          const warnings = findTypstPathWarnings(this.view.state, getContext());
          this.view.dispatch({ effects: setPathWarningsEffect.of(warnings) });
        }, delay);
      }
    }),
  ];
}
