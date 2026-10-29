import { describe, expect, test } from "bun:test";
import type { EditorTab } from "../src/editor/editorTab";
import { tabListItems } from "../src/editor/editorTabViewController";

function tab(path: string, options: Partial<EditorTab> = {}): EditorTab {
  return {
    path,
    content: "",
    savedContent: "",
    contentLoaded: true,
    isDirty: false,
    previewRootPath: null,
    previewMainPath: null,
    previewTaskId: null,
    previewSessionKey: null,
    previewImported: false,
    previewStandalone: true,
    previewDisabled: false,
    version: 1,
    latestVersion: 1,
    selectionAnchor: 0,
    selectionHead: 0,
    foldRanges: [],
    foldStateExplicit: false,
    ...options,
  };
}

describe("tab list menu", () => {
  test("describes every open tab and its state", () => {
    const items = tabListItems(
      [
        tab("C:/workspace/main.typ"),
        tab("C:/workspace/chapter.typ", { isDirty: true }),
        tab("C:/workspace/outside.txt", { offProject: true }),
      ],
      "C:/workspace/chapter.typ",
      "C:/workspace/main.typ",
    );

    expect(items).toEqual([
      {
        path: "C:/workspace/main.typ",
        title: "main.typ",
        active: false,
        dirty: false,
        pinnedMain: true,
        offProject: false,
      },
      {
        path: "C:/workspace/chapter.typ",
        title: "chapter.typ",
        active: true,
        dirty: true,
        pinnedMain: false,
        offProject: false,
      },
      {
        path: "C:/workspace/outside.txt",
        title: "outside.txt",
        active: false,
        dirty: false,
        pinnedMain: false,
        offProject: true,
      },
    ]);
  });

  test("renders an accessible dropdown next to the scrollable tab bar", async () => {
    const html = await Bun.file(new URL("../index.html", import.meta.url)).text();
    const styles = await Bun.file(new URL("../src/style.css", import.meta.url)).text();
    const tabs = await Bun.file(
      new URL("../src/editor/editorTabViewController.ts", import.meta.url),
    ).text();
    const strip = await Bun.file(
      new URL("../src/editor/tabStripController.ts", import.meta.url),
    ).text();

    expect(html).toContain('id="editor-tab-list-toggle"');
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain('aria-controls="editor-tab-list-menu"');
    expect(html).toContain('id="editor-tab-list-menu"');
    expect(html).toContain('role="menu"');
    expect(styles).toContain(".editor-tab-list-menu");
    expect(styles).toContain(".editor-tab-list-item.active");
    expect(styles).toContain(".editor-tab-nav-button:disabled");
    expect(tabs).toContain("public initialize(): void");
    expect(tabs).toContain('button.role = "menuitem"');
    expect(tabs).toContain("private handleTabListKeydown(");
    expect(tabs).toContain("this.setTabListOpen(false)");
    expect(strip).not.toContain("previousButton");
    expect(strip).not.toContain("nextButton");
  });
});
