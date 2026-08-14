import { describe, expect, test } from "bun:test";
import {
  tinymistDataPlaneFrameConfirmsSourceMap,
  tinymistDataPlaneFrameKind,
  tinymistDataPlanePositionText
} from "../src/preview/tinymistDataPlane";

const bytes = (value: string) => new TextEncoder().encode(value).buffer;

describe("Tinymist preview data plane", () => {
  test("accepts binary jump frames", async () => {
    expect(await tinymistDataPlanePositionText(bytes("jump,3 56.69 98.25")))
      .toBe("jump,3 56.69 98.25");
  });

  test("ignores binary document frames", async () => {
    expect(await tinymistDataPlaneFrameKind(bytes("new,font and vector payload"))).toBe("document");
    expect(await tinymistDataPlaneFrameKind(bytes("diff-v1,binary payload"))).toBe("document");
    expect(await tinymistDataPlaneFrameKind(bytes("source-map-ready,"))).toBe("document");
    expect(await tinymistDataPlanePositionText(bytes("new,font and vector payload"))).toBeNull();
    expect(await tinymistDataPlanePositionText(bytes("diff-v1,binary payload"))).toBeNull();
    expect(await tinymistDataPlanePositionText(bytes("source-map-ready,"))).toBeNull();
  });

  test("classifies source-map and unknown frames without decoding document payloads", async () => {
    expect(await tinymistDataPlaneFrameKind(bytes("jump,3 56.69 98.25"))).toBe("position");
    expect(await tinymistDataPlaneFrameKind("viewport,2 10 20")).toBe("position");
    expect(await tinymistDataPlaneFrameKind(bytes("proxy-ready,"))).toBe("transport");
    expect(await tinymistDataPlaneFrameKind(bytes("outline,payload"))).toBe("unknown");
  });

  test("accepts either a document update or resolved position as source-map readiness", () => {
    expect(tinymistDataPlaneFrameConfirmsSourceMap("document")).toBeTrue();
    expect(tinymistDataPlaneFrameConfirmsSourceMap("position")).toBeTrue();
    expect(tinymistDataPlaneFrameConfirmsSourceMap("transport")).toBeFalse();
    expect(tinymistDataPlaneFrameConfirmsSourceMap("unknown")).toBeFalse();
  });

  test("keeps retrying warm-up scheduling while a reloaded project initializes", async () => {
    const source = await Bun.file(
      new URL("../src/preview/previewSyncController.ts", import.meta.url),
    ).text();
    const scheduleStart = source.indexOf("  public scheduleWarmup");
    const scheduleEnd = source.indexOf("\n  private ", scheduleStart + 10);
    const schedule = source.slice(scheduleStart, scheduleEnd);
    expect(schedule).toContain("context.interactionBlocked");
    expect(schedule).toContain("context.previewRunning");
    expect(schedule).toContain("this.dependencies.isReady()");
    expect(schedule).toContain("window.setTimeout(attempt, 250)");
    expect(schedule).toContain("this.dependencies.isLowMemoryMode()");
  });

  test("does not warm a source-map task in low memory mode", async () => {
    const source = await Bun.file(
      new URL("../src/preview/previewSyncController.ts", import.meta.url),
    ).text();
    expect(source).toContain("if (this.dependencies.isLowMemoryMode()) return;");
    expect(source).not.toContain("LOW_MEMORY_SOURCE_MAP_IDLE_MS");
  });

  test("keeps Tinymist stopped for inverse-sync clicks in low memory mode", async () => {
    const appSource = await Bun.file(new URL("../src/appController.ts", import.meta.url)).text();
    const navigationSource = await Bun.file(
      new URL("../src/preview/previewSourceNavigationController.ts", import.meta.url),
    ).text();

    expect(navigationSource).toContain("if (this.deps.isLowMemoryMode())");
    expect(navigationSource).toContain("use the document outline for preview navigation");
    expect(appSource).not.toContain("Starting temporary inverse sync");
    expect(appSource).not.toContain("temporary inverse sync released");
  });

  test("loads the prepared source identity before the first cache-backed forward sync", async () => {
    const source = await Bun.file(
      new URL("../src/preview/previewSourceNavigationController.ts", import.meta.url),
    ).text();
    const targetStart = source.indexOf("  public async forwardSyncTarget");
    const targetEnd = source.indexOf("\n  public ", targetStart + 10);
    const target = source.slice(targetStart, targetEnd);
    expect(target).toContain("this.deps.isRenderCachePath(this.deps.getSourceMapRootPath()");
    expect(target).toContain("await this.deps.pdfGeneratedPreviewText");
    expect(target).toContain("Loaded prepared source identity before forward sync");
  });
});
