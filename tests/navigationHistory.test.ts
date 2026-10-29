import { describe, expect, test } from "bun:test";
import { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { filePathKey } from "../src/platform/paths";
import {
  NavigationHistoryController,
  resolveNavigationHistorySelection,
} from "../src/navigation/navigationHistoryController";

type Harness = ReturnType<typeof createHarness>;

function createHarness(initialPath: string, initialText: string) {
  const files = new Map<string, string>([[filePathKey(initialPath), initialText]]);
  let activePath = initialPath;
  let contentLoaded = true;
  let state = EditorState.create({ doc: initialText });
  const notices: string[] = [];
  const loads: Array<{ path: string; options: Record<string, unknown> }> = [];
  const scrollDOM = { scrollTop: 0, scrollLeft: 0 };

  const editor = {
    get state() {
      return state;
    },
    dispatch(spec: Parameters<EditorView["dispatch"]>[0]) {
      state = state.update(spec).state;
    },
    scrollDOM,
    requestMeasure(spec: { write?: () => void }) {
      spec.write?.();
    },
    focus() {},
  } as unknown as EditorView;

  const controller = new NavigationHistoryController({
    activeFilePath: () => activePath,
    activeTabContentLoaded: () => contentLoaded,
    editor: () => editor,
    loadFile: async (path, options) => {
      loads.push({ path, options });
      const text = files.get(filePathKey(path));
      if (text === undefined) {
        contentLoaded = false;
        return;
      }
      activePath = path;
      contentLoaded = true;
      state = EditorState.create({ doc: text });
    },
    pathExists: async path => files.has(filePathKey(path)),
    showNotice: message => notices.push(message),
  });

  const jump = (path: string, anchor: number, scrollTop = 0, head = anchor) => {
    activePath = path;
    contentLoaded = true;
    state = EditorState.create({ doc: files.get(filePathKey(path)) ?? "" });
    state = state.update({ selection: { anchor, head } }).state;
    scrollDOM.scrollTop = scrollTop;
  };

  return {
    controller,
    editor,
    notices,
    loads,
    jump,
    setFile: (path: string, text: string) => files.set(filePathKey(path), text),
    deleteFile: (path: string) => files.delete(filePathKey(path)),
    activePath: () => activePath,
    state: () => state,
    scrollDOM,
  };
}

async function jumpTo(
  harness: Harness,
  path: string,
  text: string,
  anchor: number,
  scrollTop = 0,
): Promise<void> {
  harness.setFile(path, text);
  await harness.controller.run(() => harness.jump(path, anchor, scrollTop));
}

describe("navigation history", () => {
  test("records explicit jumps and restores selection and viewport through Back/Forward", async () => {
    const harness = createHarness("C:/workspace/a.typ", "alpha beta gamma\nsecond line");
    harness.jump("C:/workspace/a.typ", 6, 11);

    await jumpTo(harness, "C:/workspace/b.typ", "bravo charlie\nnext line", 8, 22);
    expect(harness.activePath()).toBe("C:/workspace/b.typ");
    expect(harness.controller.canGoBack()).toBe(true);
    expect(harness.controller.canGoForward()).toBe(false);

    await harness.controller.back();
    expect(harness.activePath()).toBe("C:/workspace/a.typ");
    expect(harness.state().selection.main.anchor).toBe(6);
    expect(harness.scrollDOM.scrollTop).toBe(11);
    expect(harness.loads.at(-1)?.options).toMatchObject({
      skipPreviewActivation: true,
      preservePreviewViewport: true,
    });

    await harness.controller.forward();
    expect(harness.activePath()).toBe("C:/workspace/b.typ");
    expect(harness.state().selection.main.anchor).toBe(8);
    expect(harness.scrollDOM.scrollTop).toBe(22);
  });

  test("discards the forward branch after navigating from a Back location", async () => {
    const harness = createHarness("C:/workspace/a.typ", "alpha beta");
    harness.jump("C:/workspace/a.typ", 2);
    await jumpTo(harness, "C:/workspace/b.typ", "bravo charlie", 4);
    await jumpTo(harness, "C:/workspace/c.typ", "charlie delta", 5);

    await harness.controller.back();
    expect(harness.activePath()).toBe("C:/workspace/b.typ");

    await jumpTo(harness, "C:/workspace/d.typ", "delta echo", 3);
    expect(harness.controller.canGoForward()).toBe(false);

    await harness.controller.back();
    expect(harness.activePath()).toBe("C:/workspace/b.typ");
    await harness.controller.forward();
    expect(harness.activePath()).toBe("C:/workspace/d.typ");
  });

  test("maps recorded selections through edits using source context", async () => {
    const harness = createHarness("C:/workspace/a.typ", "alpha beta");
    harness.jump("C:/workspace/a.typ", 2);
    await jumpTo(harness, "C:/workspace/b.typ", "bravo charlie", 6);
    await jumpTo(harness, "C:/workspace/a.typ", "alpha beta", 2);

    harness.setFile("C:/workspace/b.typ", "PREPEND\nbravo charlie");
    await harness.controller.back();

    expect(harness.activePath()).toBe("C:/workspace/b.typ");
    expect(harness.state().selection.main.anchor).toBe(14);
  });

  test("maps recorded offsets through edits in the open buffer", async () => {
    const harness = createHarness("C:/workspace/a.typ", "alpha beta");
    harness.jump("C:/workspace/a.typ", 2);
    await jumpTo(harness, "C:/workspace/b.typ", "PREFIXbravo charlie", 4);
    await jumpTo(harness, "C:/workspace/b.typ", "PREFIXbravo charlie", 10);

    const before = EditorState.create({ doc: "PREFIXbravo charlie" });
    const transaction = before.update({
      changes: { from: 0, to: before.doc.length, insert: "Z".repeat(50) },
    });
    harness.controller.documentChanged(
      "C:/workspace/b.typ",
      transaction.changes,
      transaction.state.doc,
    );
    harness.setFile("C:/workspace/b.typ", transaction.state.doc.toString());
    harness.jump("C:/workspace/b.typ", 0);

    await harness.controller.back();
    expect(harness.state().selection.main.anchor).toBe(0);
    await harness.controller.back();
    await harness.controller.forward();
    expect(harness.activePath()).toBe("C:/workspace/b.typ");
    expect(harness.state().selection.main.anchor).toBe(0);
  });

  test("skips missing destinations, reports them, and continues to the next entry", async () => {
    const harness = createHarness("C:/workspace/a.typ", "alpha beta");
    harness.jump("C:/workspace/a.typ", 2);
    await jumpTo(harness, "C:/workspace/b.typ", "bravo charlie", 4);
    await jumpTo(harness, "C:/workspace/c.typ", "charlie delta", 5);

    harness.deleteFile("C:/workspace/b.typ");
    await harness.controller.back();

    expect(harness.activePath()).toBe("C:/workspace/a.typ");
    expect(harness.notices).toHaveLength(1);
    expect(harness.notices[0]).toContain("b.typ");
    expect(harness.notices[0]).toContain("no longer exists");
  });

  test("updates entries after a known rename", async () => {
    const harness = createHarness("C:/workspace/a.typ", "alpha beta");
    harness.jump("C:/workspace/a.typ", 2);
    await jumpTo(harness, "C:/workspace/b.typ", "bravo charlie", 4);

    harness.controller.rename("C:/workspace/b.typ", "C:/workspace/renamed.typ");
    harness.setFile("C:/workspace/renamed.typ", "bravo charlie");
    harness.deleteFile("C:/workspace/b.typ");
    harness.jump("C:/workspace/renamed.typ", 4);

    await harness.controller.back();
    expect(harness.activePath()).toBe("C:/workspace/a.typ");
    await harness.controller.forward();
    expect(harness.activePath()).toBe("C:/workspace/renamed.typ");
  });

  test("keeps at most 100 entries and clears on workspace close", async () => {
    const harness = createHarness("C:/workspace/a.typ", "alpha beta");
    harness.jump("C:/workspace/a.typ", 2);
    for (let index = 0; index < 105; index += 1) {
      const path = `C:/workspace/file-${index}.typ`;
      await jumpTo(harness, path, `heading ${index}\ntext`, 2);
    }

    let steps = 0;
    while (harness.controller.canGoBack()) {
      await harness.controller.back();
      steps += 1;
      if (steps > 120) break;
    }
    expect(steps).toBe(99);

    harness.controller.clear();
    expect(harness.controller.canGoBack()).toBe(false);
    expect(harness.controller.canGoForward()).toBe(false);
  });

  test("rejects a replay after the workspace is cleared while loading", async () => {
    const harness = createHarness("C:/workspace/a.typ", "alpha beta");
    harness.jump("C:/workspace/a.typ", 2);
    await jumpTo(harness, "C:/workspace/b.typ", "bravo charlie", 4);

    const back = harness.controller.back();
    harness.controller.clear();
    await back;

    expect(harness.controller.canGoBack()).toBe(false);
    expect(harness.controller.canGoForward()).toBe(false);
  });

  test("connects history at existing navigation boundaries and exposes controls", async () => {
    const outline = await Bun.file(
      new URL("../src/navigation/outlineNavigationController.ts", import.meta.url),
    ).text();
    const sourceLocation = await Bun.file(
      new URL("../src/navigation/sourceLocationController.ts", import.meta.url),
    ).text();
    const diagnostics = await Bun.file(
      new URL("../src/diagnostics/diagnosticsController.ts", import.meta.url),
    ).text();
    const inverseSync = await Bun.file(
      new URL("../src/preview/previewSourceNavigationController.ts", import.meta.url),
    ).text();
    const app = await Bun.file(
      new URL("../src/appController.ts", import.meta.url),
    ).text();
    const html = await Bun.file(new URL("../index.html", import.meta.url)).text();
    const menu = await Bun.file(
      new URL("../src/platform/nativeAppMenuSpec.ts", import.meta.url),
    ).text();
    const lifecycle = await Bun.file(
      new URL("../src/workspace/workspaceLifecycleController.ts", import.meta.url),
    ).text();
    const rename = await Bun.file(
      new URL("../src/workspace/workspacePathRenameController.ts", import.meta.url),
    ).text();
    const editorInitialization = await Bun.file(
      new URL("../src/editor/editorInitializationController.ts", import.meta.url),
    ).text();

    for (const source of [outline, sourceLocation, diagnostics, inverseSync]) {
      expect(source).toContain("navigationHistory?.()");
      expect(source).toContain("history.run(");
    }
    expect(outline).toContain("private async navigateInternal(");
    expect(sourceLocation).toContain("private async navigateToLspLocationInternal(");
    expect(diagnostics).toContain("private async navigateToLogEntryInternal(");
    expect(inverseSync).toContain("private async navigateInverseSync(");

    expect(app).toContain(
      "return this.navigationHistoryController.run(() => this.navigateToProjectSearchResultInternal(target));",
    );
    expect(app).toContain('source: "navigation"');
    const tabStrip = html.slice(
      html.indexOf('id="editor-tab-strip"'),
      html.indexOf('id="editor-visual-toolbar"'),
    );
    expect(tabStrip).toContain('data-tool="history-back"');
    expect(tabStrip).toContain('data-tool="history-forward"');
    expect(tabStrip).toContain('id="editor-tab-list-toggle"');
    expect(html).not.toContain('editor-tab-scroll-controls');
    expect(html).not.toContain('id="editor-tabs-previous"');
    expect(html).toContain('id="action-navigation-back"');
    expect(menu).toContain('accelerator: "Alt+Left"');
    expect(menu).toContain('accelerator: "Alt+Right"');
    expect(lifecycle).toContain("app.navigationHistoryController.clear()");
    expect(rename).toContain("this.deps.navigationHistory?.().rename(oldPath, newPath)");
    expect(editorInitialization).toContain(
      "deps.navigationHistory?.()?.documentChanged(",
    );
    expect(app).toContain("new TabStripController(this.editorTabBar)");
    expect(app).toContain("this.editorTabViewController.initialize()");
  });

  test("resolves context before falling back to a clamped offset", () => {
    const resolved = resolveNavigationHistorySelection({
      anchor: 8,
      head: 8,
      contextBefore: "bravo ",
      contextAfter: "charlie",
    }, "PREPEND\nbravo charlie");
    expect(resolved).toEqual({ anchor: 14, head: 14 });

    const fallback = resolveNavigationHistorySelection({
      anchor: 999,
      head: 999,
      contextBefore: "missing",
      contextAfter: "missing",
    }, "short text");
    expect(fallback).toEqual({ anchor: 10, head: 10 });
  });
});
