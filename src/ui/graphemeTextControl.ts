import { editingPolicyRegistry } from "../editor/editingPolicies/registry";
import { khmerWordBoundaryAtOffset } from "../editor/grapheme";
import { analyzeKhmerWordAt } from "../editor/khmerWordSelection";

export type GraphemeTextControl = HTMLInputElement | HTMLTextAreaElement;

const installedControls = new WeakSet<object>();

/** Hit-test rendered text, not selectionStart (which WebKit may reset to zero). */
export function textControlOffsetAtPoint(control: GraphemeTextControl, x: number, y: number): number | null {
  const doc = control.ownerDocument;
  if (!doc?.body || (!doc.caretPositionFromPoint && !doc.caretRangeFromPoint)) return null;
  const rect = control.getBoundingClientRect();
  const computed = getComputedStyle(control);
  const mirror = doc.createElement("div");
  Object.assign(mirror.style, {
    position: "fixed", left: `${rect.left}px`, top: `${rect.top}px`,
    width: `${rect.width}px`, height: `${rect.height}px`,
    boxSizing: "border-box", padding: computed.padding, border: computed.border,
    font: computed.font, letterSpacing: computed.letterSpacing,
    lineHeight: computed.lineHeight, textAlign: computed.textAlign,
    direction: computed.direction, tabSize: computed.tabSize,
    whiteSpace: control instanceof HTMLTextAreaElement ? "pre-wrap" : "pre",
    overflowWrap: "break-word", overflow: "hidden", opacity: "0",
    zIndex: "2147483647", pointerEvents: "auto",
  });
  mirror.textContent = control.value || " ";
  doc.body.appendChild(mirror);
  try {
    mirror.scrollLeft = control.scrollLeft;
    mirror.scrollTop = control.scrollTop;
    const caret = doc.caretPositionFromPoint?.(x, y);
    const legacyCaret = caret ? null : doc.caretRangeFromPoint?.(x, y);
    const node = caret?.offsetNode ?? legacyCaret?.startContainer;
    const offset = caret?.offset ?? legacyCaret?.startOffset;
    if (!node || offset === undefined || !mirror.contains(node)) return null;
    const before = doc.createRange();
    before.selectNodeContents(mirror);
    before.setEnd(node, offset);
    return Math.min(before.toString().length, control.value.length);
  } finally {
    mirror.remove();
  }
}

export function previousTextControlBoundary(text: string, offset: number, selection = false): number {
  const clamped = clampOffset(text, offset);
  let previous = 0;
  for (const boundary of editingPolicyRegistry.boundaries(text)) {
    if (boundary.to >= clamped) {
      const unicodeBoundary = clamped <= boundary.from ? previous : boundary.from;
      return editingPolicyRegistry.movementBoundary(
        text,
        clamped,
        "backward",
        unicodeBoundary,
        selection,
      );
    }
    previous = boundary.to;
  }
  return previous;
}

export function nextTextControlBoundary(text: string, offset: number, selection = false): number {
  const clamped = clampOffset(text, offset);
  for (const boundary of editingPolicyRegistry.boundaries(text)) {
    if (boundary.from <= clamped && clamped < boundary.to) {
      return editingPolicyRegistry.movementBoundary(
        text,
        clamped,
        "forward",
        boundary.to,
        selection,
      );
    }
    if (clamped < boundary.from) {
      return editingPolicyRegistry.movementBoundary(
        text,
        clamped,
        "forward",
        boundary.from,
        selection,
      );
    }
  }
  return text.length;
}

export function snapTextControlOffset(
  text: string,
  offset: number,
  bias: "nearest" | "backward" | "forward" = "nearest",
): number {
  const clamped = clampOffset(text, offset);
  for (const boundary of editingPolicyRegistry.boundaries(text)) {
    if (clamped <= boundary.from) return boundary.from;
    if (clamped < boundary.to) {
      if (bias === "backward") return boundary.from;
      if (bias === "forward") return boundary.to;
      return clamped - boundary.from <= boundary.to - clamped ? boundary.from : boundary.to;
    }
  }
  return text.length;
}

/** Apply Typsastra's script-aware grapheme policy to a native text control. */
export function installGraphemeTextControl(
  control: GraphemeTextControl,
  offsetAtPoint = textControlOffsetAtPoint,
): void {
  if (installedControls.has(control)) return;
  installedControls.add(control);

  let pointerActive = false;
  let compositionActive = false;
  let normalizing = false;
  let wordRequest = 0;
  let pendingDoubleClick: { text: string; from: number; to: number } | null = null;

  const interceptSecondClick = (event: MouseEvent) => {
    if (event.detail !== 2 || event.button !== 0 || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;
    const position = offsetAtPoint(control, event.clientX, event.clientY);
    const cluster = position === null ? null : khmerWordBoundaryAtOffset(control.value, position, 1);
    if (!cluster) return;
    pendingDoubleClick = { text: control.value, ...cluster };
    // WebKit can select the entire Khmer run on mousedown before dblclick.
    // Cancel the native second press itself, not only the later dblclick event.
    event.preventDefault();
  };

  const normalizeSelection = () => {
    if (pointerActive || compositionActive || normalizing) return;
    const start = control.selectionStart;
    const end = control.selectionEnd;
    if (start === null || end === null) return;
    const direction = control.selectionDirection ?? "none";
    const snappedStart = snapTextControlOffset(control.value, start, start === end ? "nearest" : "backward");
    const snappedEnd = snapTextControlOffset(control.value, end, start === end ? "nearest" : "forward");
    if (snappedStart === start && snappedEnd === end) return;
    normalizing = true;
    control.setSelectionRange(snappedStart, snappedEnd, direction);
    normalizing = false;
  };

  control.addEventListener("keydown", rawEvent => {
    const event = rawEvent as KeyboardEvent;
    wordRequest++;
    if (event.defaultPrevented || event.isComposing || compositionActive) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      moveSelection(control, event.key === "ArrowLeft" ? "backward" : "forward", event.shiftKey);
      return;
    }
    if (event.key === "Backspace" || event.key === "Delete") {
      event.preventDefault();
      deleteSelection(control, event.key === "Backspace" ? "backward" : "forward");
    }
  });

  control.addEventListener("beforeinput", rawEvent => {
    const event = rawEvent as InputEvent;
    if (compositionActive || event.isComposing || event.defaultPrevented) return;
    if (event.inputType !== "deleteContentBackward" && event.inputType !== "deleteContentForward") return;
    event.preventDefault();
    deleteSelection(control, event.inputType === "deleteContentBackward" ? "backward" : "forward");
  });

  control.addEventListener("pointerdown", rawEvent => {
    const event = rawEvent as PointerEvent;
    if (event.detail === 1) wordRequest++;
    interceptSecondClick(event);
    pointerActive = true;
  }, { capture: true });
  control.addEventListener("mousedown", event => {
    interceptSecondClick(event as MouseEvent);
  }, { capture: true });
  control.addEventListener("click", rawEvent => {
    const event = rawEvent as MouseEvent;
    if (event.detail === 2 && pendingDoubleClick) event.preventDefault();
  });
  control.addEventListener("input", () => { wordRequest++; });
  control.addEventListener("pointerup", () => {
    pointerActive = false;
    normalizeSelection();
  });
  control.addEventListener("pointercancel", () => {
    pointerActive = false;
    normalizeSelection();
  });
  control.addEventListener("dblclick", rawEvent => {
    const event = rawEvent as MouseEvent;
    if (event.button !== 0 || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey
      || compositionActive || control.selectionStart === null) return;
    const text = control.value;
    const position = offsetAtPoint(control, event.clientX, event.clientY);
    const cluster = pendingDoubleClick?.text === text
      ? pendingDoubleClick : position === null ? null : khmerWordBoundaryAtOffset(text, position, 1);
    pendingDoubleClick = null;
    if (!cluster) return;
    event.preventDefault();
    const request = ++wordRequest;
    void analyzeKhmerWordAt(text, cluster.from).then(word => {
      if (request !== wordRequest || !word || control.value !== text) return;
      control.setSelectionRange(word.from, word.to);
    });
  });
  control.addEventListener("lostpointercapture", () => {
    pointerActive = false;
    normalizeSelection();
  });
  control.addEventListener("blur", () => {
    pointerActive = false;
    normalizeSelection();
  });
  control.addEventListener("select", normalizeSelection);
  control.addEventListener("compositionstart", () => {
    compositionActive = true;
  });
  control.addEventListener("compositionend", () => {
    compositionActive = false;
    normalizeSelection();
  });
}

function moveSelection(
  control: GraphemeTextControl,
  direction: "backward" | "forward",
  extend: boolean,
): void {
  const start = control.selectionStart ?? 0;
  const end = control.selectionEnd ?? start;
  const selectionDirection = control.selectionDirection ?? "none";
  if (!extend) {
    const collapsed = start !== end
      ? (direction === "backward" ? start : end)
      : (direction === "backward"
        ? previousTextControlBoundary(control.value, start)
        : nextTextControlBoundary(control.value, end));
    const snapped = snapTextControlOffset(control.value, collapsed, direction);
    control.setSelectionRange(snapped, snapped, "none");
    return;
  }

  const anchor = selectionDirection === "backward" ? end : start;
  const focus = selectionDirection === "backward" ? start : end;
  const nextFocus = direction === "backward"
    ? previousTextControlBoundary(control.value, focus, true)
    : nextTextControlBoundary(control.value, focus, true);
  if (nextFocus < anchor) control.setSelectionRange(nextFocus, anchor, "backward");
  else control.setSelectionRange(anchor, nextFocus, nextFocus === anchor ? "none" : "forward");
}

function deleteSelection(control: GraphemeTextControl, direction: "backward" | "forward"): void {
  const start = control.selectionStart ?? 0;
  const end = control.selectionEnd ?? start;
  let from = start;
  let to = end;
  if (start !== end) {
    from = snapTextControlOffset(control.value, start, "backward");
    to = snapTextControlOffset(control.value, end, "forward");
  } else if (direction === "backward") {
    const range = editingPolicyRegistry.backwardDeletionRange(control.value, start);
    if (!range) return;
    ({ from, to } = range);
  } else {
    const range = editingPolicyRegistry.forwardDeletionRange(control.value, start);
    if (!range) return;
    ({ from, to } = range);
  }
  control.setRangeText("", from, to, "end");
  control.dispatchEvent(new InputEvent("input", {
    bubbles: true,
    inputType: direction === "backward" ? "deleteContentBackward" : "deleteContentForward",
  }));
}

function clampOffset(text: string, offset: number): number {
  return Math.max(0, Math.min(offset, text.length));
}
