import { EditorSelection, EditorState, type Extension, type Text, type Transaction } from "@codemirror/state";
import { EditorView, type MouseSelectionStyle, type ViewUpdate } from "@codemirror/view";
import { deleteBracketPair } from "@codemirror/autocomplete";
import { editingPolicyRegistry } from "./editingPolicies/registry";
import { analyzeKhmerWordAt } from "./khmerWordSelection";

function getTemporaryEditingBoundary(state: EditorState): number | null {
  return editingPolicyRegistry.temporaryBoundary(state);
}

export type GraphemeBoundary = {
  from: number;
  to: number;
};

export function graphemeBoundaries(text: string, temporaryBoundary: number | null = null): GraphemeBoundary[] {
  return editingPolicyRegistry.boundaries(text, temporaryBoundary);
}

export function previousGraphemeBoundary(
  doc: Text,
  position: number,
  temporaryBoundary: number | null = null,
  selection = false
): number {
  const line = doc.lineAt(Math.max(0, Math.min(position, doc.length)));
  const local = position - line.from;
  const localTemporaryBoundary = temporaryBoundary === null ? null : temporaryBoundary - line.from;
  let previous = 0;
  for (const boundary of graphemeBoundaries(line.text, localTemporaryBoundary)) {
    if (boundary.to >= local) {
      const unicodeBoundary = local <= boundary.from ? previous : boundary.from;
      return line.from + editingPolicyRegistry.movementBoundary(
        line.text,
        local,
        "backward",
        unicodeBoundary,
        selection
      );
    }
    previous = boundary.to;
  }
  return line.from + previous;
}

export function nextGraphemeBoundary(
  doc: Text,
  position: number,
  temporaryBoundary: number | null = null,
  selection = false
): number {
  const line = doc.lineAt(Math.max(0, Math.min(position, doc.length)));
  const local = position - line.from;
  const localTemporaryBoundary = temporaryBoundary === null ? null : temporaryBoundary - line.from;
  for (const boundary of graphemeBoundaries(line.text, localTemporaryBoundary)) {
    if (boundary.from <= local && local < boundary.to) {
      return line.from + editingPolicyRegistry.movementBoundary(
        line.text,
        local,
        "forward",
        boundary.to,
        selection
      );
    }
    if (local < boundary.from) {
      return line.from + editingPolicyRegistry.movementBoundary(
        line.text,
        local,
        "forward",
        boundary.from,
        selection
      );
    }
  }
  return line.to;
}

export function deletePreviousGrapheme(view: EditorView): boolean {
  return deleteByPolicy(view, "backward");
}

export function deletePreviousGraphemeOrPair(view: EditorView): boolean {
  return deleteBracketPair(view) || deletePreviousGrapheme(view);
}

export function deleteNextGrapheme(view: EditorView): boolean {
  return deleteByPolicy(view, "forward");
}

export function movePreviousGrapheme(view: EditorView): boolean {
  return moveByGrapheme(view, "backward", false);
}

export function moveNextGrapheme(view: EditorView): boolean {
  return moveByGrapheme(view, "forward", false);
}

export function selectPreviousGrapheme(view: EditorView): boolean {
  return moveByGrapheme(view, "backward", true);
}

export function selectNextGrapheme(view: EditorView): boolean {
  return moveByGrapheme(view, "forward", true);
}

export function snapPositionToGraphemeBoundary(doc: Text, position: number, temporaryBoundary: number | null = null): number {
  const line = doc.lineAt(Math.max(0, Math.min(position, doc.length)));
  const local = position - line.from;
  const localTemporaryBoundary = temporaryBoundary === null ? null : temporaryBoundary - line.from;
  for (const boundary of graphemeBoundaries(line.text, localTemporaryBoundary)) {
    if (local <= boundary.from) return line.from + boundary.from;
    if (boundary.from < local && local < boundary.to) {
      const midpoint = boundary.from + ((boundary.to - boundary.from) / 2);
      return line.from + (local <= midpoint ? boundary.from : boundary.to);
    }
  }
  return Math.max(line.from, Math.min(position, line.to));
}

export const graphemeSelectionBoundaryFilter: Extension = EditorState.transactionFilter.of((transaction: Transaction) => {
  if (!transaction.selection || transaction.docChanged) return transaction;
  const temporaryBoundary = getTemporaryEditingBoundary(transaction.startState);
  const selectionKeepsTemporaryBoundary = temporaryBoundary !== null
    && transaction.selection.main.empty
    && transaction.selection.main.head === temporaryBoundary;
  const snapped = snapSelectionToGraphemeBoundaries(
    transaction.newDoc,
    transaction.selection,
    selectionKeepsTemporaryBoundary ? temporaryBoundary : null,
    transaction.isUserEvent("select.pointer")
  );
  if (snapped.eq(transaction.selection)) return transaction;
  return {
    selection: snapped,
    scrollIntoView: transaction.scrollIntoView
  };
});

/**
 * Resolves pointer placement from the rendered edges of shaped Khmer
 * graphemes. Browsers may report the same source offset for clicks at both
 * visual edges of a Khmer cluster, so the transaction's offset and association
 * are not always sufficient on their own.
 */
export type GraphemePointerDebugEvent = {
  mouse: { x: number; y: number };
  resolved: { row: number; utf16Column: number; graphemeColumn: number; position: number; assoc: -1 | 1 };
  visualLine: { from: number; to: number; startX: number | null; endX: number | null };
  candidates: Array<{ from: number; to: number; startX: number; endX: number }>;
  caret: { row: number; utf16Column: number; graphemeColumn: number; position: number };
  reason: "visual-line-trailing" | "visual-grapheme-start" | "visual-grapheme-end" | "codemirror-fallback";
};

export function graphemePointerSelection(
  onDebug?: (event: GraphemePointerDebugEvent) => void,
  wordAt?: (position: number) => { from: number; to: number } | null,
): Extension {
  return EditorView.mouseSelectionStyle.of((view, event) => {
  if (event.button !== 0 || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) {
    return null;
  }

   if (event.detail === 2) return khmerDoubleClickSelection(view, event, wordAt);
  if (event.detail !== 1) return null;

  const initial = pointerSelectionAtCoordinates(view, event, onDebug);
  if (!initial) return null;
  let start: { pos: number; assoc: -1 | 1 } = initial;

  const style: MouseSelectionStyle = {
    get(currentEvent) {
      const current = pointerSelectionAtCoordinates(view, currentEvent, onDebug) ?? start;
      return start.pos === current.pos
        ? EditorSelection.create([EditorSelection.cursor(current.pos, current.assoc)])
        : EditorSelection.create([EditorSelection.range(start.pos, current.pos, current.assoc)]);
    },
    update(update: ViewUpdate) {
      if (update.docChanged) start = { ...start, pos: update.changes.mapPos(start.pos) };
    }
  };
  return style;
  });
}

function khmerDoubleClickSelection(
  view: EditorView,
  event: MouseEvent,
  wordAt?: (position: number) => { from: number; to: number } | null,
): MouseSelectionStyle | null {
  const rangeAt = (pointer: Pick<MouseEvent, "clientX" | "clientY">) => {
    const cluster = khmerGraphemeRangeAtCoordinates(view, pointer);
    if (!cluster) return null;
    const line = view.state.doc.lineAt(cluster.from);
    const wordSpan = wordAt?.(cluster.from);
    const localSpan = wordSpan && wordSpan.from >= line.from && wordSpan.to <= line.to
      ? { from: wordSpan.from - line.from, to: wordSpan.to - line.from }
      : null;
    const word = khmerWordBoundaryAtOffset(line.text, cluster.from - line.from, 1, localSpan);
    return word ? { from: line.from + word.from, to: line.from + word.to } : cluster;
  };
  const initial = rangeAt(event);
  if (!initial) return null;
  let start = initial;
  const pending = !wordAt?.(initial.from);

  if (pending) {
    const doc = view.state.doc;
    const line = doc.lineAt(initial.from);
    void analyzeKhmerWordAt(line.text, initial.from - line.from, "typstSource").then(word => {
      const selection = view.state.selection.main;
      if (!word || view.state.doc !== doc || !selection.empty || selection.head !== initial.from) return;
      const from = line.from + word.from;
      const to = line.from + word.to;
      if (from <= initial.from && initial.to <= to) {
        view.dispatch({ selection: EditorSelection.range(from, to), userEvent: "select.pointer" });
      }
    });
  }

  return {
    get(currentEvent) {
      const current = rangeAt(currentEvent) ?? start;
      // A provisional nonempty selection makes the search-match overlay flash
      // over one grapheme before the provider returns the real word boundary.
      if (pending && current.from === start.from && current.to === start.to) {
        return EditorSelection.create([EditorSelection.cursor(start.from)]);
      }
      const range = current.from < start.from
        ? EditorSelection.range(start.to, current.from)
        : EditorSelection.range(start.from, current.to);
      return EditorSelection.create([range]);
    },
    update(update: ViewUpdate) {
      if (!update.docChanged) return;
      start = {
        from: update.changes.mapPos(start.from, 1),
        to: update.changes.mapPos(start.to, -1),
      };
    },
  };
}

/** Use a provider word/diagnostic span without ever splitting a Khmer cluster. */
export function khmerWordBoundaryAtOffset(
  text: string,
  offset: number,
  association = 0,
  span: GraphemeBoundary | null = null,
): GraphemeBoundary | null {
  const cluster = khmerGraphemeBoundaryAtOffset(text, offset, association);
  if (!cluster) return null;
  if (span && span.from <= cluster.from && span.to >= cluster.to
    && span.from < span.to && span.to <= text.length
    && /[\u1780-\u17ff]/u.test(text.slice(span.from, span.to))) return span;
  return cluster;
}

function khmerGraphemeRangeAtCoordinates(
  view: EditorView,
  event: Pick<MouseEvent, "clientX" | "clientY">,
): GraphemeBoundary | null {
  const resolved = view.posAndSideAtCoords({ x: event.clientX, y: event.clientY });
  if (!resolved) return null;
  const line = view.state.doc.lineAt(resolved.pos);
  const local = resolved.pos - line.from;
  const candidates: Array<GraphemeBoundary & { distance: number }> = [];

  for (const boundary of graphemeBoundaries(line.text)) {
    const cluster = line.text.slice(boundary.from, boundary.to);
    if (!/[\u1780-\u17ff]/u.test(cluster)) continue;
    const from = line.from + boundary.from;
    const to = line.from + boundary.to;
    const startCoordinates = view.coordsAtPos(from, 1);
    const endCoordinates = view.coordsAtPos(to, -1);
    if (!startCoordinates || !endCoordinates) continue;
    const left = Math.min(startCoordinates.left, endCoordinates.left);
    const right = Math.max(startCoordinates.left, endCoordinates.left);
    const top = Math.min(startCoordinates.top, endCoordinates.top);
    const bottom = Math.max(startCoordinates.bottom, endCoordinates.bottom);
    if (event.clientX < left - 2 || event.clientX > right + 2
      || event.clientY < top - 2 || event.clientY > bottom + 2) continue;
    candidates.push({
      from,
      to,
      distance: Math.abs(event.clientX - (left + right) / 2),
    });
  }

  const visual = candidates.sort((left, right) => left.distance - right.distance)[0];
  if (visual) return { from: visual.from, to: visual.to };
  const fallback = khmerGraphemeBoundaryAtOffset(line.text, local, resolved.assoc);
  return fallback ? { from: line.from + fallback.from, to: line.from + fallback.to } : null;
}

export function khmerGraphemeBoundaryAtOffset(
  text: string,
  offset: number,
  association = 0,
): GraphemeBoundary | null {
  const boundaries = graphemeBoundaries(text)
    .filter(boundary => /[\u1780-\u17ff]/u.test(text.slice(boundary.from, boundary.to)));
  const clamped = Math.max(0, Math.min(offset, text.length));
  const containing = boundaries.find(boundary => boundary.from < clamped && clamped < boundary.to);
  if (containing) return containing;
  if (association < 0) {
    return lastBoundaryEndingAt(boundaries, clamped);
  }
  if (association > 0) {
    return boundaries.find(boundary => boundary.from === clamped) ?? null;
  }
  return boundaries.find(boundary => boundary.from === clamped)
    ?? lastBoundaryEndingAt(boundaries, clamped)
    ?? null;
}

function lastBoundaryEndingAt(
  boundaries: readonly GraphemeBoundary[],
  position: number,
): GraphemeBoundary | null {
  for (let index = boundaries.length - 1; index >= 0; index -= 1) {
    if (boundaries[index].to === position) return boundaries[index];
  }
  return null;
}

function pointerSelectionAtCoordinates(
  view: EditorView,
  event: MouseEvent,
  onDebug?: (event: GraphemePointerDebugEvent) => void
): { pos: number; assoc: -1 | 1 } | null {
  const resolved = view.posAndSideAtCoords({ x: event.clientX, y: event.clientY });
  if (!resolved) return null;
  const line = view.state.doc.lineAt(resolved.pos);
  const local = resolved.pos - line.from;
  const temporaryBoundary = getTemporaryEditingBoundary(view.state);
  const localTemporaryBoundary = temporaryBoundary === null ? null : temporaryBoundary - line.from;
  const boundaries = graphemeBoundaries(line.text, localTemporaryBoundary);
  const cursor = EditorSelection.cursor(resolved.pos, resolved.assoc);
  const visualStart = view.moveToLineBoundary(cursor, false, true);
  const visualEnd = view.moveToLineBoundary(cursor, true, true);
  const visualStartCoords = view.coordsAtPos(visualStart.head, visualStart.assoc || 1);
  const visualEndCoords = view.coordsAtPos(visualEnd.head, visualEnd.assoc || -1);
  const candidates: GraphemePointerDebugEvent["candidates"] = [];

  const finish = (
    pos: number,
    assoc: -1 | 1,
    reason: GraphemePointerDebugEvent["reason"]
  ): { pos: number; assoc: -1 | 1 } => {
    if (onDebug) {
      const caretLine = view.state.doc.lineAt(pos);
      onDebug({
        mouse: { x: roundPointerMetric(event.clientX), y: roundPointerMetric(event.clientY) },
        resolved: {
          row: line.number,
          utf16Column: local + 1,
          graphemeColumn: graphemeColumnAt(line.text, local),
          position: resolved.pos,
          assoc: resolved.assoc
        },
        visualLine: {
          from: visualStart.head,
          to: visualEnd.head,
          startX: visualStartCoords ? roundPointerMetric(visualStartCoords.left) : null,
          endX: visualEndCoords ? roundPointerMetric(visualEndCoords.left) : null
        },
        candidates,
        caret: {
          row: caretLine.number,
          utf16Column: pos - caretLine.from + 1,
          graphemeColumn: graphemeColumnAt(caretLine.text, pos - caretLine.from),
          position: pos
        },
        reason
      });
    }
    return { pos, assoc };
  };

  // Chromium can resolve the empty area after a Khmer run to the source
  // boundary before its final shaped cluster. Compare the pointer with the
  // actual visual-line edges and honor a click beyond the trailing edge. Use
  // CodeMirror's visual boundary operation so wrapped lines remain local to
  // the displayed row rather than jumping to the logical line end.
  if (/[\u1780-\u17ff]/u.test(line.text)) {
    if (visualStartCoords && visualEndCoords) {
      const endIsRight = visualEndCoords.left >= visualStartCoords.left;
      const beyondTrailingEdge = endIsRight
        ? event.clientX > visualEndCoords.left + 2
        : event.clientX < visualEndCoords.left - 2;
      if (beyondTrailingEdge) {
        const localVisualEnd = visualEnd.head - line.from;
        // CodeMirror can place the visual line edge inside a shaped Khmer
        // grapheme. Advance to the source-safe end so the transaction filter
        // cannot snap the trailing-area click back to its start.
        const safeVisualEnd = line.from + completeTrailingGraphemeBoundary(
          line.text,
          localVisualEnd,
          localTemporaryBoundary
        );
        return finish(
          safeVisualEnd,
          visualEnd.assoc < 0 ? -1 : 1,
          "visual-line-trailing"
        );
      }
    }
  }

  let best: {
    pos: number;
    distance: number;
    reason: "visual-grapheme-start" | "visual-grapheme-end";
  } | null = null;
  for (const boundary of boundaries) {
    if (local < boundary.from || local > boundary.to) continue;
    const cluster = line.text.slice(boundary.from, boundary.to);
    if (boundary.to - boundary.from < 2 || !/[\u1780-\u17ff]/u.test(cluster)) continue;

    const absoluteFrom = line.from + boundary.from;
    const absoluteTo = line.from + boundary.to;
    const startCoords = view.coordsAtPos(absoluteFrom, 1);
    const endCoords = view.coordsAtPos(absoluteTo, -1);
    if (!startCoords || !endCoords) continue;
    candidates.push({
      from: absoluteFrom,
      to: absoluteTo,
      startX: roundPointerMetric(startCoords.left),
      endX: roundPointerMetric(endCoords.left)
    });

    const left = Math.min(startCoords.left, endCoords.left);
    const right = Math.max(startCoords.left, endCoords.left);
    // Only reinterpret a source-boundary result when the pointer is actually
    // over the rendered cluster. This prevents nearby whitespace and the true
    // beginning of a line from being pulled into the first Khmer grapheme.
    if (event.clientX < left - 2 || event.clientX > right + 2) continue;

    const startDistance = Math.abs(event.clientX - startCoords.left);
    const endDistance = Math.abs(event.clientX - endCoords.left);
    const candidate = startDistance <= endDistance
      ? { pos: absoluteFrom, distance: startDistance, reason: "visual-grapheme-start" as const }
      : { pos: absoluteTo, distance: endDistance, reason: "visual-grapheme-end" as const };
    if (!best || candidate.distance < best.distance) best = candidate;
  }

  return best
    ? finish(best.pos, resolved.assoc, best.reason)
    : finish(resolved.pos, resolved.assoc, "codemirror-fallback");
}

export function completeTrailingGraphemeBoundary(
  text: string,
  position: number,
  temporaryBoundary: number | null = null
): number {
  const clamped = Math.max(0, Math.min(position, text.length));
  for (const boundary of graphemeBoundaries(text, temporaryBoundary)) {
    if (boundary.from < clamped && clamped < boundary.to) return boundary.to;
  }
  return clamped;
}

function graphemeColumnAt(text: string, offset: number): number {
  const clamped = Math.max(0, Math.min(offset, text.length));
  return graphemeBoundaries(text).filter(boundary => boundary.to <= clamped).length + 1;
}

function roundPointerMetric(value: number): number {
  return Math.round(value * 10) / 10;
}

export function snapSelectionToGraphemeBoundaries(
  doc: Text,
  selection: EditorSelection,
  temporaryBoundary: number | null = null,
  pointerSelection = false
): EditorSelection {
  const ranges = selection.ranges.map(range => {
    if (!range.empty) {
      const forward = range.anchor < range.head;
      const anchor = snapSelectionEndpoint(
        doc,
        range.anchor,
        forward ? "backward" : "forward",
        temporaryBoundary
      );
      const head = snapSelectionEndpoint(
        doc,
        range.head,
        forward ? "forward" : "backward",
        temporaryBoundary
      );
      return anchor === head
        ? EditorSelection.cursor(anchor, range.assoc, range.bidiLevel ?? undefined, range.goalColumn)
        : EditorSelection.range(anchor, head, range.goalColumn, range.bidiLevel ?? undefined, range.assoc);
    }
    const anchor = pointerSelection
      ? snapPointerPositionToGraphemeBoundary(doc, range.anchor, range.assoc, temporaryBoundary)
      : snapPositionToGraphemeBoundary(doc, range.anchor, temporaryBoundary);
    const head = pointerSelection
      ? snapPointerPositionToGraphemeBoundary(doc, range.head, range.assoc, temporaryBoundary)
      : snapPositionToGraphemeBoundary(doc, range.head, temporaryBoundary);
    return anchor === head
      ? EditorSelection.cursor(anchor, range.assoc, range.bidiLevel ?? undefined, range.goalColumn)
      : EditorSelection.range(anchor, head, range.goalColumn, range.bidiLevel ?? undefined, range.assoc);
  });
  return EditorSelection.create(ranges, selection.mainIndex);
}

function snapPointerPositionToGraphemeBoundary(
  doc: Text,
  position: number,
  association: number,
  temporaryBoundary: number | null = null
): number {
  const line = doc.lineAt(Math.max(0, Math.min(position, doc.length)));
  const local = position - line.from;
  const localTemporaryBoundary = temporaryBoundary === null ? null : temporaryBoundary - line.from;
  for (const boundary of graphemeBoundaries(line.text, localTemporaryBoundary)) {
    if (boundary.from < local && local < boundary.to) {
      // CodeMirror resolves pointer coordinates to both a document offset and
      // an association describing which visual side of that offset was
      // clicked. Khmer shaping can map clicks near either edge of a cluster to
      // the same internal UTF-16 offset, so the offset midpoint alone is not a
      // reliable indication of the intended caret side.
      if (association < 0) return line.from + boundary.from;
      if (association > 0) return line.from + boundary.to;

      // Some browsers do not provide a side association. Preserve the
      // line-leading COENG safeguard in that case so words such as ឲ្យ and ឱ្យ
      // can still place the caret at the true start of the line.
      if (boundary.from === 0
        && line.text.slice(boundary.from, boundary.to).includes("\u17D2")) {
        return line.from;
      }
    }
  }
  return snapPositionToGraphemeBoundary(doc, position, temporaryBoundary);
}

function snapSelectionEndpoint(
  doc: Text,
  position: number,
  direction: "backward" | "forward",
  temporaryBoundary: number | null
): number {
  const clamped = Math.max(0, Math.min(position, doc.length));
  const line = doc.lineAt(clamped);
  const local = clamped - line.from;
  const localTemporaryBoundary = temporaryBoundary === null ? null : temporaryBoundary - line.from;
  for (const boundary of graphemeBoundaries(line.text, localTemporaryBoundary)) {
    if (local === boundary.from || local === boundary.to) return clamped;
    if (boundary.from < local && local < boundary.to) {
      return line.from + (direction === "backward" ? boundary.from : boundary.to);
    }
  }
  return clamped;
}

function deleteByPolicy(view: EditorView, direction: "backward" | "forward"): boolean {
  const selection = view.state.selection;
  const temporaryBoundary = getTemporaryEditingBoundary(view.state);
  const ranges = deletionRangesForSelection(view.state.doc, selection, direction, temporaryBoundary);
  if (!ranges) return false;
  view.dispatch({
    changes: ranges,
    scrollIntoView: true,
    userEvent: direction === "backward" ? "delete.backward" : "delete.forward"
  });
  return true;
}

export function deletionRangesForSelection(
  doc: Text,
  selection: EditorSelection,
  direction: "backward" | "forward",
  temporaryBoundary: number | null = null
): GraphemeBoundary[] | null {
  if (selection.ranges.some(range => !range.empty)) return null;
  const ranges: GraphemeBoundary[] = [];
  for (const selectionRange of selection.ranges) {
    const position = snapPositionToGraphemeBoundary(doc, selectionRange.head, temporaryBoundary);
    const deletion = codePointDeletionRange(doc, position, direction, temporaryBoundary);
    if (!deletion) return null;
    ranges.push(deletion);
  }
  ranges.sort((left, right) => left.from - right.from || left.to - right.to);
  const merged: GraphemeBoundary[] = [];
  for (const range of ranges) {
    const previous = merged[merged.length - 1];
    if (previous && range.from <= previous.to) previous.to = Math.max(previous.to, range.to);
    else merged.push({ ...range });
  }
  return merged;
}

export function codePointDeletionRange(
  doc: Text,
  position: number,
  direction: "backward" | "forward",
  temporaryBoundary: number | null = null
): GraphemeBoundary | null {
  const line = doc.lineAt(Math.max(0, Math.min(position, doc.length)));
  const local = position - line.from;
  if (direction === "backward") {
    const range = editingPolicyRegistry.backwardDeletionRange(line.text, local);
    return range ? { from: line.from + range.from, to: line.from + range.to } : null;
  }
  if (local >= line.length) return null;
  const localTemporaryBoundary = temporaryBoundary === null ? null : temporaryBoundary - line.from;
  const range = editingPolicyRegistry.forwardDeletionRange(line.text, local, localTemporaryBoundary);
  return range ? { from: line.from + range.from, to: line.from + range.to } : null;
}

function moveByGrapheme(view: EditorView, direction: "backward" | "forward", extend: boolean): boolean {
  const selection = view.state.selection;
  const nextSelection = moveSelectionByGrapheme(
    view.state.doc,
    selection,
    direction,
    extend,
    getTemporaryEditingBoundary(view.state)
  );
  if (nextSelection.eq(selection)) return false;
  view.dispatch({
    selection: nextSelection,
    scrollIntoView: true,
    userEvent: "select"
  });
  return true;
}

export function moveSelectionByGrapheme(
  doc: Text,
  selection: EditorSelection,
  direction: "backward" | "forward",
  extend: boolean,
  temporaryBoundary: number | null = null
): EditorSelection {
  const ranges = selection.ranges.map(range => {
    const head = snapPositionToGraphemeBoundary(doc, range.head, temporaryBoundary);
    const target = direction === "backward"
      ? previousGraphemeBoundary(doc, head, temporaryBoundary, extend)
      : nextGraphemeBoundary(doc, head, temporaryBoundary, extend);
    if (extend) {
      const anchor = snapPositionToGraphemeBoundary(doc, range.anchor, temporaryBoundary);
      return anchor === target ? EditorSelection.cursor(target) : EditorSelection.range(anchor, target);
    }
    return EditorSelection.cursor(target);
  });
  return EditorSelection.create(ranges, selection.mainIndex);
}
