import { Extension } from "@codemirror/state";
import { lineNumbers, highlightActiveLineGutter, highlightActiveLine, drawSelection, dropCursor, keymap } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { unicodeLayoutTheme, typstSyntaxHighlighting } from "./themes";
import { syntaxHighlighting } from "@codemirror/language";

export function getEditorExtensions(): Extension[] {
  return [
    lineNumbers(), highlightActiveLineGutter(), highlightActiveLine(),
    drawSelection(), dropCursor(), history(), unicodeLayoutTheme,
    syntaxHighlighting(typstSyntaxHighlighting),
    keymap.of([...defaultKeymap, ...historyKeymap])
  ];
}
