import { StreamLanguage } from "@codemirror/language";
import type { StreamParser, StringStream } from "@codemirror/language";

type TypstParserState = {
  inBlockComment: boolean;
  inRawBlock: boolean;
  justStartedRawBlock: boolean;
  bracketStack: string[];
  inCodeLine: boolean;
};

const keywordPatternMarkup = /#(?:let|set|show|import|include|if|else|for|while|break|continue|return|none|auto|true|false)\b/;
const keywordPatternCode = /\b(?:let|set|show|import|include|if|else|for|while|break|continue|return|none|auto|true|false)\b/;

const functionPatternMarkup = /#[A-Za-z_][\w.-]*(?=\s*(?:\(|\[))/;
const functionPatternCode = /[A-Za-z_][\w.-]*(?=\s*(?:\(|\[))/;

const typstParser: StreamParser<TypstParserState> = {
  name: "typst",

  startState() {
    return { inBlockComment: false, inRawBlock: false, justStartedRawBlock: false, bracketStack: [], inCodeLine: false };
  },

  token(stream: StringStream, state: TypstParserState): string | null {
    if (stream.sol()) {
      state.inCodeLine = false;
    }

    if (stream.sol() && stream.match(/```/)) {
      state.inRawBlock = !state.inRawBlock;
      state.justStartedRawBlock = state.inRawBlock;
      return "punctuation";
    }

    if (state.justStartedRawBlock) {
      state.justStartedRawBlock = false;
      stream.eatSpace();
      if (stream.match(/[A-Za-z_][\w-]*/)) {
        return "keyword";
      }
    }

    if (state.inRawBlock) {
      stream.skipToEnd();
      return "monospace";
    }

    if (state.inBlockComment) {
      if (stream.skipTo("*/")) {
        stream.match("*/");
        state.inBlockComment = false;
      } else {
        stream.skipToEnd();
      }
      return "comment";
    }

    if (stream.eatSpace()) return null;

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

    const isCodeMode = state.inCodeLine || (state.bracketStack.length > 0 && !state.bracketStack[state.bracketStack.length - 1].includes("standalone") && state.bracketStack[state.bracketStack.length - 1] !== "[");
    const inMarkup = !isCodeMode;

    if (stream.sol() && stream.match(/={1,6}(?=\s)/)) return "heading";

    if (stream.match(/\\./)) {
      return inMarkup ? "content" : null;
    }

    if (isCodeMode && stream.match(/"(?:[^"\\]|\\.)*"?/)) return "string";
    if (stream.match(/`[^`]*`?/)) return "monospace";
    if (stream.match(/\$(?:[^$\\]|\\.)*\$?/)) return "monospace";
    if (stream.match(/@[A-Za-z0-9_-]+/)) {
      const prevChar = stream.start > 0 ? stream.string[stream.start - 1] : "";
      if (prevChar && /[A-Za-z0-9]/.test(prevChar)) {
        stream.backUp(stream.current().length);
      } else {
        return "labelName";
      }
    }
    if (stream.match(/<[A-Za-z0-9:_-]+>/)) return "labelName";
    
    if (isCodeMode) {
      if (stream.match(keywordPatternCode)) {
        return "keyword";
      }
      if (stream.match(functionPatternCode)) {
        return "variableName function";
      }
      if (stream.match(/[A-Za-z_][\w-]*/)) {
        return "variableName";
      }
    } else {
      const prevChar = stream.start > 0 ? stream.string[stream.start - 1] : "";
      const isPrecededByAlphanumeric = prevChar && /[A-Za-z0-9]/.test(prevChar);
      if (!isPrecededByAlphanumeric) {
        if (stream.match(keywordPatternMarkup)) {
          state.inCodeLine = true;
          return "keyword";
        }
        if (stream.match(functionPatternMarkup)) {
          state.inCodeLine = true;
          return "variableName function";
        }
        if (stream.match(/#[A-Za-z_][\w-]*/)) {
          state.inCodeLine = true;
          return "variableName";
        }
      }
    }

    // Code-only features (numbers, operators, separators)
    if (!inMarkup) {
      if (stream.match(/\b\d+(?:\.\d+)?(?:pt|em|mm|cm|in|deg|%|fr)?\b/)) return "number";
      if (stream.match(/[+\-*/=<>!&|]+/)) return "operator";
      if (stream.match(/[.,:;]/)) {
        if (stream.current() === ";") {
          state.inCodeLine = false;
        }
        return "punctuation";
      }
    }

    if (stream.match(/[({[]/)) {
      const char = stream.current();
      if (char === "[" || isCodeMode) {
        if (char === "[") {
          state.bracketStack.push(isCodeMode ? "[" : "[standalone]");
          state.inCodeLine = false;
          return isCodeMode ? "punctuation" : "content";
        } else {
          state.bracketStack.push(char);
          return "punctuation";
        }
      }
      return inMarkup ? "content" : null;
    }
    
    if (stream.match(/[)}\]]/)) {
      const char = stream.current();
      const expected = char === ")" ? "(" : char === "}" ? "{" : "[";
      if (state.bracketStack.length > 0) {
        const top = state.bracketStack[state.bracketStack.length - 1];
        if (top === expected || (expected === "[" && top === "[standalone]")) {
          state.bracketStack.pop();
          return top === "[" ? "punctuation" : "content";
        }
      }
      return inMarkup ? "content" : null;
    }

    if (stream.match(/\*{1,2}|_{1,2}/)) return "strong";

    stream.next();
    return inMarkup ? "content" : null;
  },
  
  languageData: {
    commentTokens: { line: "//", block: { open: "/*", close: "*/" } },
    indentOnInput: /^\s*[\}\]]$/,
    closeBrackets: { brackets: ["(", "[", "{", '"', "'", "*", "_", "$"] }
  },

  indent(state: TypstParserState, textAfter: string, cx) {
    if (state.inBlockComment || state.inRawBlock) return null;
    let indent = state.bracketStack.length * cx.unit;
    if (/^[\}\]]/.test(textAfter)) indent -= cx.unit;
    return indent;
  }
};

export const typstLanguage = StreamLanguage.define(typstParser);
