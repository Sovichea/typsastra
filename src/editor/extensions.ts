import { Extension } from "@codemirror/state";
import { lineNumbers, highlightActiveLineGutter, highlightActiveLine, drawSelection, dropCursor, keymap } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { unicodeLayoutTheme, typstSyntaxHighlighting } from "./themes";
import { syntaxHighlighting } from "@codemirror/language";
import { typstLanguage } from "./typstLanguage";
import { editorDiagnosticsExtension } from "./diagnostics";

export function getEditorExtensions(): Extension[] {
  return [
    lineNumbers(), highlightActiveLineGutter(), highlightActiveLine(),
    drawSelection(), dropCursor(), history(), unicodeLayoutTheme,
    typstLanguage,
    syntaxHighlighting(typstSyntaxHighlighting),
    editorDiagnosticsExtension,
    keymap.of([...defaultKeymap, ...historyKeymap])
  ];
}
