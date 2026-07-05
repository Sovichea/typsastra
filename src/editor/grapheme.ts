import { EditorSelection, type Text } from "@codemirror/state";
import type { EditorView, ViewUpdate } from "@codemirror/view";

type SegmentRecord = { segment: string; index: number };
type SegmenterLike = {
  segment(input: string): Iterable<SegmentRecord>;
};

const segmenter: SegmenterLike | null = (() => {
  const ctor = (Intl as unknown as {
    Segmenter?: new (locale: string | undefined, options: { granularity: "grapheme" }) => SegmenterLike;
  }).Segmenter;
  return ctor ? new ctor(undefined, { granularity: "grapheme" }) : null;
})();

export type GraphemeBoundary = {
  from: number;
  to: number;
};

export function graphemeBoundaries(text: string): GraphemeBoundary[] {
  if (!text) return [];
  if (/[\u1780-\u17ff]/u.test(text)) return khmerAwareGraphemeBoundaries(text);
  return unicodeGraphemeBoundaries(text);
}

function unicodeGraphemeBoundaries(text: string): GraphemeBoundary[] {
  if (!segmenter) {
    const boundaries: GraphemeBoundary[] = [];
    let offset = 0;
    for (const char of text) {
      const next = offset + char.length;
      boundaries.push({ from: offset, to: next });
      offset = next;
    }
    return boundaries;
  }

  const starts = [...segmenter.segment(text)].map(segment => segment.index);
  const boundaries: GraphemeBoundary[] = [];
  for (let index = 0; index < starts.length; index += 1) {
    boundaries.push({
      from: starts[index],
      to: starts[index + 1] ?? text.length
    });
  }
  return boundaries;
}

function khmerAwareGraphemeBoundaries(text: string): GraphemeBoundary[] {
  const raw = unicodeGraphemeBoundaries(text);
  const merged: GraphemeBoundary[] = [];
  for (const boundary of raw) {
    const previous = merged[merged.length - 1];
    const segment = text.slice(boundary.from, boundary.to);
    const previousSegment = previous ? text.slice(previous.from, previous.to) : "";
    if (
      previous
      && (
        previousSegment.endsWith("\u17D2")
        || startsWithKhmerDependentMark(segment)
        || containsDanglingKhmerCoeng(previousSegment)
      )
    ) {
      previous.to = boundary.to;
    } else {
      merged.push({ ...boundary });
    }
  }
  return merged;
}

function startsWithKhmerDependentMark(text: string): boolean {
  const first = text.codePointAt(0);
  return first !== undefined && (
    (first >= 0x17B6 && first <= 0x17D3)
    || first === 0x17DD
  );
}

function containsDanglingKhmerCoeng(text: string): boolean {
  const coengIndex = text.lastIndexOf("\u17D2");
  return coengIndex !== -1 && coengIndex >= text.length - 2;
}

export function previousGraphemeBoundary(doc: Text, position: number): number {
  const line = doc.lineAt(Math.max(0, Math.min(position, doc.length)));
  const local = position - line.from;
  let previous = 0;
  for (const boundary of graphemeBoundaries(line.text)) {
    if (boundary.to >= local) {
      return line.from + (local <= boundary.from ? previous : boundary.from);
    }
    previous = boundary.to;
  }
  return line.from + previous;
}

export function nextGraphemeBoundary(doc: Text, position: number): number {
  const line = doc.lineAt(Math.max(0, Math.min(position, doc.length)));
  const local = position - line.from;
  for (const boundary of graphemeBoundaries(line.text)) {
    if (boundary.from <= local && local < boundary.to) return line.from + boundary.to;
    if (local < boundary.from) return line.from + boundary.from;
  }
  return line.to;
}

export function deletePreviousGrapheme(view: EditorView): boolean {
  return deleteByCodePoint(view, "backward");
}

export function deleteNextGrapheme(view: EditorView): boolean {
  return deleteByCodePoint(view, "forward");
}

export function movePreviousGrapheme(view: EditorView): boolean {
  return moveByGrapheme(view, "backward");
}

export function moveNextGrapheme(view: EditorView): boolean {
  return moveByGrapheme(view, "forward");
}

export function snapPositionToGraphemeBoundary(doc: Text, position: number): number {
  const line = doc.lineAt(Math.max(0, Math.min(position, doc.length)));
  const local = position - line.from;
  for (const boundary of graphemeBoundaries(line.text)) {
    if (local <= boundary.from) return line.from + boundary.from;
    if (boundary.from < local && local < boundary.to) {
      const midpoint = boundary.from + ((boundary.to - boundary.from) / 2);
      return line.from + (local < midpoint ? boundary.from : boundary.to);
    }
  }
  return Math.max(line.from, Math.min(position, line.to));
}

export function snapSelectionUpdateToGraphemeBoundaries(update: ViewUpdate): void {
  if (!update.selectionSet || update.docChanged) return;
  const selection = update.state.selection;
  const ranges = selection.ranges.map(range => {
    const anchor = snapPositionToGraphemeBoundary(update.state.doc, range.anchor);
    const head = snapPositionToGraphemeBoundary(update.state.doc, range.head);
    return anchor === head ? EditorSelection.cursor(anchor) : EditorSelection.range(anchor, head);
  });
  const snapped = EditorSelection.create(ranges, selection.mainIndex);
  if (snapped.eq(selection)) return;
  update.view.dispatch({
    selection: snapped,
    scrollIntoView: true,
    userEvent: "select"
  });
}

function deleteByCodePoint(view: EditorView, direction: "backward" | "forward"): boolean {
  const selection = view.state.selection;
  if (!selection.main.empty) return false;
  const position = selection.main.head;
  const range = codePointDeletionRange(view.state.doc, position, direction);
  if (!range) return false;
  view.dispatch({
    changes: range,
    selection: { anchor: range.from },
    scrollIntoView: true,
    userEvent: direction === "backward" ? "delete.backward" : "delete.forward"
  });
  return true;
}

export function codePointDeletionRange(doc: Text, position: number, direction: "backward" | "forward"): GraphemeBoundary | null {
  const line = doc.lineAt(Math.max(0, Math.min(position, doc.length)));
  const local = position - line.from;
  if (direction === "backward") {
    if (local <= 0) return null;
    const from = previousCodePointOffset(line.text, local);
    return { from: line.from + from, to: line.from + local };
  }
  if (local >= line.length) return null;
  const to = nextCodePointOffset(line.text, local);
  return { from: line.from + local, to: line.from + to };
}

function moveByGrapheme(view: EditorView, direction: "backward" | "forward"): boolean {
  const selection = view.state.selection;
  if (!selection.main.empty) return false;
  const position = selection.main.head;
  const target = direction === "backward"
    ? previousGraphemeBoundary(view.state.doc, position)
    : nextGraphemeBoundary(view.state.doc, position);
  if (target === position) return false;
  view.dispatch({
    selection: { anchor: target },
    scrollIntoView: true,
    userEvent: "select"
  });
  return true;
}

function previousCodePointOffset(text: string, offset: number): number {
  const position = Math.max(0, Math.min(offset, text.length));
  if (position > 1 && isLowSurrogate(text.charCodeAt(position - 1)) && isHighSurrogate(text.charCodeAt(position - 2))) {
    return position - 2;
  }
  return Math.max(0, position - 1);
}

function nextCodePointOffset(text: string, offset: number): number {
  const position = Math.max(0, Math.min(offset, text.length));
  if (position + 1 < text.length && isHighSurrogate(text.charCodeAt(position)) && isLowSurrogate(text.charCodeAt(position + 1))) {
    return position + 2;
  }
  return Math.min(text.length, position + 1);
}

function isHighSurrogate(value: number): boolean {
  return value >= 0xD800 && value <= 0xDBFF;
}

function isLowSurrogate(value: number): boolean {
  return value >= 0xDC00 && value <= 0xDFFF;
}
