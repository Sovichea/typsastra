import { describe, expect, test } from "bun:test";
import { PreviewFrame } from "../src/preview/previewFrame";

type SessionFixture = {
  pdfDoc: object | null;
  mountedSessionKey: string;
  pendingRestoredScrollTop: number | null;
  pendingRestoredViewportAnchor: { pageNo: number } | null;
  clearMessageHost(): void;
  restoreScrollPosition(top: number): void;
  restoreScrollAnchor(anchor: object): void;
};

function fixture() {
  const frame = Object.create(PreviewFrame.prototype) as PreviewFrame;
  const state = frame as unknown as SessionFixture;
  const restored: unknown[] = [];
  Object.assign(state, {
    pdfDoc: {},
    mountedSessionKey: "main",
    pendingRestoredScrollTop: 0,
    pendingRestoredViewportAnchor: { pageNo: 1 },
    clearMessageHost() {},
    restoreScrollPosition(top: number) { restored.push(top); },
    restoreScrollAnchor(anchor: object) { restored.push(anchor); },
  });
  return { frame, state, restored };
}

describe("shared main/include PDF viewport", () => {
  test("tab reuse preserves the mouse-scrolled viewport across both directions", () => {
    const { frame, state, restored } = fixture();
    expect(frame.activateSession("main", true)).toBe(true);
    expect(state.pendingRestoredViewportAnchor).toBeNull();
    expect(state.pendingRestoredScrollTop).toBeNull();
    expect(frame.activateSession("main", true)).toBe(true);
    expect(restored).toEqual([]);
  });

  test("explicit viewport restoration still applies its queued anchor", () => {
    const { frame, restored } = fixture();
    expect(frame.activateSession("main")).toBe(true);
    expect(restored).toEqual([{ pageNo: 1 }]);
  });

  test("a different PDF session cannot consume the queued position", () => {
    const { frame, state, restored } = fixture();
    expect(frame.activateSession("different", true)).toBe(false);
    expect(state.pendingRestoredScrollTop).toBe(0);
    expect(restored).toEqual([]);
  });
});
