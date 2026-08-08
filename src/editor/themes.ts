import { EditorView } from "@codemirror/view";
import { HighlightStyle } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { codeEditorFontStack } from "./fontCatalog";

export const baseEditorLayoutTheme = EditorView.theme({
  "&": {
      height: "100%",
      fontSize: "var(--editor-font-size, 14px)",
      lineHeight: "var(--editor-line-height, 1.7)"
  },
  ".cm-content, .cm-gutters": {
      fontSize: "var(--editor-font-size, 14px) !important",
      lineHeight: "var(--editor-line-height, 1.7) !important"
  },
  ".cm-content": {
      color: "var(--ui-text, #333333) !important",
      WebkitTextFillColor: "currentColor",
      paddingBottom: "0 !important"
  },
  ".cm-content::after": {
      content: '\"\"',
      display: "block",
      position: "relative",
      left: "calc(-1 * var(--typsastra-gutter-width, 0px))",
      width: "calc(100% + var(--typsastra-gutter-width, 0px))",
      height: "var(--typsastra-scroll-past-end-height, 0px)",
      backgroundColor: "color-mix(in srgb, var(--ui-accent-color) 0%, var(--ui-bg))",
      borderTop: "1px solid color-mix(in srgb, var(--ui-accent-color) 24%, transparent)",
      boxSizing: "border-box",
      pointerEvents: "none",
      zIndex: "10"
  },
  ".cm-line, .cm-line *": {
      WebkitTextFillColor: "currentColor"
  },
  ".cm-gutterElement": {
      lineHeight: "var(--editor-line-height, 1.7) !important"
  },
  ".cm-lineNumbers .cm-gutterElement": {
      display: "flex",
      alignItems: "flex-start",
      justifyContent: "flex-end",
      boxSizing: "border-box"
  },
  ".cm-foldGutter .cm-gutterElement": {
      fontFamily: "var(--font-family-sans) !important ",
      fontSize: "12px !important",
      fontWeight: "500 !important",
      width: "28px",
      minWidth: "28px",
      padding: "0 5px !important",
      boxSizing: "border-box",
      justifyContent: "center"
  },
  ".cm-foldGutter .cm-gutterElement > span": {
      display: "inline-grid",
      placeItems: "center",
      width: "18px",
      height: "18px",
      boxSizing: "border-box",
      padding: "0 !important",
      color: "var(--ui-text) !important",
      backgroundColor: "var(--ui-navigation-background)",
      border: "1px solid var(--ui-border)",
      borderRadius: "2px",
      lineHeight: "16px",
      verticalAlign: "middle",
      cursor: "pointer"
  },
  ".cm-foldGutter .cm-gutterElement > span:hover": {
      backgroundColor: "var(--ui-hover)",
      borderColor: "var(--ui-accent-color)"
  },
  '.cm-foldGutter .cm-gutterElement > span[data-folded="true"]': {
      color: "var(--ui-bg) !important",
      backgroundColor: "var(--ui-accent-color)",
      borderColor: "var(--ui-accent-color)"
  },
  ".cm-line": { padding: "0 12px", overflow: "visible !important" },
  ".cm-line.cm-wrapped-indent": {
      paddingLeft: "calc(12px + var(--cm-wrapped-indent))",
      textIndent: "calc(0px - var(--cm-wrapped-indent))"
  },
  ".cm-indent-markers::before": {
      left: "calc(13px - 0.7ch) !important",
      zIndex: "0 !important"
  },
  ".cm-gutters": { borderRight: "1px solid var(--ui-border)" },
  ".cm-lineNumbers .cm-activeLineGutter": {
      color: "color-mix(in srgb, var(--ui-accent-color) 58%, var(--ui-text)) !important",
      fontWeight: "400 !important"
  },
  ".cm-cursor, .cm-dropCursor": {
      borderLeftWidth: "0 !important",
      zIndex: "200 !important",
  },
  ".cm-cursor::before, .cm-dropCursor::before": {
      content: '""',
      position: "absolute",
      left: "0",
      top: "50%",
      height: "var(--editor-line-height-px, 23.8px)",
      transform: "translateY(-50%)",
      borderLeft: "2px solid var(--editor-cursor-color, #3db489)",
      filter: "drop-shadow(0 0 2px var(--editor-cursor-shadow, rgba(255, 255, 255, 0.95))) drop-shadow(0 0 5px var(--editor-cursor-glow, rgba(61, 180, 137, 0.45)))",
      pointerEvents: "none"
  },
  ".cm-cursorLayer": {
      zIndex: "200 !important"
  },
  ".cm-focused .cm-cursor": {
      animation: "typsastra-cursor-pulse 1.05s steps(1) infinite"
  },
  "@keyframes typsastra-cursor-pulse": {
      "0%, 45%": {
          filter: "drop-shadow(0 0 2px var(--editor-cursor-shadow, rgba(255, 255, 255, 0.95))) drop-shadow(0 0 5px var(--editor-cursor-glow, rgba(61, 180, 137, 0.45)))"
      },
      "46%, 100%": {
          filter: "drop-shadow(0 0 2px var(--editor-cursor-shadow, rgba(255, 255, 255, 0.95))) drop-shadow(0 0 5px var(--editor-cursor-glow, rgba(61, 180, 137, 0.45)))"
      }
  },
  "& .cm-selectionLayer .cm-selectionBackground": {
      backgroundColor: "var(--ui-word-selection-background, rgba(3, 102, 214, 0.4)) !important",
      outline: "none !important"
  },
  "&.cm-focused .cm-selectionLayer .cm-selectionBackground": {
      backgroundColor: "var(--ui-word-selection-focus-background, rgba(3, 102, 214, 0.52)) !important"
  },
  ".cm-searchMatch": {
      backgroundColor: "var(--ui-navigation-background) !important",
      border: "none !important",
      outline: "none !important",
      boxShadow: "none !important"
  },
  ".cm-searchMatch-selected": {
      backgroundColor: "transparent !important",
      border: "none !important",
      outline: "none !important",
      boxShadow: "none !important"
  },
  "& .cm-content .cm-line::selection, & .cm-content .cm-line *::selection": {
      backgroundColor: "transparent !important"
  },
  ".cm-activeLine, .cm-activeLineGutter": {
      backgroundColor: "var(--ui-active-line-background) !important"
  },
  "&.cm-has-selection .cm-activeLine, &.cm-has-selection .cm-activeLineGutter": {
      backgroundColor: "transparent !important"
  },
  ".cm-matchingBracket": {
      position: "relative",
      zIndex: "0",
      backgroundColor: "transparent !important",
      outline: "none !important",
      boxShadow: "none !important",
      borderRadius: "1px"
  },
  ".cm-matchingBracket::before": {
      content: '""',
      position: "absolute",
      left: "0",
      right: "0",
      top: "50%",
      height: "var(--editor-line-height-px, 23.8px)",
      transform: "translateY(-50%)",
      zIndex: "-1",
      backgroundColor: "color-mix(in srgb, var(--editor-bracket-match-outline, #005cc5) 16%, transparent)",
      borderRadius: "1px",
      pointerEvents: "none"
  },
  ".cm-nonmatchingBracket": {
      backgroundColor: "var(--editor-bracket-mismatch-bg, rgba(215, 58, 73, 0.16)) !important",
      color: "inherit !important"
  },
  "& .bracket-color-0, & .bracket-color-0 *": { color: "var(--editor-bracket-0) !important" },
  "& .bracket-color-1, & .bracket-color-1 *": { color: "var(--editor-bracket-1) !important" },
  "& .bracket-color-2, & .bracket-color-2 *": { color: "var(--editor-bracket-2) !important" },
  "& .bracket-color-3, & .bracket-color-3 *": { color: "var(--editor-bracket-3) !important" },
  "& .bracket-color-4, & .bracket-color-4 *": { color: "var(--editor-bracket-4) !important" }
});

export function editorFontTheme(
  fontFamily: string = codeEditorFontStack("fira-mono"),
  textFontFamily: string = fontFamily
) {
  return EditorView.theme({
    "&": {
      height: "100%",
      "--editor-code-font": fontFamily,
      "--editor-text-font": textFontFamily
    },
    ".cm-content": {
      fontFamily: "var(--editor-code-font) !important"
    },
    ".cm-gutters": {
      fontFamily: "var(--editor-code-font) !important"
    }
  });
}

export const typstColorHighlighting = HighlightStyle.define([
  { tag: [tags.keyword, tags.controlKeyword, tags.atom, tags.bool], color: "#8b2635" },
  { tag: tags.variableName, color: "#5b21b6" },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: "#005cc5" },
  { tag: tags.labelName, color: "#1d6c76" }, // Labels and references (teal)
  { tag: tags.number, color: "#8b2635" },
  { tag: tags.operator, color: "#8b2635" },
  { tag: tags.punctuation, color: "#4b5563" },
  { tag: tags.heading, color: "var(--ui-text, #1f2937)", fontWeight: "bold", textDecoration: "underline" },
  { tag: tags.comment, color: "#6a737d", fontStyle: "italic" },
  { tag: tags.string, color: "#22863a" },
  { tag: [tags.literal, tags.monospace], color: "#5a5a5a" },
  { tag: tags.escape, color: "#22863a" },
  { tag: tags.link, color: "#005cc5", textDecoration: "underline" },
  { tag: tags.regexp, color: "#22863a" }, // mathDelimiter
  { tag: tags.special(tags.operator), color: "#22863a" }, // mathOperator
  { tag: tags.strong, fontWeight: "bold" },
  { tag: tags.emphasis, fontStyle: "italic" }
]);

// Structural formatting belongs to Typst rather than to a selected color
// palette, so keep it active alongside both the default and third-party themes.
export const typstSemanticHighlighting = HighlightStyle.define([
  { tag: tags.heading, fontWeight: "bold", textDecoration: "underline" },
  { tag: tags.strong, fontWeight: "bold" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.link, textDecoration: "underline" }
]);

export const typstVariableHighlighting = HighlightStyle.define([
  { tag: tags.special(tags.variableName), color: "var(--editor-variable-color, #5b21b6)" }
]);

export const typstFunctionHighlighting = HighlightStyle.define([
  {
    tag: [tags.function(tags.variableName), tags.function(tags.propertyName)],
    color: "var(--editor-function-color, #005cc5)"
  }
]);

export const typstFontHighlighting = HighlightStyle.define([
  { tag: [tags.keyword, tags.controlKeyword], fontFamily: "var(--editor-code-font) !important" },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], fontFamily: "var(--editor-code-font) !important" },
  { tag: [tags.variableName, tags.labelName, tags.special(tags.variableName)], fontFamily: "var(--editor-code-font) !important" },
  { tag: [tags.number, tags.atom, tags.bool, tags.escape], fontFamily: "var(--editor-code-font) !important" },
  { tag: [tags.operator, tags.punctuation], fontFamily: "var(--editor-code-font) !important" },
  { tag: tags.heading, scale: 1.15 },
  { tag: tags.comment, fontFamily: "var(--editor-code-font) !important" },
  { tag: tags.string, fontFamily: "var(--editor-code-font) !important" },
  {
    tag: tags.content,
    fontFamily: "var(--editor-text-font) !important",
    fontSize: "var(--editor-text-size, 1em) !important",
    lineHeight: "var(--editor-line-height-px, 23.8px) !important",
    position: "relative",
    top: "-0.08em"
  },
  { tag: [tags.literal, tags.monospace], fontFamily: "var(--editor-code-font) !important", color: "var(--ui-monospace-color) !important" }
]);
