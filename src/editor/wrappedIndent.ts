import { countColumn, RangeSetBuilder } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";

export function wrappedLineIndentColumns(text: string, tabSize: number): number {
  const leading = /^[\t ]*/u.exec(text)?.[0] ?? "";
  if (!leading || leading.length === text.length) return 0;
  return countColumn(leading, tabSize, leading.length);
}

function wrappedIndentDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const visited = new Set<number>();
  for (const range of view.visibleRanges) {
    for (let line = view.state.doc.lineAt(range.from); line.from <= range.to; line = view.state.doc.line(line.number + 1)) {
      if (!visited.has(line.from)) {
        visited.add(line.from);
        const columns = wrappedLineIndentColumns(line.text, view.state.tabSize);
        if (columns > 0) {
          builder.add(line.from, line.from, Decoration.line({
            class: "cm-wrapped-indent",
            attributes: { style: `--cm-wrapped-indent: ${columns}ch` },
          }));
        }
      }
      if (line.to >= range.to || line.number >= view.state.doc.lines) break;
    }
  }
  return builder.finish();
}

export const wrappedLineIndentation = ViewPlugin.fromClass(class {
  decorations: DecorationSet;

  constructor(view: EditorView) {
    this.decorations = wrappedIndentDecorations(view);
  }

  update(update: ViewUpdate): void {
    if (update.docChanged || update.viewportChanged || update.startState.tabSize !== update.state.tabSize) {
      this.decorations = wrappedIndentDecorations(update.view);
    }
  }
}, {
  decorations: value => value.decorations,
});
