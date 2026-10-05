import { describe, expect, test } from "bun:test";
import {
  nextTextControlBoundary,
  installGraphemeTextControl,
  previousTextControlBoundary,
  snapTextControlOffset,
} from "../src/ui/graphemeTextControl";

describe("global grapheme text-control policy", () => {
  test("keeps Khmer clusters intact in native text controls", () => {
    const text = "\u1781\u17D2\u1798\u17C2\u179A";

    expect(nextTextControlBoundary(text, 0)).toBe(4);
    expect(nextTextControlBoundary(text, 2)).toBe(4);
    expect(previousTextControlBoundary(text, 4)).toBe(0);
    expect(snapTextControlOffset(text, 2, "backward")).toBe(0);
    expect(snapTextControlOffset(text, 2, "forward")).toBe(4);
  });

  test("never places a native caret inside a surrogate pair or combining sequence", () => {
    expect(snapTextControlOffset("A😀B", 2, "backward")).toBe(1);
    expect(snapTextControlOffset("A😀B", 2, "forward")).toBe(3);

    const decomposed = "Cafe\u0301";
    expect(previousTextControlBoundary(decomposed, decomposed.length)).toBe(3);
    expect(snapTextControlOffset(decomposed, 4, "backward")).toBe(3);
    expect(snapTextControlOffset(decomposed, 4, "forward")).toBe(5);
  });

  test("double-click does not guess a whole Khmer run while provider analysis is pending", () => {
    const control = new EventTarget() as EventTarget & {
      value: string;
      selectionStart: number;
      selectionEnd: number;
      setSelectionRange(from: number, to: number): void;
    };
    control.value = "ខ្មែរ គ";
    control.selectionStart = 0;
    control.selectionEnd = 4;
    control.setSelectionRange = (from, to) => {
      control.selectionStart = from;
      control.selectionEnd = to;
    };
    installGraphemeTextControl(control as unknown as HTMLInputElement, () => 0);
    const down = new Event("pointerdown", { cancelable: true });
    Object.assign(down, { detail: 2, button: 0 });
    control.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    const event = new Event("dblclick", { cancelable: true });
    Object.assign(event, { button: 0, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false });
    control.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    // Provider analysis is asynchronous: do not visibly select a provisional
    // grapheme before applying the completed word span.
    expect([control.selectionStart, control.selectionEnd]).toEqual([0, 4]);
  });

  test("hit-tests the second click instead of trusting WebKit's selectionStart", () => {
    const control = new EventTarget() as EventTarget & {
      value: string;
      selectionStart: number;
      selectionEnd: number;
      setSelectionRange(from: number, to: number): void;
    };
    control.value = "ខ្មែរ ខូចខាត";
    control.selectionStart = 7;
    control.selectionEnd = 7;
    const selections: Array<[number, number]> = [];
    control.setSelectionRange = (from, to) => { selections.push([from, to]); };
    let hits = 0;
    installGraphemeTextControl(control as unknown as HTMLInputElement, () => { hits++; return 7; });
    const click = new Event("click");
    Object.assign(click, { detail: 1, clientX: 60, clientY: 5 });
    control.dispatchEvent(click);
    control.selectionStart = 0;
    const down = new Event("pointerdown", { cancelable: true });
    // WebKit may report detail=0 on pointerdown; mousedown reports click count.
    Object.assign(down, { detail: 0, button: 0, clientX: 60, clientY: 5 });
    control.dispatchEvent(down);
    const mouseDown = new Event("mousedown", { cancelable: true });
    Object.assign(mouseDown, { detail: 2, button: 0, clientX: 60, clientY: 5,
      shiftKey: false, ctrlKey: false, metaKey: false, altKey: false });
    control.dispatchEvent(mouseDown);
    expect(mouseDown.defaultPrevented).toBe(true);
    const doubleClick = new Event("dblclick", { cancelable: true });
    Object.assign(doubleClick, { detail: 2, button: 0, clientX: 60, clientY: 5,
      shiftKey: false, ctrlKey: false, metaKey: false, altKey: false });
    control.dispatchEvent(doubleClick);
    expect(doubleClick.defaultPrevented).toBe(true);
    expect(hits).toBeGreaterThanOrEqual(1);
    expect(selections).toEqual([]);
  });
});
