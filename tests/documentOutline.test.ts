import { describe, expect, test } from "bun:test";
import {
  parseDocumentOutline,
  parseDocumentOutlineDetailed,
} from "../src/outline/documentOutline";

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

  test("preserves repeated include occurrences with unique file identities", async () => {
    const files = new Map<string, string>([
      ["C:/workspace/chapter.typ", "= Shared\n"],
    ]);
    const outline = await parseDocumentOutline(
      "C:/workspace/main.typ",
      "= Main\n#include \"chapter.typ\"\n= Middle\n#include \"chapter.typ\"\n",
      "C:/workspace",
      async path => files.get(path) ?? null,
    );

    expect(outline.map(heading => heading.title)).toEqual([
      "Main",
      "Shared",
      "Middle",
      "Shared",
    ]);
    const ids = outline.map(heading => heading.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(outline[1]?.filePath).toBe("C:/workspace/chapter.typ");
    expect(outline[3]?.filePath).toBe("C:/workspace/chapter.typ");
  });

  test("uses file-based identities for duplicate headings in different files", async () => {
    const files = new Map<string, string>([
      ["C:/workspace/one.typ", "= Same\n"],
      ["C:/workspace/two.typ", "= Same\n"],
    ]);
    const outline = await parseDocumentOutline(
      "C:/workspace/main.typ",
      "= Main\n#include \"one.typ\"\n#include \"two.typ\"\n",
      "C:/workspace",
      async path => files.get(path) ?? null,
    );

    expect(outline.map(heading => heading.title)).toEqual(["Main", "Same", "Same"]);
    expect(outline[1]?.id).not.toBe(outline[2]?.id);
    expect(outline[1]?.id.toLowerCase()).toContain("one.typ");
    expect(outline[2]?.id.toLowerCase()).toContain("two.typ");
  });

  test("keeps file identities stable when unrelated includes are reordered", async () => {
    const files = new Map<string, string>([
      ["C:/workspace/one.typ", "= One\n"],
      ["C:/workspace/two.typ", "= Two\n"],
    ]);
    const readFile = async (path: string) => files.get(path) ?? null;
    const before = await parseDocumentOutline(
      "C:/workspace/main.typ",
      "= Main\n#include \"one.typ\"\n#include \"two.typ\"\n",
      "C:/workspace",
      readFile,
    );
    const after = await parseDocumentOutline(
      "C:/workspace/main.typ",
      "= Main\n#include \"two.typ\"\n#include \"one.typ\"\n",
      "C:/workspace",
      readFile,
    );

    const idFor = (outline: typeof before, title: string) =>
      outline.find(heading => heading.title === title)?.id;
    expect(idFor(before, "One")).toBe(idFor(after, "One"));
    expect(idFor(before, "Two")).toBe(idFor(after, "Two"));
  });

  test("reports unresolved, dynamic, cyclic, and imported includes", async () => {
    const files = new Map<string, string>([
      ["C:/workspace/a.typ", "= A\n#include \"b.typ\"\n"],
      ["C:/workspace/b.typ", "= B\n#include \"a.typ\"\n"],
    ]);
    const readFile = async (path: string) => files.get(path) ?? null;

    const notices = await parseDocumentOutlineDetailed(
      "C:/workspace/main.typ",
      [
        "#include \"missing.typ\"",
        "#include dynamicChapter",
        "#import \"template.typ\": template",
      ].join("\n"),
      "C:/workspace",
      readFile,
    );
    expect(new Set(notices.notices.map(notice => notice.kind))).toEqual(new Set([
      "missing-include",
      "dynamic-include",
      "import-not-supported",
    ]));

    const cyclic = await parseDocumentOutlineDetailed(
      "C:/workspace/a.typ",
      "= A\n#include \"b.typ\"\n",
      "C:/workspace",
      readFile,
    );
    expect(cyclic.headings.map(heading => heading.title)).toEqual(["A", "B"]);
    expect(cyclic.notices.some(notice => notice.kind === "include-cycle")).toBe(true);
  });

  test("routes include notices to the log console instead of the outline", async () => {
    const html = await Bun.file(new URL("../index.html", import.meta.url)).text();
    const styles = await Bun.file(new URL("../src/style.css", import.meta.url)).text();
    const outlineSource = await Bun.file(
      new URL("../src/outline/documentOutline.ts", import.meta.url),
    ).text();
    const appSource = await Bun.file(
      new URL("../src/appController.ts", import.meta.url),
    ).text();

    expect(html).not.toContain('id="document-outline-notices"');
    expect(styles).not.toContain(".outline-notice");
    expect(outlineSource).not.toContain("renderNotices");
    expect(outlineSource).toContain("this.onNotices?.(parsed.notices)");
    expect(appSource).toContain("private reportOutlineNotices");
    expect(appSource).toContain('source: "outline"');
    expect(appSource).toContain(
      'notice.kind === "import-not-supported" ? "info" : "warning"',
    );
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
    expect(language).toContain("!this.deps.outline().hasProjectFiles()");
    expect(language).toContain("this.scheduleOutlineUpdate(path, 0)");
    expect(language).toContain("followIncludes: false");
    expect(language).toContain("target.followIncludes");
    expect(language).toContain("this.deps.outline().setCursorPosition(");
    expect(outlineSource).toContain("private projectFiles = new Set<string>()");
    expect(outlineSource).toContain("public hasProjectFile(path: string): boolean");
    expect(outlineSource).toContain("public hasProjectFiles(): boolean");
    expect(outlineSource).toContain("this.projectFiles = new Set(parsed.files.map(filePathKey))");
    expect(outlineSource).toContain("private previewOutlineItems: readonly OutlinePreviewItem[] = []");
    expect(outlineSource).toContain("matchOutlinePreviewPositions(this.headings, this.previewOutlineItems)");
    expect(outlineSource).toContain("const activePathKey = activePath ? filePathKey(activePath) : null");
    expect(outlineSource).toContain("filePathKey(heading.filePath) === activePathKey");
    expect(navigationSource).toContain("filePathKey(heading.filePath) !== filePathKey(activePath)");
  });

  test("fades headings from files other than the active main or include", async () => {
    const outlineSource = await Bun.file(
      new URL("../src/outline/documentOutline.ts", import.meta.url),
    ).text();
    const styles = await Bun.file(
      new URL("../src/style.css", import.meta.url),
    ).text();

    expect(outlineSource).toContain("row.dataset.outlineFile = heading.filePath");
    expect(outlineSource).toContain("public setActiveFilePath(activePath: string | null): void");
    expect(outlineSource).toContain("private updateFileEmphasis(): void");
    expect(outlineSource).toContain('"outline-item-other-file"');
    expect(outlineSource).toContain("activeFileHasHeadings");
    expect(outlineSource).toContain("fileKey !== activeKey");
    const languageSource = await Bun.file(
      new URL("../src/editor/documentLanguageController.ts", import.meta.url),
    ).text();
    expect(languageSource).toContain("this.deps.outline().setActiveFilePath(path)");
    const navigationSource = await Bun.file(
      new URL("../src/navigation/outlineNavigationController.ts", import.meta.url),
    ).text();
    expect(navigationSource).toContain("outline.setActiveFilePath(heading.filePath)");
    expect(styles).toContain(".outline-item.outline-item-other-file .outline-label");
    expect(styles).toContain(".outline-item.outline-item-other-file .outline-disclosure");
    expect(styles).toContain("opacity: 0.56;");
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
