import { StreamLanguage } from "@codemirror/language";
import type { IndentContext, StreamParser, StringStream } from "@codemirror/language";
import { tags } from "@lezer/highlight";

// Saved state of the hash expression that encloses a nested one, so a `#` rule
// inside a content block does not erase its parent's code context when it ends.
type HashExpressionState = {
  inCodeExpression: boolean;
  isStatement: boolean;
  expressionBracketDepth: number;
  expressionComplete: boolean;
  expressionSawWhitespace: boolean;
  expressionParentMode: "markup" | "math";
};

type TypstParserState = {
  inBlockComment: boolean;
  inRawBlock: boolean;
  rawBlockLength: number;
  justStartedRawBlock: boolean;

  // Bracket stack tracks: "(", "[", "{", "$", "math-(", "math-[", "math-{"
  bracketStack: string[];

  // Hash code expression state:
  inCodeExpression: boolean;
  isStatement: boolean;
  expressionBracketDepth: number;
  expressionComplete: boolean;
  expressionSawWhitespace: boolean;
  expressionParentMode: "markup" | "math";
  enclosingExpressions: HashExpressionState[];
  lastToken: string | null;
  inTermListHeader: boolean;
  inHeading: boolean;
  inStrong: boolean;
  inEmphasis: boolean;
};

// Unicode-aware identifier regex (Unicode Standard Annex #31 with underscore/hyphen extensions)
const identifierRegex = /^[\p{L}_][\p{L}\p{N}_-]*/u;

// Statement keywords that extend until semicolon or newline. `context` is a
// keyword, but its expression can finish inline and return to markup before
// another `#` expression on the same line.
const statementKeywords = /^(?:let|set|show|import|include|if|else|for|in|while|break|continue|return|as)$/;
const hashKeywordWords = /^(?:let|set|show|import|include|if|else|for|in|while|break|continue|return|context|as)$/;
const atomWords = /^(?:none|auto|true|false)$/;

// Code mode keyword pattern
const codeKeywordRegex = /^(?:let|set|show|import|include|if|else|for|in|while|break|continue|return|context|as)\b/;

function classifyHashToken(rest: string): string {
  const nextWordMatch = rest.match(identifierRegex);
  if (nextWordMatch) {
    const word = nextWordMatch[0];
    if (hashKeywordWords.test(word)) return "hashKeyword";
    if (atomWords.test(word)) return "hashAtom";
    if (/^\s*(?:\(|\[)/.test(rest.slice(word.length))) return "hashFunction";
    return "hashVariable";
  }
  if (rest.startsWith('"')) return "hashString";
  if (/^\d/.test(rest)) return "hashNumber";
  return "hashOperator";
}

function startsCodeExpression(rest: string): boolean {
  return identifierRegex.test(rest) || /^(?:["\d([{]|[-+])/.test(rest);
}

function getCurrentMode(state: TypstParserState): "markup" | "math" | "code" {
  // A hash expression may start inside markup, a content block, or math. At
  // its original bracket depth it must take precedence over the parent mode.
  if (state.inCodeExpression && state.bracketStack.length <= state.expressionBracketDepth) {
    return "code";
  }

  if (state.bracketStack.length > 0) {
    const top = state.bracketStack[state.bracketStack.length - 1];
    if (top === "$") return "math";
    if (top.startsWith("math-")) return "math";
    if (top === "[") return "markup";
    if (top === "{" || top === "(") return "code";
  }
  return state.inCodeExpression ? "code" : "markup";
}

function contextualToken(token: string | null, state: TypstParserState): string | null {
  if (!token) return token;
  let contextual = token;
  if (state.inHeading && !hasTokenName(contextual, "heading")) contextual += " heading";
  if (state.inStrong && !hasTokenName(contextual, "strong")) contextual += " strong";
  if (state.inEmphasis && !hasTokenName(contextual, "emphasis")) contextual += " emphasis";
  return contextual;
}

function hasTokenName(token: string, name: string): boolean {
  const index = token.indexOf(name);
  return index >= 0
    && (index === 0 || token.charCodeAt(index - 1) === 32)
    && (index + name.length === token.length || token.charCodeAt(index + name.length) === 32);
}

function endCodeExpression(state: TypstParserState) {
  // A hash expression may contain another one, as a set rule inside a content
  // block does. Restore the enclosing expression so its code context survives
  // instead of being cleared, discarding snapshots whose own brackets have
  // already closed.
  while (state.enclosingExpressions.length > 0) {
    const outer = state.enclosingExpressions.pop()!;
    state.inCodeExpression = outer.inCodeExpression;
    state.isStatement = outer.isStatement;
    state.expressionBracketDepth = outer.expressionBracketDepth;
    state.expressionComplete = outer.expressionComplete;
    state.expressionSawWhitespace = outer.expressionSawWhitespace;
    state.expressionParentMode = outer.expressionParentMode;
    if (outer.inCodeExpression && state.bracketStack.length > outer.expressionBracketDepth) {
      return;
    }
  }
  state.inCodeExpression = false;
  state.isStatement = false;
  state.expressionComplete = false;
  state.expressionSawWhitespace = false;
}

function beginCodeExpression(
  state: TypstParserState,
  isStatement: boolean,
  parentMode: "markup" | "math",
) {
  state.enclosingExpressions.push({
    inCodeExpression: state.inCodeExpression,
    isStatement: state.isStatement,
    expressionBracketDepth: state.expressionBracketDepth,
    expressionComplete: state.expressionComplete,
    expressionSawWhitespace: state.expressionSawWhitespace,
    expressionParentMode: state.expressionParentMode,
  });
  state.inCodeExpression = true;
  state.isStatement = isStatement;
  state.expressionBracketDepth = state.bracketStack.length;
  state.expressionComplete = false;
  state.expressionSawWhitespace = false;
  state.expressionParentMode = parentMode;
}

const typstParser: StreamParser<TypstParserState> = {
  name: "typst",

  startState() {
    return {
      inBlockComment: false,
      inRawBlock: false,
      rawBlockLength: 0,
      justStartedRawBlock: false,
      bracketStack: [],
      inCodeExpression: false,
      isStatement: false,
      expressionBracketDepth: 0,
      expressionComplete: false,
      expressionSawWhitespace: false,
      expressionParentMode: "markup",
      enclosingExpressions: [],
      lastToken: null,
      inTermListHeader: false,
      inHeading: false,
      inStrong: false,
      inEmphasis: false
    };
  },

  token(stream: StringStream, state: TypstParserState): string | null {
    const rawToken = readToken(stream, state);
    const tok = contextualToken(rawToken, state);
    if (rawToken && rawToken !== "comment" && rawToken !== "monospace") {
      state.lastToken = rawToken;
    }

    if (tok && state.inCodeExpression && !state.isStatement && state.bracketStack.length <= state.expressionBracketDepth) {
      const current = stream.current();
      if (hasTokenName(tok, "function")
        || hasTokenName(tok, "variable")
        || hasTokenName(tok, "number")
        || hasTokenName(tok, "atom")
        || hasTokenName(tok, "string")) {
        state.expressionComplete = true;
      } else if (hasTokenName(tok, "operator") && current !== "#") {
        state.expressionComplete = false;
      } else if (hasTokenName(tok, "punctuation")) {
        if (/^[)\]}]$/.test(current)) state.expressionComplete = true;
        else if (/^[.,:]$/.test(current)) state.expressionComplete = false;
      }
      state.expressionSawWhitespace = false;
    }
    return tok;
  },



  languageData: {
    commentTokens: { line: "//", block: { open: "/*", close: "*/" } },
    indentOnInput: /^\s*[\}\]]$/,
    closeBrackets: { brackets: ["(", "[", "{", '"', "'", "*", "_", "$"] }
  },

  indent(state: TypstParserState, textAfter: string, cx: IndentContext) {
    if (state.inBlockComment || state.inRawBlock) return null;
    const indentBrackets = state.bracketStack.filter(b => b === "(" || b === "[" || b === "{");
    let indentLevels = indentBrackets.length;
    for (let index = 1; index < indentBrackets.length; index += 1) {
      // A closure body replaces the indentation contributed by its enclosing
      // call rather than adding another visible level: `items.map(it => {`.
      if (indentBrackets[index - 1] === "(" && indentBrackets[index] === "{") {
        indentLevels -= 1;
      }
    }
    let indent = indentLevels * cx.unit;
    if (/^[\}\]]/.test(textAfter)) indent -= cx.unit;
    return Math.max(0, indent);
  },

  tokenTable: {
    keyword: tags.keyword,
    hashKeyword: tags.keyword,
    hashFunction: tags.function(tags.variableName),
    hashVariable: tags.special(tags.variableName),
    hashString: tags.string,
    hashAtom: tags.atom,
    hashNumber: tags.number,
    hashOperator: tags.operator,
    operator: tags.operator,
    punctuation: tags.punctuation,
    comment: tags.comment,
    string: tags.string,
    number: tags.number,
    atom: tags.atom,
    heading: tags.heading,
    label: tags.labelName,
    reference: tags.labelName,
    function: tags.function(tags.variableName),
    referenceVariable: tags.special(tags.variableName),
    mathVariable: tags.special(tags.variableName),
    strong: tags.strong,
    emphasis: tags.emphasis,
    monospace: tags.monospace,
    indentation: tags.special(tags.monospace),
    escape: tags.escape,
    link: tags.link,
    content: tags.content,
    mathDelimiter: tags.regexp,
    mathOperator: tags.special(tags.operator),
    term: tags.strong
  }
};

export const typstLanguage = StreamLanguage.define(typstParser);


function readToken(stream: StringStream, state: TypstParserState): string | null {
    // 1. Handle start of line state resets
    if (stream.sol()) {
      state.inHeading = false;
      if (state.inCodeExpression && state.bracketStack.length <= state.expressionBracketDepth) {
        endCodeExpression(state);
      }
    }

    // 2. Handle block comment state
    if (state.inBlockComment) {
      if (stream.skipTo("*/")) {
        stream.match("*/");
        state.inBlockComment = false;
      } else {
        stream.skipToEnd();
      }
      return "comment";
    }

    // 3. Highlight an optional language name on the opening raw-block line.
    // This must run before the generic inRawBlock branch consumes the line.
    if (state.justStartedRawBlock) {
      state.justStartedRawBlock = false;
      stream.eatSpace();
      if (stream.match(/[A-Za-z_][\w-]*/)) {
        return "string";
      }
    }

    // 4. Handle raw blocks
    if (state.inRawBlock) {
      const endPattern = new RegExp("^\\s*`{" + state.rawBlockLength + "}\\s*$");
      if (stream.match(endPattern)) {
        state.inRawBlock = false;
        return "punctuation";
      }
      stream.skipToEnd();
      return "monospace";
    }

    // Keep line-leading indentation on the fixed monospace metrics even when
    // the user selects a proportional editor font. Ordinary prose spacing
    // remains untagged and therefore inherits the selected editor family.
    const isLeadingWhitespace = stream.sol();
    if (stream.eatSpace()) {
      if (state.inCodeExpression && !state.isStatement && state.bracketStack.length <= state.expressionBracketDepth) {
        state.expressionSawWhitespace = true;
      }

      if (state.inHeading) {
        const followedByLabel = /^<[\p{L}\p{N}_:-]+>/u.test(stream.string.slice(stream.pos));
        if (followedByLabel) {
          state.inHeading = false;
          return null;
        }
        return "heading";
      }

      return isLeadingWhitespace ? "indentation" : null;
    }

    // Check for comments
    if (stream.match("//")) {
      const prevChar = stream.start > 0 ? stream.string[stream.start - 1] : "";
      if (prevChar === ":") {
        stream.backUp(2);
      } else {
        stream.skipToEnd();
        return "comment";
      }
    }

    if (stream.match("/*")) {
      state.inBlockComment = true;
      return "comment";
    }

    let mode = getCurrentMode(state);

    // A completed simple expression returns to its parent mode when prose (or
    // math) resumes. Operators, member access, and argument/content blocks are
    // valid continuations and remain in code mode.
    if (mode === "code" && state.inCodeExpression && !state.isStatement &&
        state.bracketStack.length <= state.expressionBracketDepth && state.expressionComplete) {
      const rest = stream.string.slice(stream.pos);
      const canContinueAfterSpace = /^(?:[([{.]|=>|==|!=|<=|>=|\.\.|[+\-*\/%=<>!&|^~])/.test(rest);
      const closesParentMath = state.expressionParentMode === "math" && stream.peek() === "$";
      const closesParentMarkup = state.expressionParentMode === "markup" && (
        (stream.peek() === "*" && state.inStrong)
        || (stream.peek() === "_" && state.inEmphasis)
        || (stream.peek() === "]" && state.bracketStack[state.bracketStack.length - 1] === "[")
      );

      if (closesParentMath || closesParentMarkup || (state.expressionSawWhitespace && !canContinueAfterSpace)) {
        endCodeExpression(state);
        mode = getCurrentMode(state);
      }
    }

    // ==========================================
    // MARKUP MODE
    // ==========================================
    if (mode === "markup") {
      // Keep visually paired square brackets balanced in markup as well as in
      // code-owned content blocks. Without this, an outer markup `[` is
      // classified as plain content while its closing `]` is punctuation,
      // causing nested endings such as `[#text[content]]` to mark the second
      // closing bracket as non-matching.
      if (stream.match("[")) {
        state.bracketStack.push("[");
        return "punctuation";
      }

      // Term list header parsing
      if (state.inTermListHeader) {
        if (stream.eatSpace()) return null;
        if (stream.match(":")) {
          state.inTermListHeader = false;
          return "punctuation";
        }
        if (stream.match(/[^:]+/)) {
          return "term";
        }
      }

      // Headings (e.g. = Heading)
      if (stream.sol() && stream.match(/={1,6}(?=\s)/)) {
        state.inHeading = true;
        return "heading";
      }

      // Lists (bullet, numbered, terms)
      const isLineStart = stream.pos === (stream.string.match(/^\s*/) || [""])[0].length;
      if (isLineStart) {
        if (stream.match(/-\s+/)) return "operator";
        if (stream.match(/\+\s+/)) return "operator";
        if (stream.match(/\/\s+[^\s:][^:]*:\s+/, false)) {
          stream.match("/");
          state.inTermListHeader = true;
          return "operator";
        }
      }

      // Content block exit
      if (stream.match("]")) {
        if (state.bracketStack[state.bracketStack.length - 1] === "[") {
          state.bracketStack.pop();
        }
        return "punctuation";
      }

      // Escape sequences
      if (stream.match(/\\u\{[0-9a-fA-F]+\}/) || stream.match(/\\./)) return "escape";

      // Math mode entry
      if (stream.match("$")) {
        state.bracketStack.push("$");
        return "mathDelimiter";
      }

      // Raw text blocks (inline and block)
      if (stream.match(/^`{3,}/)) {
        const len = stream.current().length;
        state.inRawBlock = true;
        state.rawBlockLength = len;
        state.justStartedRawBlock = !stream.eol();
        return "punctuation";
      }
      if (stream.match(/`[^`]*`/)) return "monospace";

      // Strong / Emphasis
      if (stream.match("*")) {
        state.inStrong = !state.inStrong;
        return "strong";
      }
      if (stream.match("_")) {
        state.inEmphasis = !state.inEmphasis;
        return "emphasis";
      }

      // Links/URLs
      if (stream.match(/https?:\/\/[^\s"'()<>]+/)) return "link";

      // Labels and References
      if (stream.match(/<[\p{L}\p{N}_:-]+>/u)) {
        // A trailing label attaches to the heading but is not heading text.
        // Clear the context before contextualToken adds the heading tag.
        state.inHeading = false;
        return "label";
      }
      if (stream.match(/@[\p{L}\p{N}_:-]+/u)) return "reference";

      // Line breaks
      if (stream.match("\\")) return "punctuation";

      // Symbol shorthands & punctuation
      if (stream.match("---") || stream.match("--") || stream.match("~")) return "operator";
      if (stream.match("'") || stream.match('"')) return "punctuation";

      // Code expression entry (#followed by letter/underscore)
      if (stream.match("#")) {
        const rest = stream.string.slice(stream.pos);
        const nextWordMatch = rest.match(identifierRegex);
        if (startsCodeExpression(rest)) {
          beginCodeExpression(state, nextWordMatch ? statementKeywords.test(nextWordMatch[0]) : false, "markup");
          return classifyHashToken(rest);
        }
        return "hashOperator";
      }

      stream.next();
      return "content";
    }

    // ==========================================
    // MATH MODE
    // ==========================================
    if (mode === "math") {
      // Exit math mode
      if (stream.match("$")) {
        while (state.bracketStack.length > 0) {
          const top = state.bracketStack.pop()!;
          if (top === "$") break;
        }
        return "mathDelimiter";
      }

      // Escape sequence
      if (stream.match(/\\u\{[0-9a-fA-F]+\}/) || stream.match(/\\./)) return "escape";

      // Math operators & line breaks
      if (stream.match("\\") || stream.match("&") || stream.match("_") || stream.match("^") || stream.match("/")) {
        return "mathOperator";
      }

      // String literal in math (e.g. "is natural")
      if (stream.match(/"[^"]*"/)) return "string";

      // Code expression inside math
      if (stream.match("#")) {
        const rest = stream.string.slice(stream.pos);
        const nextWordMatch = rest.match(identifierRegex);
        if (startsCodeExpression(rest)) {
          beginCodeExpression(state, nextWordMatch ? statementKeywords.test(nextWordMatch[0]) : false, "math");
          return classifyHashToken(rest);
        }
        return "hashOperator";
      }

      // Math grouping delimiters
      if (stream.match(/[({[]/)) {
        state.bracketStack.push("math-" + stream.current());
        return "punctuation";
      }
      if (stream.match(/[)}\]]/)) {
        const char = stream.current();
        const expected = "math-" + (char === ")" ? "(" : char === "}" ? "{" : "[");
        if (state.bracketStack[state.bracketStack.length - 1] === expected) {
          state.bracketStack.pop();
        }
        return "punctuation";
      }

      // Symbol shorthands & relations
      if (stream.match("->") || stream.match("!=") || stream.match("&=") || stream.match("=>") || stream.match("<=") || stream.match(">=")) {
        return "mathOperator";
      }
      if (stream.match(/[=<>\!]/)) {
        return "mathOperator";
      }
      if (stream.match(/[+\-*&|~]+/)) {
        return "punctuation";
      }

      // Numbers
      if (stream.match(/\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/)) return "number";

      // Math functions and symbols
      if (stream.match(identifierRegex)) {
        if (stream.match(/^\(/, false)) return "function";
        return null;
      }

      stream.next();
      return null;
    }

    // ==========================================
    // CODE MODE
    // ==========================================
    if (mode === "code") {
      // Content block entry (switches to markup mode)
      if (stream.match("[")) {
        state.bracketStack.push("[");
        return "punctuation";
      }
      if (stream.match("]")) {
        if (state.bracketStack[state.bracketStack.length - 1] === "[") {
          state.bracketStack.pop();
        }
        return "punctuation";
      }

      // Brackets, Parentheses, Braces
      if (stream.match("(")) {
        state.bracketStack.push("(");
        return "punctuation";
      }
      if (stream.match(")")) {
        if (state.bracketStack[state.bracketStack.length - 1] === "(") {
          state.bracketStack.pop();
        }
        return "punctuation";
      }
      if (stream.match("{")) {
        state.bracketStack.push("{");
        return "punctuation";
      }
      if (stream.match("}")) {
        if (state.bracketStack[state.bracketStack.length - 1] === "{") {
          state.bracketStack.pop();
        }
        return "punctuation";
      }

      // String literal
      if (stream.match(/"(?:[^"\\]|\\.)*"/)) return "string";

      // Inline raw / monospace block
      if (stream.match(/`[^`]*`/)) return "monospace";

      // Math mode entry
      if (stream.match("$")) {
        state.bracketStack.push("$");
        return "punctuation";
      }

      // Keywords
      if (stream.match(codeKeywordRegex)) return "keyword";

      // Atoms / Bools
      if (stream.match(/^(?:none|auto|true|false)\b/)) return "atom";

      // Numbers (with unit support)
      if (stream.match(/0x[0-9a-fA-F]+\b/) ||
          stream.match(/\d+(?:\.\d+)?(?:[eE][+-]?\d+)?(?:%|pt|em|mm|cm|in|deg|rad|fr)?(?![\p{L}\p{N}_])/u)) {
        return "number";
      }

      // Labels in code mode
      if (stream.match(/<[\p{L}\p{N}_:-]+>/u)) return "label";

      // Identifiers & Functions
      if (stream.match(identifierRegex)) {
        if (stream.match(/^\s*(?:\(|\[)/, false)) return "function";
        if (state.inCodeExpression && !state.isStatement) {
          if (state.bracketStack.length <= state.expressionBracketDepth) {
            state.expressionComplete = true;
            state.expressionSawWhitespace = false;
          }
          return "referenceVariable";
        }
        return null;
      }

      // Operators
      if (stream.match("=>")) return "operator";
      if (stream.match("..")) return "operator";
      if (stream.match(".")) return "punctuation";
      if (stream.match(/[+\-*\/%=<>!&|^~]+/)) return "operator";

      // Punctuation
      if (stream.match(/[.,:;]/)) {
        const char = stream.current();
        if (char === ";" && state.bracketStack.length <= state.expressionBracketDepth) {
          endCodeExpression(state);
        }
        if (char === ":") {
          if (state.lastToken === "keyword" || state.lastToken === "string") {
            return "operator";
          }
        }
        return "punctuation";
      }

      stream.next();
      return null;
    }

    stream.next();
    return null;
 }
