import { RangeSet, RangeSetBuilder, StateField } from "@codemirror/state";
import type { Extension, Text } from "@codemirror/state";
import { GutterMarker, gutter } from "@codemirror/view";
import { createAppIcon } from "../ui/icons";

/** `//@table:<id>` on its own line links a document location to a tool table. */
const DIRECTIVE_PATTERN = /^\s*\/\/@table:([A-Za-z0-9_]+)\s*$/u;

class TableDirectiveMarker extends GutterMarker {
  constructor(readonly tableId: string) {
    super();
  }

  eq(other: GutterMarker): boolean {
    return other instanceof TableDirectiveMarker && other.tableId === this.tableId;
  }

  toDOM(): HTMLElement {
    const marker = document.createElement("span");
    marker.className = "cm-table-directive-marker";
    marker.appendChild(createAppIcon("info", { size: 15 }));
    marker.title = `Open table "${this.tableId}" in the Table tool`;
    marker.setAttribute("aria-label", `Open table ${this.tableId} in the Table tool`);
    marker.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      window.dispatchEvent(new CustomEvent("typsastra-open-table-tool", {
        detail: { tableId: this.tableId },
      }));
    });
    return marker;
  }
}

class TableDirectiveSpacerMarker extends GutterMarker {
  toDOM(): HTMLElement {
    const spacer = document.createElement("span");
    spacer.className = "cm-table-directive-marker-spacer";
    spacer.setAttribute("aria-hidden", "true");
    return spacer;
  }
}

function buildMarkers(doc: Text): RangeSet<GutterMarker> {
  if (!doc.toString().includes("//@table:")) return RangeSet.empty;
  const builder = new RangeSetBuilder<GutterMarker>();
  for (let number = 1; number <= doc.lines; number += 1) {
    const line = doc.line(number);
    const match = DIRECTIVE_PATTERN.exec(line.text);
    if (!match) continue;
    builder.add(line.from, line.from, new TableDirectiveMarker(match[1]));
  }
  return builder.finish();
}

const tableDirectiveField = StateField.define<RangeSet<GutterMarker>>({
  create(state) {
    return buildMarkers(state.doc);
  },
  update(value, transaction) {
    if (!transaction.docChanged) return value;
    return buildMarkers(transaction.state.doc);
  },
});

/** Gutter info icon for `//@table:` directives; click opens the Table tool. */
export const tableDirectiveGutterExtension: Extension = [
  tableDirectiveField,
  gutter({
    class: "cm-table-directive-gutter",
    markers(view) {
      return view.state.field(tableDirectiveField);
    },
    initialSpacer: () => new TableDirectiveSpacerMarker(),
  }),
];
