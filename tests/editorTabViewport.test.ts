import { describe, expect, test } from "bun:test";
import type { EditorView } from "@codemirror/view";
import type { EditorTab } from "../src/editor/editorTab";
import { EditorTabStateController, type EditorTabStateDependencies } from "../src/editor/editorTabStateController";

function fixture(saved: Partial<EditorTab> = {}) {
  const path = "C:/project/new.typ";
  const scroll = { scrollTop: 8000, scrollLeft: 240, clientWidth: 600, clientHeight: 400 };
  const dispatched: unknown[] = [];
  const editor = {
    scrollDOM: scroll,
    visibleRanges: [{ from: 0, to: 20 }], state: { doc: { length: 20 } },
    dom: { clientWidth: 600, clientHeight: 400 },
    dispatch: (transaction: unknown) => dispatched.push(transaction),
    requestMeasure: (request: { read(): unknown; write(value: unknown): void }) => request.write(request.read()),
  } as unknown as EditorView;
  const controller = new EditorTabStateController({
    editor: () => editor, activeFilePath: () => path, logSyntax: () => {},
  } as EditorTabStateDependencies);
  const tab = { path, contentLoaded: true, ...saved } as EditorTab;
  return { controller, tab, scroll, dispatched };
}

async function withAnimationFrame(action: () => Promise<void>) {
  const original = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = callback => { callback(0); return 1; };
  try { await action(); }
  finally { globalThis.requestAnimationFrame = original; }
}

describe("editor tab viewport restoration", () => {
  test("new tabs reset the previous document's vertical and horizontal scroll", () => withAnimationFrame(async () => {
    const f = fixture();
    await f.controller.restoreViewport(f.tab, f.tab.path);
    expect(f.scroll.scrollTop).toBe(0);
    expect(f.scroll.scrollLeft).toBe(0);
  }));

  test("existing tabs retain their saved offsets", () => withAnimationFrame(async () => {
    const f = fixture({ scrollTop: 340, scrollLeft: 12 });
    await f.controller.restoreViewport(f.tab, f.tab.path);
    expect(f.scroll.scrollTop).toBe(340);
    expect(f.scroll.scrollLeft).toBe(12);
  }));

  test("document-aware snapshots take priority over numeric offsets", async () => {
    const snapshot = {} as NonNullable<EditorTab["scrollSnapshot"]>;
    const f = fixture({ scrollSnapshot: snapshot, scrollTop: 0 });
    await f.controller.restoreViewport(f.tab, f.tab.path);
    expect(f.dispatched).toEqual([{ effects: snapshot }]);
    expect(f.scroll.scrollTop).toBe(8000);
  });
});
