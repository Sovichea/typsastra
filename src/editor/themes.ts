import { EditorView } from "@codemirror/view";
import { HighlightStyle } from "@codemirror/language";
import { tags } from "@lezer/highlight";

export const unicodeLayoutTheme = EditorView.theme({
  "&": { height: "100%", backgroundColor: "#1e1e1e", color: "#d4d4d4" },
  ".cm-content": { fontFamily: "monospace, 'MiSans Khmer', sans-serif", fontSize: "15px", padding: "10px 0" },
  ".cm-line": { padding: "0 12px", lineHeight: "1.7", overflow: "visible !important" },
  ".cm-gutters": { backgroundColor: "#1e1e1e", color: "#858585", border: "none" }
});

export const typstSyntaxHighlighting = HighlightStyle.define([
  { tag: tags.keyword, color: "#569cd6", fontWeight: "bold" },
  { tag: tags.heading, color: "#4fc1ff", fontWeight: "bold", scale: 1.15 },
  { tag: tags.comment, color: "#6a9955", fontStyle: "italic" },
  { 
    tag: [tags.string, tags.content, tags.literal], 
    color: "#ce9178",
    fontFamily: "system-ui, -apple-system, 'MiSans Khmer', 'Noto Sans Arabic', 'Noto Sans Devanagari', sans-serif"
  }
]);
