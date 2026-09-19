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

  test("keeps duplicate headings independently addressable", async () => {
    const outline = await parse("= Same\n= Same\n");

    expect(outline).toHaveLength(2);
    expect(outline[0].id).not.toBe(outline[1].id);
    expect(outline[1].from).toBe(7);
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

  test("synchronizes editor selection heading changes to the PDF in every memory mode", async () => {
    const outlineSource = await Bun.file(
      new URL("../src/outline/documentOutline.ts", import.meta.url),
    ).text();
    const editorSource = await Bun.file(
      new URL("../src/editor/editorInitializationController.ts", import.meta.url),
    ).text();
    const navigationSource = await Bun.file(
      new URL("../src/navigation/outlineNavigationController.ts", import.meta.url),
    ).text();

    expect(outlineSource).toContain("if (active && syncPreview) this.requestPreviewSync(active, activeKey!)");
    expect(outlineSource).toContain("if (syncPreview) this.requestPreviewSync(active, activeKey!)");
    expect(outlineSource).toContain("this.pendingPreviewSyncHeadingKey = hasDestination ? null : headingKey");
    expect(outlineSource).toContain("this.onActiveHeadingChanged?.(heading)");
    expect(editorSource).toMatch(
      /setCursorPosition\(\s*update\.state\.selection\.main\.head,\s*deps\.activeFilePath\(\),\s*true,/s,
    );
    expect(navigationSource).toContain("revealInPreview(heading: DocumentHeading): void");
    expect(navigationSource).toContain("scrollToOutlineBookmark(heading.previewBookmarkIndex)");
    expect(navigationSource).toContain("this.deps.previewFrame().scrollToPage(previewPosition.page_no)");
    expect(navigationSource).not.toContain("isLowMemoryMode");
  });
});
