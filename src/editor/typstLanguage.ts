import {
  LRLanguage,
  delimitedIndent,
  indentNodeProp,
} from "@codemirror/language";
import { styleTags, tags } from "@lezer/highlight";
import { parser } from "./typstParser";

const typstHighlighting = styleTags({
  "LineComment BlockComment": tags.comment,
  Escape: tags.escape,
  Shorthand: tags.operator,

  HeadingMarker: tags.heading,
  "Heading/Content": [tags.heading, tags.content],
  "Strong/Content": [tags.strong, tags.content],
  "Emph/Content": [tags.emphasis, tags.content],
  "Strong/Emph/Content": [tags.strong, tags.emphasis, tags.content],
  "Emph/Strong/Content": [tags.strong, tags.emphasis, tags.content],

  "RawInline/... RawBlock/RawBlockText RawFence Backtick": tags.monospace,
  RawLang: tags.string,
  Url: tags.link,
  "LabelToken RefToken": tags.labelName,
  Text: tags.content,

  "Let Set Show Context If Else For In While Break Continue Return Import Include Not And Or None Auto True False": tags.keyword,
  Bool: tags.bool,
  Numeric: tags.number,
  Str: tags.string,
  Ident: tags.special(tags.variableName),
  "FieldAccess/Ident": tags.propertyName,

  Hash: tags.special(tags.variableName),
  Dollar: tags.regexp,
  MathOperator: tags.special(tags.operator),

  "Eq EqEq ExclEq Lt LtEq Gt GtEq Plus PlusEq Minus HyphEq Star StarEq Slash SlashEq Hat Dots Arrow": tags.operator,
  "LeftBrace RightBrace LeftBracket RightBracket LeftParen RightParen Comma Semicolon Colon Dot": tags.punctuation,
});

const typstIndentation = indentNodeProp.add({
  CodeBlock: delimitedIndent({ closing: "}", align: false }),
  ContentBlock: delimitedIndent({ closing: "]", align: false }),
  Args: delimitedIndent({ closing: ")", align: false }),
  Parenthesized: delimitedIndent({ closing: ")", align: false }),
  MathGroup: context => {
    const close = context.node.firstChild?.name === "LeftBrace"
      ? "}"
      : context.node.firstChild?.name === "LeftBracket"
        ? "]"
        : ")";
    return delimitedIndent({ closing: close, align: false })(context);
  },
});

export const typstParser = parser.configure({
  props: [
    typstHighlighting,
    typstIndentation,
  ],
});

export const typstLanguage = LRLanguage.define({
  name: "typst",
  parser: typstParser,
  languageData: {
    commentTokens: {
      line: "//",
      block: { open: "/*", close: "*/" },
    },
    closeBrackets: {
      brackets: ["(", "[", "{", '"', "'", "*", "_", "$"],
    },
    indentOnInput: /^\s*[\}\]\)]$/,
  },
});
