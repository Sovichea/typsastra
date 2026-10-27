import { describe, expect, test } from "bun:test";
import { EditorState } from "@codemirror/state";
import { ensureSyntaxTree } from "@codemirror/language";
import { typstLanguage } from "../src/editor/typstLanguage";
import { EditorTabPresentationController } from "../src/editor/editorTabPresentationController";
import { EditorFileContentController } from "../src/editor/editorFileContentController";
import { completeSourcePrefix } from "../src/workspace/largeFileOpening";
import type { EditorTab } from "../src/editor/editorTab";

function syntaxFixture() {
  const source = Array.from({ length: 1000 }, (_, index) => `#let value${index} = (${index}, "example")`).join("\n");
  let state = EditorState.create({ doc: source, selection: { anchor: source.length }, extensions: typstLanguage });
  ensureSyntaxTree(state, source.length, 1000);
  state = state.update({}).state;
  const classes = new Set(["editor-syntax-preparing"]);
  const parsed: Array<{ from: number; to: number }> = [];
  const editor = {
    state, visibleRanges: [{ from: 0, to: 90 }],
    scrollDOM: { scrollTop: 0, scrollLeft: 0, clientWidth: 600, clientHeight: 400 },
    dom: { classList: { remove: (name: string) => classes.delete(name) }, clientWidth: 600, clientHeight: 400, isConnected: true },
    contentDOM: { querySelectorAll: () => [] },
    plugin: () => null, dispatch: () => {},
    requestMeasure: (request: { read(): unknown; write(value: unknown): void }) => request.write(request.read()),
  };
  const controller = Object.create(EditorTabPresentationController.prototype) as EditorTabPresentationController;
  Object.assign(controller, {
    deps: { editor: () => editor, workspaceLoading: () => false, logSyntax: () => {} },
    pendingSyntaxPath: "example.typ", syntaxPresentationGeneration: 1, syntaxViewportSeededGeneration: 1,
    parseVisibleSyntax: (_view: unknown, _generation: number, from: number, to: number) => { parsed.push({ from, to }); return true; },
    scheduleSyntaxPrewarm: () => {}, schedulePostRevealAudit: () => {},
  });
  return { controller, editor, classes, parsed };
}

describe("tab presentation performance", () => {
  test("a parsed 1000-line tab reveals immediately without the multi-frame syntax gate", () => {
    const f = syntaxFixture();
    f.controller.finishTextPresentation("example.typ");
    expect(f.classes.has("editor-syntax-preparing")).toBe(false);
    expect(f.parsed).toEqual([]);
  });

  test("an off-screen caret cannot expand or stall the visible syntax gate", () => {
    const f = syntaxFixture();
    const original = globalThis.requestAnimationFrame;
    const frames: FrameRequestCallback[] = [];
    globalThis.requestAnimationFrame = callback => { frames.push(callback); return frames.length; };
    try {
      const internals = f.controller as unknown as { revealAfterVisibleSyntaxIsReady(editor: unknown, generation: number, path: string): void };
      internals.revealAfterVisibleSyntaxIsReady(f.editor, 1, "example.typ");
      for (let pass = 0; frames.length && pass < 10; pass++) frames.shift()!(pass);
      expect(f.classes.has("editor-syntax-preparing")).toBe(false);
      expect(f.parsed.length).toBeGreaterThan(0);
      expect(f.parsed.every(range => range.from === 0 && range.to === 90)).toBe(true);
    } finally { globalThis.requestAnimationFrame = original; }
  });

  test("small UTF-8 files can reuse their inspection read, while truncated prefixes cannot", () => {
    const source = "#let title = \"សួស្តី\"\r\n#title\r\n";
    expect(completeSourcePrefix(source, new TextEncoder().encode(source).length)).toEqual({ content: source, lineCount: 2 });
    expect(completeSourcePrefix(source, new TextEncoder().encode(source).length + 10)).toBeNull();
    expect(completeSourcePrefix("", 0)).toEqual({ content: "", lineCount: 0 });
  });

  test("file activation consumes the prefetched source without another native read", async () => {
    const loader = new EditorFileContentController({ normalizeFoldRanges: () => [] });
    const tab = { path: "example.typ", contentLoaded: false, prefetchedContent: "first\r\nsecond", foldRanges: [] } as unknown as EditorTab;
    const first = loader.loadTabContent(tab);
    expect(loader.loadTabContent(tab)).toBe(first);
    await first;
    expect(tab.contentLoaded).toBe(true);
    expect(tab.content).toBe("first\nsecond");
    expect(tab.savedContent).toBe(tab.content);
    expect(tab.prefetchedContent).toBeUndefined();
  });
});
