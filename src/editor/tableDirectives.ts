import { RangeSet, RangeSetBuilder, StateEffect } from "@codemirror/state";
import type { Extension, Text } from "@codemirror/state";
import { GutterMarker, gutter } from "@codemirror/view";
import type { EditorView } from "@codemirror/view";
import { createAppIcon } from "../ui/icons";
import { isStandaloneDocument } from "./standaloneDocument";

/** `//@table:<id>` on its own line links a document location to a tool table. */
const DIRECTIVE_PATTERN = /^\s*\/\/@table:([A-Za-z0-9_]+)\s*$/u;

/**
 * Table ids that currently exist in the Table tool. A directive whose id is
 * absent is an orphan: the table was deleted, so the gutter shows a warning and
 * offers to recreate the table or remove the directive.
 */
let knownTableIds: ReadonlySet<string> = new Set();
/** False until the Table tool has published its ids, so we never warn early. */
let tableIdsKnown = false;
let idsVersion = 0;

/** Forces a view update so the gutter rebuilds against the current ids. */
const refreshTableDirectivesEffect = StateEffect.define<number>();

/** Publishes the Table tool's table ids so orphaned directives can be flagged. */
export function updateTableDirectiveIds(
  view: EditorView | undefined,
  ids: readonly string[],
): void {
  knownTableIds = new Set(ids);
  tableIdsKnown = true;
  idsVersion += 1;
  view?.dispatch({ effects: refreshTableDirectivesEffect.of(idsVersion) });
}

class TableDirectiveMarker extends GutterMarker {
  constructor(readonly tableId: string, readonly missing: boolean) {
    super();
  }

  eq(other: GutterMarker): boolean {
    return other instanceof TableDirectiveMarker
      && other.tableId === this.tableId
      && other.missing === this.missing;
  }

  toDOM(): HTMLElement {
    const marker = document.createElement("span");
    marker.className = "cm-table-directive-marker";
    if (this.missing) {
      marker.classList.add("missing");
      marker.appendChild(createAppIcon("triangleAlert", { size: 17 }));
      marker.title =
        `Table "${this.tableId}" no longer exists in the Table tool.\n\n`
        + "Click to recreate the table or delete this directive.";
      marker.setAttribute(
        "aria-label",
        `Table ${this.tableId} is missing. Click for recreate and delete options.`,
      );
      marker.addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();
        const mouse = event as MouseEvent;
        window.dispatchEvent(new CustomEvent("typsastra-table-directive-action", {
          detail: { tableId: this.tableId, x: mouse.clientX, y: mouse.clientY },
        }));
      });
      return marker;
    }
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
    const missing = tableIdsKnown && !knownTableIds.has(match[1]);
    builder.add(line.from, line.from, new TableDirectiveMarker(match[1], missing));
  }
  return builder.finish();
}

// Markers are keyed by document identity and ids version, so tab states that
// reuse an older doc string still re-evaluate when either changes.
let cachedDoc: Text | null = null;
let cachedVersion = -1;
let cachedMarkers: RangeSet<GutterMarker> = RangeSet.empty;

function markersFor(doc: Text): RangeSet<GutterMarker> {
  if (doc === cachedDoc && idsVersion === cachedVersion) return cachedMarkers;
  cachedMarkers = buildMarkers(doc);
  cachedDoc = doc;
  cachedVersion = idsVersion;
  return cachedMarkers;
}

/**
 * Gutter marker for `//@table:` directives: an info icon that opens the Table
 * tool for linked tables, or a warning with recreate/delete options when the
 * table no longer exists.
 */
export const tableDirectiveGutterExtension: Extension = gutter({
  class: "cm-table-directive-gutter",
  markers(view) {
    // A standalone document cannot open the Table tool, so no link marker.
    if (isStandaloneDocument(view.state)) return RangeSet.empty;
    return markersFor(view.state.doc);
  },
  initialSpacer: () => new TableDirectiveSpacerMarker(),
});
