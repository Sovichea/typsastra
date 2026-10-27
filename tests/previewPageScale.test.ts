import { describe, expect, test } from "bun:test";
import { previewPageScale } from "../src/preview/previewPageScale";
import { PreviewFrame } from "../src/preview/previewFrame";

const portrait = { width: 595, height: 842 };
const landscape = { width: 1190, height: 842 };

describe("mixed-orientation PDF sizing", () => {
  test("fit mode gives landscape pages 30 percent more width without overflowing", () => {
    const availableWidth = 744;
    const portraitScale = previewPageScale(portrait.width, availableWidth, true, 90, portrait.height, true);
    const landscapeScale = previewPageScale(landscape.width, availableWidth, true, 90, landscape.height, true);
    expect(portrait.width * portraitScale).toBeCloseTo(availableWidth / 1.3);
    expect(landscape.width * landscapeScale).toBeCloseTo(availableWidth);
    expect(landscape.height * landscapeScale).toBeCloseTo(portrait.height * portraitScale * 0.65);
  });

  test("supports a configurable landscape increase, including equal-width pages", () => {
    for (const increase of [0, 20, 50, 100]) {
      const portraitScale = previewPageScale(portrait.width, 744, true, 90, portrait.height, true, increase);
      const landscapeScale = previewPageScale(landscape.width, 744, true, 90, landscape.height, true, increase);
      expect(landscape.width * landscapeScale / (portrait.width * portraitScale)).toBeCloseTo(1 + increase / 100);
      expect(landscape.width * landscapeScale).toBeCloseTo(744);
    }
  });

  test("manual zoom preserves physical page proportions", () => {
    expect(previewPageScale(portrait.width, 744, false, 125)).toBe(1.25);
    expect(previewPageScale(landscape.width, 744, false, 125)).toBe(1.25);
  });

  test("uses the zoom fallback before dimensions or layout are available", () => {
    expect(previewPageScale(undefined, 744, true, 90)).toBe(0.9);
    expect(previewPageScale(0, 744, true, 90)).toBe(0.9);
    expect(previewPageScale(595, 0, true, 90)).toBe(0.9);
  });

  test("changing the setting immediately refits around the current viewport anchor", () => {
    const frame = Object.create(PreviewFrame.prototype) as PreviewFrame;
    const anchor = { pageNo: 4, pageYRatio: 0.5 };
    const restored: unknown[] = [];
    Object.assign(frame, {
      landscapeScalePercent: 30, pdfDoc: {}, isFitToWidth: true,
      landscapePages: new Set([4]),
      captureScrollAnchor: () => anchor,
      applyFitToWidth: (preserved: unknown) => restored.push(preserved),
    });
    frame.setLandscapeScalePercent(50);
    expect(restored).toEqual([anchor]);
    frame.setLandscapeScalePercent(50);
    expect(restored).toHaveLength(1);
    Object.assign(frame, { isFitToWidth: false });
    frame.setLandscapeScalePercent(60);
    expect(restored).toHaveLength(1);
  });

  test("page slots and inverse sync use the same per-page scale", () => {
    const frame = Object.create(PreviewFrame.prototype) as PreviewFrame;
    const slots = [portrait, landscape].map((_, index) => ({
      dataset: { pageNo: String(index + 1) }, style: { width: "", height: "" },
      getBoundingClientRect: () => ({ left: 10, top: 20 }),
    }));
    Object.assign(frame, {
      pane: { clientWidth: 800 },
      isFitToWidth: true,
      previewZoomPercent: 90,
      landscapePages: new Set([2]),
      pageDimensions: new Map([[1, portrait], [2, landscape]]),
      iframe: { contentDocument: { querySelectorAll: () => slots } },
    });
    const internals = frame as unknown as {
      layoutPageSlots(options: { preserveExistingPages: boolean }): void;
      pdfDocumentPointAtClick(pageNo: number, slot: unknown, event: unknown): { documentPosition: { x: number; y: number } };
      currentPageRenderKey(generation: number, pageNo: number): string;
      pageOutputScale(): number;
    };
    internals.pageOutputScale = () => 2;
    internals.layoutPageSlots({ preserveExistingPages: true });
    expect(parseFloat(slots[0].style.width)).toBeCloseTo(744 / 1.3);
    expect(parseFloat(slots[1].style.width)).toBeCloseTo(744);
    expect(parseFloat(slots[1].style.height)).toBeCloseTo(parseFloat(slots[0].style.height) * 0.65);
    for (const [index, dimensions] of [portrait, landscape].entries()) {
      const scale = (index === 0 ? 744 / 1.3 : 744) / dimensions.width;
      const point = internals.pdfDocumentPointAtClick(index + 1, slots[index], {
        clientX: 10 + 100 * scale,
        clientY: 20 + 200 * scale,
      });
      expect(point.documentPosition.x).toBeCloseTo(100);
      expect(point.documentPosition.y).toBeCloseTo(200);
    }
    expect(internals.currentPageRenderKey(1, 1)).not.toBe(internals.currentPageRenderKey(1, 2));
  });
});
