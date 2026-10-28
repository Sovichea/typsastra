import { describe, expect, test } from "bun:test";
import { PreviewFrame } from "../src/preview/previewFrame";

function fixture() {
  let clicks = 0;
  const marker = { getBoundingClientRect: () => ({ left: 20, right: 100, top: 100, bottom: 120, width: 80, height: 20 }) };
  const slots = [1, 2].map(pageNo => ({
    dataset: { pageNo: String(pageNo) }, offsetTop: (pageNo - 1) * 800,
    querySelector: () => marker,
  }));
  const doc = {
    documentElement: { dataset: { previewSurface: "live" } as Record<string, string> },
    getElementById: () => null,
    querySelector: (selector: string) => selector.includes('"2"') ? slots[1] : slots[0],
  };
  const frame = Object.assign(Object.create(PreviewFrame.prototype), {
    pdfGeneration: 1, standalonePdfSearchGeneration: 0,
    pdfDoc: { numPages: 2, getPage: async () => ({
      getTextContent: async () => ({ items: [{ str: "Shared token in an included file", hasEOL: true }] }),
    }) },
    iframe: { contentDocument: doc, contentWindow: { innerHeight: 600, innerWidth: 800, scrollY: 0 } },
    standalonePdfSearchMatches: [], standalonePdfSearchIndex: -1,
    standalonePdfTextLayers: new Map(),
    updateStandalonePdfSearchCount() {}, renderAllStandalonePdfSearchMarkers() {},
    updateStandalonePdfCurrentMarkers() {}, ensureLiveSearchTextLayers: async () => {},
    onPreviewClick: () => { clicks++; },
  });
  return { frame, doc, slots, marker, clicks: () => clicks };
}

describe("live preview PDF search", () => {
  test("searches the compiled document and navigates results without triggering inverse sync", async () => {
    const f = fixture();
    await f.frame.searchStandalonePdf("shared token");
    expect(f.frame.standalonePdfSearchMatches.map((match: { pageNo: number }) => match.pageNo)).toEqual([1, 2]);
    expect(f.frame.standalonePdfSearchIndex).toBe(0);
    f.frame.stepStandalonePdfSearch(1);
    expect(f.frame.standalonePdfSearchIndex).toBe(1);
    f.frame.stepStandalonePdfSearch(-1);
    expect(f.frame.standalonePdfSearchIndex).toBe(0);
    expect(f.clicks()).toBe(0);
  });

  test("allows search in both PDF surfaces while retaining standalone-only selection policy", () => {
    const f = fixture();
    expect(f.frame.isSearchablePdfSurface()).toBe(true);
    expect(f.frame.isStandalonePdfSurface()).toBe(false);
    f.doc.documentElement.dataset.previewSurface = "pdf";
    expect(f.frame.isSearchablePdfSurface()).toBe(true);
    expect(f.frame.isStandalonePdfSurface()).toBe(true);
    f.doc.documentElement.dataset.pdfReplacing = "true";
    expect(f.frame.isSearchablePdfSurface()).toBe(false);
  });

  test("discards an asynchronous query after recompilation replaces its document", async () => {
    const f = fixture();
    let resolve!: (value: { items: { str: string }[] }) => void;
    f.frame.pdfDoc.getPage = async () => ({ getTextContent: () => new Promise(done => { resolve = done; }) });
    const query = f.frame.searchStandalonePdf("shared token");
    await Promise.resolve();
    f.frame.pdfGeneration++;
    resolve({ items: [{ str: "shared token" }] });
    await query;
    expect(f.frame.standalonePdfSearchMatches).toEqual([]);
    expect(f.clicks()).toBe(0);
  });

  test("reveals an offscreen match after its virtualized text layer has rendered", () => {
    const f = fixture();
    let rendered = false;
    let reveals = 0;
    f.frame.standalonePdfSearchMatches = [{ pageNo: 2, fragments: [] }];
    f.frame.standalonePdfSearchIndex = 0;
    f.slots[1].querySelector = () => rendered ? f.marker : null;
    Object.assign(f.slots[1], { querySelectorAll: () => [], getBoundingClientRect: () => ({ left: 0, top: 0 }) });
    f.frame.scrollStandalonePdfViewport = () => {};
    f.frame.queuePageRender = () => {};
    f.frame.revealStandalonePdfMarker = () => { reveals++; };
    f.frame.revealStandalonePdfSearchMatch();
    expect(reveals).toBe(0);
    f.frame.standalonePdfTextLayers.set(2, { container: { closest: () => f.slots[1] }, textItems: [], textDivs: [] });
    rendered = true;
    f.frame.renderStandalonePdfSearchMarkers(2);
    expect(reveals).toBe(1);
    expect(f.clicks()).toBe(0);
  });
});
