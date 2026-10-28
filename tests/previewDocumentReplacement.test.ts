import { PreviewFrame } from "../src/preview/previewFrame";
import { describe, expect, test } from "bun:test";
import {
  capturePreviewDocumentToken,
  previewDocumentTokenIsCurrent,
} from "../src/preview/previewDocumentGeneration";

describe("standalone PDF document replacement", () => {
  test("rejects asynchronous work owned by an older document generation", () => {
    const olderDocument = { name: "older" };
    const newerDocument = { name: "newer" };
    const olderWork = capturePreviewDocumentToken(4, olderDocument);
    const newerWork = capturePreviewDocumentToken(5, newerDocument);

    expect(previewDocumentTokenIsCurrent(olderWork, 5, newerDocument)).toBe(false);
    expect(previewDocumentTokenIsCurrent(olderWork, 4, newerDocument)).toBe(false);
    expect(previewDocumentTokenIsCurrent(newerWork, 5, newerDocument)).toBe(true);
  });

  test("keeps the old PDF visible until its replacement is ready", async () => {
    const source = await Bun.file(new URL("../src/preview/previewFrame.ts", import.meta.url)).text();
    const generation = source.indexOf("const generation = ++this.pdfGeneration;");
    const reset = source.indexOf("this.resetStandalonePdfSearch();", generation);
    const prepareSurface = source.indexOf("this.preparePdfReplacementSurface(existingIframeDoc);", generation);
    const ensureIframe = source.indexOf("const iframe = await this.ensureIframe();", generation);
    const openDocument = source.indexOf("PdfiumDocument.open(", ensureIframe);
    const prepareMethod = source.slice(
      source.indexOf("private preparePdfReplacementSurface("),
      source.indexOf("private finishPdfReplacementSurface("),
    );
    const installNewDocument = source.indexOf("this.pdfDoc = pdfDoc;", openDocument);
    const replacePages = source.indexOf("this.createPageSlots(iframeDoc, false);", installNewDocument);

    expect(generation).toBeGreaterThan(-1);
    expect(reset).toBeGreaterThan(generation);
    expect(reset).toBeLessThan(prepareSurface);
    expect(prepareSurface).toBeLessThan(ensureIframe);
    expect(ensureIframe).toBeLessThan(openDocument);
    expect(installNewDocument).toBeGreaterThan(openDocument);
    expect(replacePages).toBeGreaterThan(installNewDocument);
    expect(prepareMethod).toContain('viewer?.setAttribute("aria-busy", "true")');
    expect(prepareMethod).toContain('this.pdfDoc && viewer.querySelector(".pdf-page-canvas")');
    expect(prepareMethod).toContain('viewer.classList.add("pdf-retained-viewer")');
    expect(prepareMethod).toContain("viewer.style.minHeight = `${this.retainedViewer.scrollHeight}px`");
    expect(prepareMethod).not.toContain("this.pageSlots = []");
    expect(prepareMethod).toContain('viewer.classList.add("pdf-retained-viewer")');
    expect(source).toContain("this.trackReplacementPagePaints(iframeDoc)");
    expect(source).toContain("this.markReplacementPagePainted(pageNo)");
    expect(source).toContain("this.pendingReplacementPages.delete(pageNo)");
    expect(source).not.toContain("this.createPageSlots(iframeDoc, true);");
    expect(source).toContain('replaceElementChildren(viewer);'); // swapped after new PDF installation
    expect(source).toContain('this.mountedSessionKey = "";');
    expect(source).toContain('root.dataset.pdfReplacing !== "true"');
  });

  test("detaches the previous document when a replacement fails", async () => {
    const source = await Bun.file(new URL("../src/preview/previewFrame.ts", import.meta.url)).text();
    const failure = source.indexOf("} catch (error) {", source.indexOf("private async loadPdfSource("));
    const finallyBlock = source.indexOf("} finally {", failure);
    const failureBody = source.slice(failure, finallyBlock);

    expect(failureBody).toContain("this.pdfDoc = null;");
    expect(failureBody).toContain("this.pdfLoadingTask = null;");
    expect(failureBody).toContain("this.pageDimensions.clear();");
    expect(failureBody).toContain("classifyStandalonePdfLoadFailure(error)");
    expect(source).toContain("if (!doc || !this.pdfDoc || !this.isStandalonePdfSurface()) return;");
  });

  test("binds search to one immutable PDF document across every await", async () => {
    const source = await Bun.file(new URL("../src/preview/previewFrame.ts", import.meta.url)).text();

    expect(source).toContain("const documentToken = capturePreviewDocumentToken(this.pdfGeneration, pdfDoc);");
    expect(source).toContain("previewDocumentTokenIsCurrent(documentToken, this.pdfGeneration, this.pdfDoc)");
    expect(source.match(/if \(!isCurrent\(\)\) return;/g)?.length).toBeGreaterThanOrEqual(4);
  });
});


describe("replacement PDF presentation", () => {
  function fixture() {
    const root = { dataset: { pdfReplacing: "true" } as Record<string, string> };
    let discarded = false;
    let busy = true;
    const frame = Object.assign(Object.create(PreviewFrame.prototype), {
      retainedViewer: {},
      pendingReplacementPages: new Set([17, 18]),
      pageSlots: [
        { dataset: { pageNo: "17" }, getBoundingClientRect: () => ({ top: -900, bottom: -10 }) },
        { dataset: { pageNo: "19" }, getBoundingClientRect: () => ({ top: 20, bottom: 700 }) },
      ],
      iframe: { clientHeight: 800, contentDocument: {
        documentElement: root,
        getElementById: () => ({ removeAttribute: () => { busy = false; } }),
      } },
      discardRetainedViewer() { discarded = true; this.retainedViewer = null; this.pendingReplacementPages.clear(); },
    });
    return { frame, root, discarded: () => discarded, busy: () => busy };
  }

  test("swaps when a newly visible page paints even if the original pending pages moved offscreen", () => {
    const f = fixture();
    f.frame.markReplacementPagePainted(19);
    expect(f.discarded()).toBe(true);
    expect(f.root.dataset.pdfReplacing).toBeUndefined();
    expect(f.busy()).toBe(false);
  });

  test("an offscreen page does not reveal an unpainted replacement viewport", () => {
    const f = fixture();
    f.frame.markReplacementPagePainted(17);
    expect(f.discarded()).toBe(false);
    expect(f.root.dataset.pdfReplacing).toBe("true");
  });

  test("hides the replacement surface while the old PDF is retained", async () => {
    const source = await Bun.file(new URL("../src/preview/previewFrame.ts", import.meta.url)).text();
    expect(source).toContain('#viewer-container:has(~ .pdf-retained-viewer){visibility:hidden}');
    expect(source).not.toContain('#viewer-container .pdf-page-container{background:transparent;box-shadow:none}');
  });
});


describe("stationary preview rendering", () => {
  test("queues the visible viewport immediately without an IntersectionObserver or scroll event", () => {
    const queued: unknown[][] = [];
    const slots = [
      { dataset: { pageNo: "17" }, getBoundingClientRect: () => ({ top: 20, bottom: 700 }) },
      { dataset: { pageNo: "18" }, getBoundingClientRect: () => ({ top: 720, bottom: 1400 }) },
      { dataset: { pageNo: "19" }, getBoundingClientRect: () => ({ top: 1420, bottom: 2100 }) },
      { dataset: { pageNo: "20" }, getBoundingClientRect: () => ({ top: 2120, bottom: 2800 }) },
    ];
    const frame = Object.assign(Object.create(PreviewFrame.prototype), {
      iframe: { clientHeight: 800, contentWindow: {}, contentDocument: { querySelectorAll: () => slots } },
      queuePageRender: (...args: unknown[]) => queued.push(args),
    });
    frame.installPageObserver(frame.iframe);
    expect(queued).toEqual([
      [17, 0, "settled-visible"],
      [18, 0, "settled-visible"],
      [19, 2, "directional-neighbor"],
    ]);
  });
});


test("retries an initial bitmap invalidated by geometry discovery without scrolling", async () => {
  let key = "initial";
  let finish!: () => void;
  const painted = new Promise<void>(resolve => { finish = resolve; });
  const queued: unknown[][] = [];
  const dimensions = { width: 600, height: 800 };
  const slot = { dataset: {} as Record<string, string>, isConnected: true };
  const pdfPage = {
    getViewport: ({ scale }: { scale: number }) => ({ width: 600 * scale, height: 800 * scale }),
    render: () => ({ promise: painted }),
  };
  const frame = Object.assign(Object.create(PreviewFrame.prototype), {
    pdfGeneration: 1, pdfDoc: { getPage: async () => pdfPage },
    iframe: { contentDocument: {
      querySelector: () => slot,
      createElement: () => ({ width: 0, height: 0 }),
    } },
    activeRenders: new Map(), pageDimensions: new Map([[1, dimensions]]),
    pageRenderOwnership: { retain() {}, release() {} },
    currentPageRenderKey: () => key,
    pageScale: () => 1, pageOutputScale: () => 1,
    queuePageRender: (...args: unknown[]) => queued.push(args),
  });
  const rendering = frame.renderPage({ generation: 1, pageNo: 1 });
  await Promise.resolve();
  key = "geometry-discovered";
  finish();
  await rendering;
  expect(queued).toEqual([[1, 0, "settled-visible"]]);
  expect(frame.activeRenders.size).toBe(0);
});


test("revealing the first preview at saved manual zoom queues pages without scrolling", () => {
  let renders = 0;
  let fits = 0;
  const frame = Object.assign(Object.create(PreviewFrame.prototype), {
    pdfDoc: {}, isFitToWidth: false, resizeLayoutSuspended: false,
    renderVisiblePages() { renders++; }, applyFitToWidth() { fits++; },
  });
  frame.refreshPreviewAfterResize();
  expect(renders).toBe(1);
  expect(fits).toBe(0);
  frame.isFitToWidth = true;
  frame.refreshPreviewAfterResize();
  expect(fits).toBe(1);
  frame.resizeLayoutSuspended = true;
  frame.refreshPreviewAfterResize();
  expect(frame.resizeLayoutPending).toBe(true);
  expect(fits).toBe(1);
});


test("late landscape geometry preserves horizontal panning on a visible portrait page", () => {
  let scrollX = 180;
  const wider = { style: { width: "600px", height: "800px" } };
  const visible = {
    dataset: { pageNo: "8" },
    getBoundingClientRect: () => ({
      left: 20 + (Number.parseFloat(wider.style.width) - 600) / 2 - scrollX,
      top: -200, width: 600, height: 800,
    }),
  };
  const view = {
    innerWidth: 400, innerHeight: 500,
    scrollBy: ({ left }: { left: number }) => { scrollX += left; },
  };
  const frame = Object.assign(Object.create(PreviewFrame.prototype), {
    iframe: { contentWindow: view, contentDocument: {
      querySelector: (selector: string) => selector.includes('"8"') ? visible : wider,
      querySelectorAll: () => [visible],
    } },
    pageScale: () => 1,
  });
  const before = frame.currentViewportAnchor;
  frame.updatePageSlotDimensions(17, { width: 1000, height: 700 });
  expect(scrollX).toBe(380);
  expect(frame.currentViewportAnchor).toEqual(before);
  frame.updatePageSlotDimensions(17, { width: 600, height: 800 });
  expect(scrollX).toBe(180);
  expect(frame.currentViewportAnchor).toEqual(before);
});
