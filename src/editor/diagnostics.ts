import { RangeSetBuilder, StateEffect, StateField } from "@codemirror/state";
import type { Extension } from "@codemirror/state";
import { Decoration, EditorView } from "@codemirror/view";
import type { DecorationSet } from "@codemirror/view";

export type EditorDiagnosticSeverity = "error" | "warning" | "info" | "hint";

export type EditorDiagnostic = {
  from: number;
  to: number;
  severity: EditorDiagnosticSeverity;
  message: string;
};

export const setEditorDiagnosticsEffect = StateEffect.define<EditorDiagnostic[]>({
  map(diagnostics, mapping) {
    return diagnostics
      .map((diagnostic) => ({
        ...diagnostic,
        from: mapping.mapPos(diagnostic.from),
        to: mapping.mapPos(diagnostic.to)
      }))
      .filter((diagnostic) => diagnostic.to >= diagnostic.from);
  }
});

const diagnosticField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },

  update(value, transaction) {
    let decorations = value.map(transaction.changes);

    for (const effect of transaction.effects) {
      if (effect.is(setEditorDiagnosticsEffect)) {
        decorations = buildDiagnosticDecorations(effect.value, transaction.state.doc.length);
      }
    }

    return decorations;
  },

  provide(field) {
    return EditorView.decorations.from(field);
  }
});

export const editorDiagnosticsExtension: Extension = diagnosticField;

function buildDiagnosticDecorations(diagnostics: EditorDiagnostic[], docLength: number): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const sorted = [...diagnostics].sort((left, right) => left.from - right.from || left.to - right.to);

  for (const diagnostic of sorted) {
    const from = Math.max(0, Math.min(diagnostic.from, docLength));
    const to = Math.max(from, Math.min(diagnostic.to, docLength));
    const markTo = to > from ? to : Math.min(from + 1, docLength);
    if (markTo <= from) continue;

    builder.add(
      from,
      markTo,
      Decoration.mark({
        class: `cm-diagnostic cm-diagnostic-${diagnostic.severity}`,
        attributes: { title: diagnostic.message }
      })
    );
  }

  return builder.finish();
}
