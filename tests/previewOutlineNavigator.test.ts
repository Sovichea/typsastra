import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeAppSettings } from "../src/settings";
import { TypsastraWorkspaceController } from "../src/appController";
import {
  matchOutlinePreviewPositions,
  outlineSourceSnapshot,
  type DocumentHeading,
} from "../src/outline/documentOutline";
import {
  flattenPreviewOutlineEntries,
  sourceDocumentOutlineEntries,
  standalonePdfOutlineEntries,
  type PreviewSourceOutlineItem,
} from "../src/preview/previewOutlineNavigator";

const root = join(import.meta.dir, "..");
const read = (...parts: string[]): string => readFileSync(join(root, ...parts), "utf8");

describe("undocked preview outline navigator", () => {
  test("converts source document headings into stable nested entries", () => {
    const entries = sourceDocumentOutlineEntries([
      {
        title: " Introduction ",
        bookmarkIndex: 0,
        position: { page_no: 1, x: 10, y: 20 },
        children: [
          { title: "Background", bookmarkIndex: 1, children: [] },
          { title: "", position: { page_no: 2, x: 0, y: 0 }, children: [] },
        ],
      },
      { title: "Methods", bookmarkIndex: 3, children: [] },
    ]);

    expect(entries.map(entry => entry.id)).toEqual(["0", "1"]);
    expect(entries[0].title).toBe("Introduction");
    expect(entries[0].bookmarkIndex).toBe(0);
    expect(entries[0].position).toEqual({ page_no: 1, x: 10, y: 20 });
    expect(entries[0].children.map(entry => [entry.id, entry.bookmarkIndex])).toEqual([
      ["0.0", 1],
      ["0.1", undefined],
    ]);
    expect(entries[0].children[1].title).toBe("Untitled");
    expect(flattenPreviewOutlineEntries(entries)).toHaveLength(4);
  });

  test("converts standalone PDF bookmarks with destinations", () => {
    const entries = standalonePdfOutlineEntries([
      {
        title: "Chapter 1",
        destination: { pageNo: 2, x: 10, y: 20 },
        children: [
          {
            title: "Section",
            destination: null,
            children: [],
          },
        ],
      },
    ]);

    expect(entries[0].destination).toEqual({ pageNo: 2, x: 10, y: 20 });
    expect(entries[0].children[0].title).toBe("Section");
    expect(entries[0].children[0].destination).toBeNull();
  });

  test("defaults the undocked outline panel to on and normalizes the setting", () => {
    expect(normalizeAppSettings({}).preview.undockedOutline).toBe(true);
    expect(normalizeAppSettings({ preview: { undockedOutline: false } }).preview.undockedOutline)
      .toBe(false);
    expect(normalizeAppSettings({ preview: { undockedOutline: "yes" } }).preview.undockedOutline)
      .toBe(true);
  });

  test("publishes the configured main document outline instead of the active include", async () => {
    const emitted: Array<readonly PreviewSourceOutlineItem[]> = [];
    const workspace = Object.assign(Object.create(TypsastraWorkspaceController.prototype), {
      previewWindowController: { isPreviewOnlyWindow: () => false },
      layoutController: { isPreviewUndocked: () => true },
      pinnedMainFilePath: "C:/project/main.typ",
      workspaceRootPath: "C:/project",
      previewOutlinePublishGeneration: 0,
      previewDocumentOutlineItems: [
        { title: "Executive Summary", bookmarkIndex: 0, children: [] },
      ],
      editorSessionController: {
        tabs: [
          {
            path: "C:/project/main.typ",
            contentLoaded: true,
            content: "= Executive Summary\n\n= Methods\n",
          },
          {
            path: "C:/project/chapters/01-introduction.typ",
            contentLoaded: true,
            content: "= Include-only Heading\n",
          },
        ],
      },
      emitPreviewOutline: (items: readonly PreviewSourceOutlineItem[]) => emitted.push(items),
    });

    await workspace.publishPreviewOutline();

    expect(emitted).toHaveLength(1);
    expect(emitted[0].map(item => item.title)).toEqual(["Executive Summary", "Methods"]);
    expect(emitted[0].map(item => item.bookmarkIndex)).toEqual([0, undefined]);
    expect(emitted[0].some(item => item.title === "Include-only Heading")).toBe(false);
  });

  test("matches main-document headings to PDF positions and snapshots them", () => {
    const headings: DocumentHeading[] = [
      {
        id: "1:Executive Summary:1",
        level: 1,
        title: "Executive Summary",
        filePath: "C:/project/main.typ",
        from: 0,
        textFrom: 2,
        to: 18,
        line: 1,
        children: [{
          id: "2:Background:1",
          level: 2,
          title: "Background",
          filePath: "C:/project/main.typ",
          from: 20,
          textFrom: 23,
          to: 33,
          line: 3,
          children: [],
        }],
      },
    ];

    matchOutlinePreviewPositions(headings, [
      {
        title: "Executive Summary",
        bookmarkIndex: 0,
        children: [{ title: "Background", bookmarkIndex: 1, children: [] }],
      },
    ]);

    expect(headings[0].previewBookmarkIndex).toBe(0);
    expect(headings[0].children[0].previewBookmarkIndex).toBe(1);
    expect(outlineSourceSnapshot(headings)).toEqual([
      {
        title: "Executive Summary",
        bookmarkIndex: 0,
        position: undefined,
        children: [{
          title: "Background",
          bookmarkIndex: 1,
          position: undefined,
          children: [],
        }],
      },
    ]);
  });

  test("wires live and standalone bookmarks into the undocked preview panel", () => {
    const app = read("src", "appController.ts");
    const bindings = read("src", "ui", "appEventBindings.ts");
    const previewWindow = read("src", "preview", "previewWindowController.ts");
    const navigator = read("src", "preview", "previewOutlineNavigator.ts");
    const styles = read("src", "style.css");

    expect(previewWindow).toContain("new PreviewOutlineNavigator({");
    expect(previewWindow).toContain("this.outlineNavigator.setVisible(deps.undockedOutlineVisible())");
    expect(previewWindow).toContain(
      "public setSourceOutline(items: readonly PreviewSourceOutlineItem[]): void",
    );
    expect(previewWindow).toContain(
      "public setStandalonePdfOutline(items: readonly PdfiumOutlineItem[] | null): void",
    );
    expect(previewWindow).toContain('data-preview-action="toggle-outline"');
    expect(previewWindow).toContain("this.setOutlineVisible(!deps.undockedOutlineVisible())");
    expect(previewWindow).toContain('emit("preview-outline-visible-request", visible)');
    expect(previewWindow).toContain('listen<readonly PreviewSourceOutlineItem[]>("preview-outline-update"');
    expect(previewWindow).toContain('emit("preview-outline-request")');
    expect(bindings).toContain('listenEvent("preview-outline-request"');
    expect(app).toContain("parseDocumentOutline(");
    expect(previewWindow).toContain("scrollToOutlineBookmark(bookmarkIndex)");
    expect(previewWindow).toContain("revealDocumentPosition({");
    expect(navigator).toContain("this.options.navigatePosition(entry.position)");
    expect(navigator).toContain("this.options.navigateBookmark(entry.bookmarkIndex)");
    expect(navigator).toContain("this.options.navigateDestination(entry.destination)");
    expect(navigator).toContain("beginDrag(event, this.header)");
    expect(navigator).toContain("setPointerCapture(event.pointerId)");
    expect(navigator).toContain('this.minimizeButton.className = "preview-outline-minimize"');
    expect(navigator).toContain("setMinimized(!this.minimized)");
    expect(styles).toContain("cursor: grab");
    expect(styles).toContain("max-height: calc((100% - 24px) / 3)");
    expect(styles).toContain(".preview-outline-panel.minimized");
    expect(styles).toContain("bottom: 12px;");
    expect(styles).not.toContain(".preview-outline-close");

    expect(app).toContain("const mainPath = this.pinnedMainFilePath;");
    expect(app).toContain("matchOutlinePreviewPositions(headings, this.previewDocumentOutlineItems)");
    expect(app).toContain("outlineSourceSnapshot(headings)");
    expect(app).toContain('emit("preview-outline-update", items)');
    expect(app).toContain("this.previewWindowController.setStandalonePdfOutline(items)");
    expect(app).toContain("undockedOutlineVisible: () => this.settingsController.value.preview.undockedOutline");
    expect(app).toContain("settings.preview.undockedOutline = visible");
    expect(bindings).toContain('listenEvent<boolean>("preview-outline-visible-request"');
    expect(bindings).toContain("actions.publishPreviewOutline()");
    expect(styles).toContain(".preview-outline-panel {");
  });
});
