import { EditorView } from "@codemirror/view";
import { HighlightStyle } from "@codemirror/language";
import { tags } from "@lezer/highlight";

export const unicodeLayoutTheme = EditorView.theme({
  "&": { height: "100%", backgroundColor: "#ffffff", color: "#333333" },
  ".cm-content": { fontFamily: "monospace, 'MiSans Khmer', sans-serif", fontSize: "15px", padding: "10px 0" },
  ".cm-line": { padding: "0 12px", lineHeight: "1.7", overflow: "visible !important" },
  ".cm-gutters": { backgroundColor: "#f9f9f9", color: "#858585", borderRight: "1px solid #e0e0e0" }
});

export const typstSyntaxHighlighting = HighlightStyle.define([
  { tag: tags.keyword, color: "#0000ff", fontWeight: "bold" },
  { tag: tags.heading, color: "#0056b3", fontWeight: "bold", scale: 1.15 },
  { tag: tags.comment, color: "#008000", fontStyle: "italic" },
  { 
    tag: [tags.string, tags.content, tags.literal], 
    color: "#a31515",
    fontFamily: "system-ui, -apple-system, 'MiSans Khmer', 'Noto Sans Arabic', 'Noto Sans Devanagari', sans-serif"
  }
]);
