import { describe, expect, test } from "bun:test";
import { parseDocumentOutline } from "../src/outline/documentOutline";

describe("document outline", () => {
  const parse = (source: string) => parseDocumentOutline(
    "C:/workspace/main.typ",
    source,
    "C:/workspace",
    async () => null
  );

  test("builds a nested heading tree with source positions", async () => {
    const source = "= Introduction <intro>\nText\n== Details\n=== Deep dive\n= Conclusion\n";
    const outline = await parse(source);

    expect(outline.map(heading => heading.title)).toEqual(["Introduction", "Conclusion"]);
    expect(outline[0].children[0].title).toBe("Details");
    expect(outline[0].children[0].children[0].title).toBe("Deep dive");
    expect(outline[0].textFrom).toBe(2);
    expect(outline[0].children[0].line).toBe(3);
  });

  test("ignores headings inside comments and fenced raw blocks", async () => {
    const source = [
      "// = Comment heading",
      "/*",
      "= Block comment heading",
      "*/",
      "```typ",
      "= Raw heading",
      "```",
      "= Real heading"
    ].join("\n");

    expect((await parse(source)).map(heading => heading.title)).toEqual(["Real heading"]);
  });

  test("includes chapter headings in the main document outline", async () => {
    const files = new Map<string, string>([
      ["C:/workspace/chapters/one.typ", "== Chapter One\nText\n"],
    ]);
    const outline = await parseDocumentOutline(
      "C:/workspace/main.typ",
      "= Main\n#include \"chapters/one.typ\"\n= Conclusion\n",
      "C:/workspace",
      async path => files.get(path) ?? null,
    );

    expect(outline.map(heading => heading.title)).toEqual(["Main", "Conclusion"]);
    expect(outline[0]?.children[0]?.title).toBe("Chapter One");
    expect(outline[0]?.children[0]?.filePath).toBe("C:/workspace/chapters/one.typ");
    expect(outline[0]?.children[0]?.line).toBe(1);
  });

  test("can list only the active file's headings", async () => {
    const files = new Map<string, string>([
      ["C:/workspace/chapters/one.typ", "== Chapter One\nText\n"],
    ]);
    const outline = await parseDocumentOutline(
      "C:/workspace/main.typ",
      "= Main\n#include \"chapters/one.typ\"\n= Conclusion\n",
      "C:/workspace",
      async path => files.get(path) ?? null,
      new Set(),
      false,
    );

    expect(outline.map(heading => heading.title)).toEqual(["Main", "Conclusion"]);
  });

  test("keeps duplicate headings independently addressable", async () => {
    const outline = await parse("= Same\n= Same\n");

    expect(outline).toHaveLength(2);
    expect(outline[0].id).not.toBe(outline[1].id);
    expect(outline[1].from).toBe(7);
  });

  test("keeps the project outline rooted at the pinned main document", async () => {
    const language = await Bun.file(
      new URL("../src/editor/documentLanguageController.ts", import.meta.url),
    ).text();
    const navigationSource = await Bun.file(
      new URL("../src/navigation/outlineNavigationController.ts", import.meta.url),
    ).text();
    const outlineSource = await Bun.file(
      new URL("../src/outline/documentOutline.ts", import.meta.url),
    ).text();

    expect(language).toContain("private outlineTarget(path: string): { path: string; followIncludes: boolean }");
    expect(language).toContain("const target = this.outlineTarget(path)");
    expect(language).toContain("const targetSource = await this.readWorkspaceFile(target.path)");
    expect(language).toContain("this.deps.outline().hasProjectFile(path)");
    expect(language).toContain("followIncludes: false");
    expect(language).toContain("target.followIncludes");
    expect(language).toContain("this.deps.outline().setCursorPosition(");
    expect(outlineSource).toContain("private projectFiles = new Set<string>()");
    expect(outlineSource).toContain("public hasProjectFile(path: string): boolean");
    expect(outlineSource).toContain("this.projectFiles = new Set([...visited].map(filePathKey))");
    expect(outlineSource).toContain("private previewOutlineItems: readonly OutlinePreviewItem[] = []");
    expect(outlineSource).toContain("matchOutlinePreviewPositions(this.headings, this.previewOutlineItems)");
    expect(outlineSource).toContain("const activePathKey = activePath ? filePathKey(activePath) : null");
    expect(outlineSource).toContain("filePathKey(heading.filePath) === activePathKey");
    expect(navigationSource).toContain("filePathKey(heading.filePath) !== filePathKey(activePath)");
  });

  test("uses compiled PDF bookmark destinations without requiring Tinymist", async () => {
    const frameSource = await Bun.file(
      new URL("../src/preview/previewFrame.ts", import.meta.url),
    ).text();
    const controllerSource = await Bun.file(
      new URL("../src/preview/previewController.ts", import.meta.url),
    ).text();

    expect(frameSource).toContain("await pdfDoc.getOutline()");
    expect(frameSource).toContain("destinations.push(item?.dest)");
    expect(frameSource).toContain("scrollToOutlineBookmark(bookmarkIndex: number)");
    expect(frameSource).toContain("await pdfDoc.getDestination(rawDestination)");
    expect(frameSource).toContain("await pdfDoc.getPageIndex(pageReference)");
    expect(frameSource).toContain('if (surface === "live" && this.onDocumentOutline)');
    expect(controllerSource).toContain("onDocumentOutline(items: PreviewOutlineItem[]): void");
  });

  test("gates cursor-driven outline preview sync on the Cursor sync setting", async () => {
    const outlineSource = await Bun.file(
      new URL("../src/outline/documentOutline.ts", import.meta.url),
    ).text();
    const editorSource = await Bun.file(
      new URL("../src/editor/editorInitializationController.ts", import.meta.url),
    ).text();
    const navigationSource = await Bun.file(
      new URL("../src/navigation/outlineNavigationController.ts", import.meta.url),
    ).text();
    const appSource = await Bun.file(
      new URL("../src/appController.ts", import.meta.url),
    ).text();

    expect(outlineSource).toContain("if (active && syncPreview) this.requestPreviewSync(active, activeKey!)");
    expect(outlineSource).toContain("if (syncPreview) this.requestPreviewSync(active, activeKey!)");
    expect(outlineSource).toContain("this.pendingPreviewSyncHeadingKey = hasDestination ? null : headingKey");
    expect(outlineSource).toContain("this.onActiveHeadingChanged?.(heading)");
    // Clicking in the editor must not scroll the PDF unless the user enabled
    // "Cursor sync" (currently disabled), and never for an inverse-sync click.
    expect(editorSource).toMatch(
      /setCursorPosition\(\s*update\.state\.selection\.main\.head,\s*deps\.activeFilePath\(\),\s*deps\.cursorSyncEnabled\(\) && !deps\.isInverseSyncSelection\(\),/s,
    );
    expect(appSource).toContain("cursorSyncEnabled: () => this.settingsController.value.preview.cursorSync");
    expect(navigationSource).toContain("revealInPreview(heading: DocumentHeading): void");
    expect(navigationSource).toContain("scrollToOutlineBookmark(heading.previewBookmarkIndex)");
    expect(navigationSource).toContain("this.revealPreviewPosition(heading.previewPosition)");
    expect(navigationSource).toContain("frame.revealDocumentPosition(position, { ripple: true })");
    expect(navigationSource).toContain("outline.waitForPreviewPosition(currentHeading)");
    expect(navigationSource).not.toContain("isLowMemoryMode");
  });
});
