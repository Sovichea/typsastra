import { describe, expect, test } from "bun:test";
import { PreviewFrame } from "../src/preview/previewFrame";
import { setCtrlWheelZoomStepPercent, installPreviewZoomGestures, wheelZoomFactor, zoomPreviewElementAtPoint, snapGestureZoom, buttonZoomPercent, GestureZoomSteps, type PreviewZoomGesture } from "../src/preview/previewZoomGestures";

function fixture() {
  const originalRequest = globalThis.requestAnimationFrame;
  const originalCancel = globalThis.cancelAnimationFrame;
  const frames = new Map<number, FrameRequestCallback>();
  let next = 0;
  globalThis.requestAnimationFrame = callback => { frames.set(++next, callback); return next; };
  globalThis.cancelAnimationFrame = id => { frames.delete(id); };
  const target = Object.assign(new EventTarget(), { style: { touchAction: "manipulation" } });
  const zooms: PreviewZoomGesture[] = [];
  const messages: string[] = [];
  let ends = 0, cancellations = 0, enabled = true;
  const dispose = installPreviewZoomGestures(target as unknown as HTMLElement, zoom => zooms.push(zoom), {
    onInput: message => messages.push(message),
    enabled: () => enabled, onEnd: () => { ends++; }, onCancel: () => { cancellations++; },
  });
  const send = (type: string, properties: Record<string, unknown> = {}) => {
    const event = Object.assign(new Event(type, { cancelable: true }), properties);
    target.dispatchEvent(event);
    return event;
  };
  return {
    target, zooms, messages, send, dispose, get ends() { return ends; }, get cancellations() { return cancellations; },
    disable: () => { enabled = false; },
    flush: () => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback(0)); },
    cleanup: () => { dispose(); globalThis.requestAnimationFrame = originalRequest; globalThis.cancelAnimationFrame = originalCancel; },
  };
}
const wheel = { ctrlKey: true, metaKey: false, deltaY: -10, deltaMode: 0, clientX: 120, clientY: 80 };
const touches = (distance: number) => [{ clientX: 0, clientY: 0 }, { clientX: distance, clientY: 0 }];

describe("preview zoom gestures", () => {
  test("logs installation and explicitly distinguishes detected pinch from ordinary scrolling", async () => {
    const f = fixture();
    try {
      await Promise.resolve();
      expect(f.messages.some(message => message.includes("LISTENING; touchpadPinch=unsupported"))).toBe(true);
      f.send("touchstart", { touches: touches(100) });
      expect(f.messages.some(message => message.includes("PINCH DETECTED (touchscreen)"))).toBe(true);
      f.send("touchmove", { touches: touches(120) });
      f.flush();
      expect(f.messages.some(message => message.includes("ZOOM DISPATCHED"))).toBe(true);
      f.send("touchend", { touches: [] });
      expect(f.messages.some(message => message.includes("ZOOM SEQUENCE ENDED"))).toBe(true);
    } finally { f.cleanup(); }
  });

  test("logs Ctrl-wheel as a candidate rather than falsely claiming it must be a pinch", () => {
    const f = fixture();
    try {
      f.send("wheel", wheel);
      expect(f.messages.some(message => message.includes("ZOOM CANDIDATE (Ctrl-wheel or touchpad pinch)"))).toBe(true);
    } finally { f.cleanup(); }
  });

  test("logs touch pointers even when the WebView does not emit TouchEvents", () => {
    const f = fixture();
    try {
      f.send("pointerdown", { pointerType: "touch", pointerId: 1 });
      f.send("pointerdown", { pointerType: "touch", pointerId: 2 });
      expect(f.messages.some(message => message.includes("PINCH SIGNAL (touch pointers)"))).toBe(true);
    } finally { f.cleanup(); }
  });

  test("gesture zoom snaps to integer 5-percent steps and buttons move by 25 percent", () => {
    expect(snapGestureZoom(103.37568023916438)).toBe(105);
    expect(snapGestureZoom(101)).toBe(100);
    expect(buttonZoomPercent(100, 1)).toBe(125);
    expect(buttonZoomPercent(125, -1)).toBe(100);
    expect(buttonZoomPercent(105, 1)).toBe(130);
    expect(buttonZoomPercent(10, -1, 10, 500)).toBe(10);
    expect(buttonZoomPercent(500, 1, 10, 500)).toBe(500);
  });

  test("a small Ctrl-wheel input uses the default 10-percent step", () => {
    for (const [deltaY, expected] of [[-1, 110], [1, 90]]) {
      const f = fixture();
      try {
        f.send("wheel", { ...wheel, deltaY });
        f.flush();
        const input = f.zooms[0];
        expect(new GestureZoomSteps().next(100, input.factor, input.deltaPercent, input.ensureStep)).toBe(expected);
      } finally { f.cleanup(); }
    }
  });

  test("small precision-wheel movement accumulates rather than advancing 5 percent on every event", () => {
    const steps = new GestureZoomSteps();
    let percent = 100;
    const result: number[] = [];
    for (let index = 0; index < 3; index++) {
      percent = steps.next(percent, wheelZoomFactor(-1), 0, true);
      result.push(percent);
    }
    expect(result).toEqual([105, 105, 105]);
    expect(steps.next(percent, wheelZoomFactor(1), 0, true)).toBe(100);
  });

  test("touchscreen input retains its existing rounding behavior", () => {
    expect(new GestureZoomSteps().next(100, 1.005)).toBe(100);
    expect(new GestureZoomSteps().next(100, 1.1957)).toBe(120);
    expect(new GestureZoomSteps().next(100, 1.005, 0, true)).toBe(105);
  });

  test("sub-step pinch movement accumulates without displaying fractional zoom", () => {
    const steps = new GestureZoomSteps();
    let percent = 100;
    for (let frame = 0; frame < 8; frame++) {
      percent = steps.next(percent, 1.005);
      expect(Number.isInteger(percent)).toBe(true);
      expect(percent % 5).toBe(0);
    }
    expect(percent).toBe(105);
    steps.reset();
    expect(steps.next(200, 1)).toBe(200);
  });

  test("native pinch support is enabled for main, development, and undocked windows", async () => {
    const config = await Bun.file(new URL("../src-tauri/tauri.conf.json", import.meta.url)).json();
    const dev = await Bun.file(new URL("../src-tauri/tauri.dev.conf.json", import.meta.url)).json();
    const layout = await Bun.file(new URL("../src/layout/layoutController.ts", import.meta.url)).text();
    expect(config.app.windows[0].zoomHotkeysEnabled).toBe(true);
    expect(dev.app.windows[0].zoomHotkeysEnabled).toBe(true);
    expect(layout).toContain("zoomHotkeysEnabled: true");
  });

  test("normalizes wheel units, preserves direction, and bounds extreme input", () => {
    expect(wheelZoomFactor(-10)).toBeGreaterThan(1);
    expect(wheelZoomFactor(10)).toBeLessThan(1);
    expect(wheelZoomFactor(0)).toBe(1);
    expect(wheelZoomFactor(1, 1)).toBeCloseTo(wheelZoomFactor(16));
    expect(wheelZoomFactor(1, 2, 100)).toBeCloseTo(wheelZoomFactor(100));
    expect(wheelZoomFactor(-100000)).toBe(wheelZoomFactor(-200));
  });

  test("coarse Ctrl-wheel notches advance exactly 10 percent each", () => {
    const f = fixture();
    try {
      f.send("wheel", { ...wheel, deltaY: -100 });
      f.flush();
      const steps = new GestureZoomSteps();
      expect(steps.next(100, f.zooms[0].factor, f.zooms[0].deltaPercent)).toBe(110);
      f.send("wheel", { ...wheel, deltaY: 100 });
      f.flush();
      expect(steps.next(110, f.zooms[1].factor, f.zooms[1].deltaPercent)).toBe(100);
    } finally { f.cleanup(); }
  });

  test("native gestures targeted at an iframe window reach the preview handler", () => {
    const f = fixture();
    const view = Object.assign(new EventTarget(), { innerWidth: 800, innerHeight: 600 });
    const doc = Object.assign(new EventTarget(), { defaultView: view });
    const zooms: PreviewZoomGesture[] = [];
    const dispose = installPreviewZoomGestures(doc as unknown as Document, zoom => zooms.push(zoom));
    try {
      view.dispatchEvent(Object.assign(new Event("gesturestart", { cancelable: true }), { scale: 1 }));
      view.dispatchEvent(Object.assign(new Event("gesturechange", { cancelable: true }), { scale: 1.2, clientX: 400, clientY: 300 }));
      view.dispatchEvent(new Event("gestureend", { cancelable: true }));
      expect(zooms).toHaveLength(1);
      expect(zooms[0].factor).toBeCloseTo(1.2);
    } finally { dispose(); f.cleanup(); }
  });

  test("PDF gesture anchoring is corrected before the frame can paint", () => {
    const f = fixture();
    try {
      const frame = Object.create(PreviewFrame.prototype) as PreviewFrame;
      const scrolls: unknown[] = [];
      Object.assign(frame, { iframe: {
        contentDocument: { querySelector: () => ({ getBoundingClientRect: () => ({ left: 0, top: 100, width: 600, height: 1000 }) }) },
        contentWindow: { innerWidth: 800, innerHeight: 600, scrollBy: (point: unknown) => scrolls.push(point) },
      } });
      const internals = frame as unknown as { restoreScrollAnchor(anchor: unknown, afterLayout: boolean, immediately: boolean): void };
      internals.restoreScrollAnchor({ pageNo: 1, pageXRatio: 0.5, pageYRatio: 0.5, viewportXRatio: 0.5, viewportYRatio: 0.5 }, false, true);
      expect(scrolls).toEqual([{ left: -100, top: 300, behavior: "auto" }]);
    } finally { f.cleanup(); }
  });

  test("pinching out of Fit preserves mixed page proportions", () => {
    const frame = Object.create(PreviewFrame.prototype) as PreviewFrame;
    Object.assign(frame, {
      pane: { clientWidth: 800 }, isFitToWidth: false, previewZoomPercent: 105,
      gestureLayoutScales: { referencePercent: 100, pages: new Map([[1, 1.2], [2, 0.78]]) },
    });
    const internals = frame as unknown as { pageScale(pageNo: number): number };
    expect(1200 * internals.pageScale(2) / (600 * internals.pageScale(1))).toBeCloseTo(1.3);
  });

  test("coalesces modified wheel deltas into one anchored update per animation frame", () => {
    const f = fixture();
    try {
      expect(f.send("wheel", wheel).defaultPrevented).toBe(true);
      f.send("wheel", { ...wheel, clientX: 140 });
      expect(f.zooms).toEqual([]);
      f.flush();
      expect(f.zooms).toHaveLength(1);
      expect(f.zooms[0].factor).toBe(1);
      expect(f.zooms[0].deltaPercent).toBe(20);
      expect(f.zooms[0].clientX).toBe(140);
    } finally { f.cleanup(); }
  });

  test("ordinary scrolling, zero deltas, and disabled surfaces do not zoom", () => {
    const f = fixture();
    try {
      expect(f.send("wheel", { ...wheel, ctrlKey: false }).defaultPrevented).toBe(false);
      expect(f.send("wheel", { ...wheel, deltaY: 0 }).defaultPrevented).toBe(false);
      f.disable();
      expect(f.send("wheel", wheel).defaultPrevented).toBe(false);
      f.flush();
      expect(f.zooms).toEqual([]);
    } finally { f.cleanup(); }
  });

  test("Cmd-wheel is also handled without browser-wide zoom", () => {
    const f = fixture();
    try {
      expect(f.send("wheel", { ...wheel, ctrlKey: false, metaKey: true }).defaultPrevented).toBe(true);
      f.flush();
      expect(f.zooms).toHaveLength(1);
    } finally { f.cleanup(); }
  });

  test("touchscreen pinch uses distance ratios and flushes the final update on release", () => {
    const f = fixture();
    try {
      expect(f.send("touchstart", { touches: touches(100) }).defaultPrevented).toBe(true);
      f.send("touchmove", { touches: touches(120) });
      f.send("touchmove", { touches: touches(150) });
      f.send("touchend", { touches: [] });
      expect(f.zooms).toHaveLength(1);
      expect(f.zooms[0].factor).toBeCloseTo(1.5);
      expect(f.zooms[0].clientX).toBe(75);
      expect(f.ends).toBe(1);
    } finally { f.cleanup(); }
  });

  test("single-touch scrolling is left to the preview", () => {
    const f = fixture();
    try {
      expect(f.send("touchstart", { touches: [{ clientX: 0, clientY: 0 }] }).defaultPrevented).toBe(false);
      expect(f.send("touchmove", { touches: [{ clientX: 0, clientY: 30 }] }).defaultPrevented).toBe(false);
      expect(f.zooms).toEqual([]);
    } finally { f.cleanup(); }
  });

  test("native gesture scales are incremental and duplicate wheel input is ignored", () => {
    const f = fixture();
    try {
      f.send("gesturestart", { scale: 1 });
      f.send("gesturechange", { scale: 1.1, clientX: 50, clientY: 60 });
      f.send("wheel", wheel);
      f.send("gesturechange", { scale: 1.2, clientX: 50, clientY: 60 });
      f.send("gestureend");
      expect(f.zooms).toHaveLength(1);
      expect(f.zooms[0].factor).toBeCloseTo(1.2);
      expect(f.ends).toBe(1);
    } finally { f.cleanup(); }
  });

  test("disposing a replaced preview cancels queued work and restores touch behavior", () => {
    const f = fixture();
    try {
      f.send("wheel", wheel);
      f.dispose();
      f.flush();
      expect(f.zooms).toEqual([]);
      expect(f.ends).toBe(0);
      expect(f.cancellations).toBe(1);
      expect(f.target.style.touchAction).toBe("manipulation");
      expect(f.send("wheel", wheel).defaultPrevented).toBe(false);
    } finally { f.cleanup(); }
  });

  test("CSS zoom keeps the document point under the gesture anchored", () => {
    const container = { scrollLeft: 0, scrollTop: 0 };
    let rect = { left: 10, top: 20 };
    const element = { getBoundingClientRect: () => rect };
    zoomPreviewElementAtPoint(container as HTMLElement, element as unknown as HTMLElement, 1, 2,
      { clientX: 110, clientY: 220 }, () => { rect = { left: 10, top: 20 }; });
    expect(container.scrollLeft).toBe(100);
    expect(container.scrollTop).toBe(200);
  });
});


test("Ctrl-wheel settings apply immediately to existing handlers without changing pinch or buttons", () => {
  const f = fixture();
  try {
    setCtrlWheelZoomStepPercent(20);
    f.send("wheel", { ...wheel, deltaY: -100 });
    f.flush();
    expect(f.zooms[0].deltaPercent).toBe(20);
    setCtrlWheelZoomStepPercent(5);
    f.send("wheel", { ...wheel, deltaY: 1 });
    f.flush();
    expect(f.zooms[1].deltaPercent).toBe(-5);
    expect(buttonZoomPercent(100, 1)).toBe(125);
    expect(new GestureZoomSteps().next(100, 1.05)).toBe(105);
  } finally { setCtrlWheelZoomStepPercent(10); f.cleanup(); }
});
