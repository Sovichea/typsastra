import { TypsastraWorkspaceController } from "../src/appController";
import { PreviewFrame, readInitialPdfPageDimensions } from "../src/preview/previewFrame";
import { describe, expect, test } from "bun:test";
import {
  capturePreviewDocumentToken,
  previewDocumentTokenIsCurrent,
} from "../src/preview/previewDocumentGeneration";

describe("standalone PDF document replacement", () => {
  test("a late offscreen page completion cannot evict the visible viewport", () => {
    const evicted: number[] = [];
    const frame = Object.assign(Object.create(PreviewFrame.prototype), {
      renderedPageNumbers: () => [1, 2, 3, 4, 5, 6, 7, 25],
      viewportPageNumbers: () => [25], visiblePageNumber: () => 25,
      releaseFinalPage: (pageNo: number) => evicted.push(pageNo),
    });
    frame.trimResidentPages();
    expect(evicted).toEqual([1]);
    frame.viewportPageNumbers = () => [1, 25];
    frame.trimResidentPages();
    expect(evicted).toEqual([1]);
  });

  test("a canvas without completed presentation is queued again instead of leaving a stale replacement", () => {
    const slot = { dataset: { renderKey: "current", presentedKey: undefined as string | undefined } };
    const queued: number[] = [];
    const frame = Object.assign(Object.create(PreviewFrame.prototype), {
      gestureZoomActive: false, pdfDoc: { numPages: 25 }, pdfGeneration: 2,
      iframe: { contentDocument: { querySelector: (selector: string) => {
        expect(selector).toContain("#viewer-container >");
        return slot;
      } } },
      currentPageRenderKey: () => "current", activeRenders: new Map(),
      renderScheduler: { enqueue: ({ pageNo }: { pageNo: number }) => { queued.push(pageNo); return "queued"; } },
      motion: { current: () => ({ state: "idle" }) }, pumpPageRenderQueue: () => {},
    });
    frame.queuePageRender(25, 0, "settled-visible");
    expect(queued).toEqual([25]);
    slot.dataset.presentedKey = "current";
    frame.queuePageRender(25, 0, "settled-visible");
    expect(queued).toEqual([25]);
  });

  test("docking clears presentation markers so hidden canvas bitmaps repaint", () => {
    const slots = [
      { dataset: { presentedKey: "current" as string | undefined } },
      { dataset: { presentedKey: "current" as string | undefined } },
    ];
    let paints = 0;
    const frame = Object.assign(Object.create(PreviewFrame.prototype), {
      pdfDoc: {},
      isFitToWidth: false,
      iframe: { contentDocument: { querySelectorAll: () => slots } },
      renderVisiblePages: () => { paints++; },
    });
    frame.refreshAfterPresentationChange();
    expect(paints).toBe(1);
    expect(slots.map(slot => slot.dataset.presentedKey)).toEqual([undefined, undefined]);
  });
  test("late disposal of an image-replaced PDF preserves the restored live PDF geometry", async () => {
    let finishCleanup!: () => void;
    const cleanup = new Promise<void>(resolve => { finishCleanup = resolve; });
    const frame = Object.assign(Object.create(PreviewFrame.prototype), {
      resetStandalonePdfSearch: () => {}, cancelAllPageRenders: () => {},
      observer: null, pdfDoc: {}, pdfLoadingTask: null, pendingPdfLoadingTask: null,
      pageDimensions: new Map([[1, { width: 100, height: 200 }]]),
      landscapePages: new Set<number>(), pageSlots: [{}], pdfOutlineDestinations: [],
      cleanupPdfDocumentGeneration: () => cleanup,
    });
    const disposed = frame.disposePdfDocument();
    frame.pdfDoc = { name: "restored live PDF" };
    frame.pageDimensions.set(11, { width: 800, height: 600 });
    frame.landscapePages.add(11);
    const restoredSlots = [{}];
    frame.pageSlots = restoredSlots;
    finishCleanup();
    await disposed;
    expect(frame.pageDimensions.get(11)).toEqual({ width: 800, height: 600 });
    expect(frame.landscapePages.has(11)).toBe(true);
    expect(frame.pageSlots).toBe(restoredSlots);
  });
  test("revealing a resident live PDF repaints without scrolling and ignores obsolete reveal work", () => {
    const previousRaf = globalThis.requestAnimationFrame;
    const callbacks: FrameRequestCallback[] = [];
    globalThis.requestAnimationFrame = callback => { callbacks.push(callback); return callbacks.length; };
    try {
      let paints = 0;
      let resets = 0;
      const frame = Object.assign(Object.create(PreviewFrame.prototype), {
        pdfGeneration: 1, pdfDoc: {}, mountedUrl: "mirror/main.typ", mountedSessionKey: "main",
        iframe: {
          contentDocument: { querySelectorAll: () => [] },
          contentWindow: { scrollY: 800 },
        },
        isFitToWidth: false,
        clearMessageHost: () => {},
        motion: { reset: (top: number) => { expect(top).toBe(800); resets++; } },
        trackReplacementPagePaints: () => {}, renderVisiblePages: () => { paints++; },
        pumpPageRenderQueue: () => {}, visiblePageNumber: () => 2, reportPageStatus: () => {},
      });
      expect(frame.activateSession("main", true)).toBe(true);
      expect(paints).toBe(0);
      while (callbacks.length) callbacks.shift()!(0);
      expect(paints).toBe(1);
      expect(resets).toBe(1);
      frame.retainMountedLivePreview("mirror/main.typ", "main");
      frame.pdfGeneration++;
      while (callbacks.length) callbacks.shift()!(0);
      expect(paints).toBe(1);
    } finally {
      globalThis.requestAnimationFrame = previousRaf;
    }
  });

  test("an old preview cannot restore its scroll anchor into a replacement PDF", () => {
    const previousRaf = globalThis.requestAnimationFrame;
    const callbacks: FrameRequestCallback[] = [];
    globalThis.requestAnimationFrame = callback => { callbacks.push(callback); return callbacks.length; };
    try {
      const frame = Object.assign(Object.create(PreviewFrame.prototype), { pdfGeneration: 1 });
      frame.restoreScrollAnchor({ pageNo: 2 }, true);
      frame.restoreScrollPosition(800);
      frame.pdfGeneration++;
      // No iframe is accessed by obsolete callbacks.
      while (callbacks.length) callbacks.shift()!(0);
      expect(frame.pdfGeneration).toBe(2);
    } finally { globalThis.requestAnimationFrame = previousRaf; }
  });
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
    expect(source).toContain("if (!doc || !this.pdfDoc || !this.isSearchablePdfSurface()) return;");
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
    const originalRequest = globalThis.requestAnimationFrame;
    const frames: FrameRequestCallback[] = [];
    globalThis.requestAnimationFrame = callback => { frames.push(callback); return frames.length; };
    const root = { dataset: { pdfReplacing: "true" } as Record<string, string> };
    let discarded = false;
    let busy = true;
    const slots = [
      { dataset: { pageNo: "17" } as Record<string, string>, getBoundingClientRect: () => ({ top: -900, bottom: -10 }) },
      { dataset: { pageNo: "19" } as Record<string, string>, getBoundingClientRect: () => ({ top: 20, bottom: 400 }) },
      { dataset: { pageNo: "20" } as Record<string, string>, getBoundingClientRect: () => ({ top: 420, bottom: 900 }) },
    ];
    const queued: number[] = [];
    const frame = Object.assign(Object.create(PreviewFrame.prototype), {
      retainedViewer: {}, replacementLayoutReady: true, replacementCommitFrame: null, pdfGeneration: 1,
      currentPageRenderKey: (_generation: number, pageNo: number) => `ready-${pageNo}`,
      queuePageRender: (pageNo: number) => queued.push(pageNo),
      pendingReplacementPages: new Set([17, 18]), pageSlots: slots,
      iframe: { clientHeight: 800, contentDocument: {
        documentElement: root,
        getElementById: () => ({ removeAttribute: () => { busy = false; } }),
      } },
      discardRetainedViewer() { discarded = true; this.retainedViewer = null; this.pendingReplacementPages.clear(); },
    });
    return {
      frame, root, slots, queued, discarded: () => discarded, busy: () => busy,
      paint(pageNo: number) {
        slots.find(slot => Number(slot.dataset.pageNo) === pageNo)!.dataset.presentedKey = `ready-${pageNo}`;
        frame.markReplacementPagePainted(pageNo);
      },
      flush() { const callbacks = frames.splice(0); callbacks.forEach(callback => callback(0)); },
      cleanup() { globalThis.requestAnimationFrame = originalRequest; },
    };
  }

  test("keeps the old viewport until every currently visible page is ready", () => {
    const f = fixture();
    try {
      f.paint(19);
      f.flush();
      expect(f.discarded()).toBe(false);
      expect(f.queued).toContain(20);
      f.paint(20);
      expect(f.discarded()).toBe(false); // swap is deferred to one paint
      f.flush();
      expect(f.discarded()).toBe(true);
      expect(f.root.dataset.pdfReplacing).toBeUndefined();
      expect(f.busy()).toBe(false);
    } finally { f.cleanup(); }
  });

  test("offscreen pages from the original viewport do not block the swap", () => {
    const f = fixture();
    try {
      f.paint(19); f.paint(20); f.flush();
      expect(f.discarded()).toBe(true);
    } finally { f.cleanup(); }
  });

  test("rechecks the viewport before painting if the user scrolls while pages finish", () => {
    const f = fixture();
    try {
      f.paint(19); f.paint(20);
      f.slots.push({ dataset: { pageNo: "21" }, getBoundingClientRect: () => ({ top: 700, bottom: 1000 }) });
      f.flush();
      expect(f.discarded()).toBe(false);
      expect(f.queued).toContain(21);
      f.paint(21); f.flush();
      expect(f.discarded()).toBe(true);
    } finally { f.cleanup(); }
  });

  test("waits for scroll restoration and rejects superseded commits", () => {
    const f = fixture();
    try {
      f.frame.replacementLayoutReady = false;
      f.paint(19); f.paint(20); f.flush();
      expect(f.discarded()).toBe(false);
      f.frame.replacementLayoutReady = true;
      f.frame.trackReplacementPagePaints(f.frame.iframe.contentDocument);
      f.frame.pdfGeneration++;
      f.flush();
      expect(f.discarded()).toBe(false);
    } finally { f.cleanup(); }
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


test("restores a landscape anchor using its real size rather than the first portrait page placeholder", async () => {
  const requested: number[] = [];
  const cleaned: number[] = [];
  const dimensions = await readInitialPdfPageDimensions({
    numPages: 24,
    getPage: async (pageNo: number) => {
      requested.push(pageNo);
      return {
        getViewport: () => pageNo === 18 ? { width: 842, height: 595 } : { width: 595, height: 842 },
        cleanup: () => cleaned.push(pageNo),
      };
    },
  }, 18);
  expect(dimensions.get(18)).toEqual({ width: 842, height: 595 });
  expect(dimensions.get(1)).toEqual({ width: 595, height: 842 });
  expect(dimensions.get(17)).toEqual({ width: 595, height: 842 });
  expect(requested).toEqual([1, 18]);
  expect(cleaned).toEqual([1, 18]);
});


test("queues the saved page anchor and zoom before the reopened preview loads", () => {
  const anchor = { pageNo: 18, pageXRatio: 0.3, pageYRatio: 0.4, viewportXRatio: 0.5, viewportYRatio: 0.5 };
  const frame = Object.assign(Object.create(PreviewFrame.prototype), {});
  frame.restoreWorkspaceScrollPosition(24000, anchor, 215, false);
  // Activating the restored include tab may also queue its legacy pixel offset.
  frame.queueTabScrollPosition(24000);
  expect(frame.pendingRestoredViewportAnchor).toEqual(anchor);
  expect(frame.pendingRestoredScrollTop).toBe(24000);
  expect(frame.currentZoomPercent).toBe(215);
  expect(frame.isFitMode).toBe(false);
});


test("captures the latest live anchor before workspace close clears the preview", () => {
  const actualAnchor = { pageNo: 18, pageXRatio: 0.3, pageYRatio: 0.4, viewportXRatio: 0.5, viewportYRatio: 0.5 };
  const cachedAnchor = { ...actualAnchor, pageNo: 17 };
  let savedTop = 0;
  const app = Object.assign(Object.create(TypsastraWorkspaceController.prototype), {
    previewViewportAnchor: cachedAnchor,
    pdfPreviewRenderController: { lastPdfSurface: "live" },
    layoutController: { isPreviewUndocked: () => false },
    previewController: { pdf: { currentSessionKey: "main", currentViewportAnchor: actualAnchor, currentScrollTop: 29643.5 } },
    recordPreviewScrollPosition: (top: number) => { savedTop = top; },
  });
  app.captureWorkspacePreviewViewport();
  app.previewFrame.currentViewportAnchor = null; // teardown removes the live frame
  expect(app.previewViewportAnchor).toEqual(actualAnchor);
  expect(savedTop).toBe(29643.5);
  app.layoutController.isPreviewUndocked = () => true;
  app.previewFrame.currentViewportAnchor = cachedAnchor;
  app.captureWorkspacePreviewViewport();
  expect(app.previewViewportAnchor).toEqual(actualAnchor);
});
