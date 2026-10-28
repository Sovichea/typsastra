import { describe, expect, test } from "bun:test";
import { PreviewFreshnessController } from "../src/preview/previewFreshnessController";
import { PdfPreviewRenderController } from "../src/preview/pdfPreviewRenderController";
import { TypsastraWorkspaceController } from "../src/appController";

describe("preview freshness", () => {
  test("returning from other preview surfaces restores the current live PDF without compiling", async () => {
    for (const mounted of [true, false]) {
      let loads = 0;
      let preserved = 0;
      const controller = Object.assign(Object.create(PdfPreviewRenderController.prototype), {
        runningValue: false,
        lastPdfSurfaceValue: mounted ? "live" : "pdf", lastPdfPathValue: mounted ? "snapshot.pdf" : "other.pdf",
        liveSnapshot: { path: "snapshot.pdf", identity: "cache/render/main.typ", sourceRoot: "main.typ", sessionKey: "main", mode: "normal", lease: null },
        hasLiveViewportValue: true, liveViewportAnchorValue: null, liveScrollTopValue: 350,
        deps: {
          log: () => {}, isLowMemoryMode: () => false,
          getActiveFilePath: () => "main.typ", getPinnedMainFilePath: () => "main.typ",
          getPreviewRootPath: () => "main.typ", getPreviewSessionKey: () => "main",
          isPreviewImported: () => false, isPreviewDisabled: () => false,
          freshness: new PreviewFreshnessController(), draftPreview: { mode: "normal" },
          typography: { fontUpdateInProgress: false },
          previewFrame: {
            retainMountedLivePreview: (identity: string) => { expect(identity).toBe("cache/render/main.typ"); return mounted; },
            preserveViewportForNextLoad: () => { preserved++; },
          },
        },
        loadPdfPath: async (path: string) => { expect(path).toBe("snapshot.pdf"); loads++; },
      });
      await controller.render("unchanged source");
      expect(loads).toBe(mounted ? 0 : 1);
      expect(preserved).toBe(mounted ? 0 : 1);
      let compileRequests = 0;
      controller.deps.ensureLargePreviewApproved = async () => { compileRequests++; return false; };
      await controller.render("unchanged source", true);
      expect(compileRequests).toBe(1);
      controller.deps.freshness.changed("main.typ");
      await controller.render("new source");
      expect(compileRequests).toBe(2);
      const token = controller.deps.freshness.begin();
      controller.deps.freshness.finish(token, true);
      controller.deps.draftPreview.mode = "draft";
      await controller.render("unchanged source");
      expect(compileRequests).toBe(3);
      controller.deps.draftPreview.mode = "normal";
      controller.liveSnapshot = null;
      await controller.render("first project open");
      expect(compileRequests).toBe(4);
    }
  });
  test("stays outdated across multiple external files until a current compile succeeds", () => {
    const freshness = new PreviewFreshnessController();
    freshness.changed("main.typ", true);
    freshness.changed("chapter.typ", true);
    freshness.changed("chapter.typ", true);
    expect(freshness.state).toEqual({ status: "outdated", externalFiles: ["main.typ", "chapter.typ"] });
    const token = freshness.begin();
    expect(freshness.state.status).toBe("compiling");
    freshness.finish(token, true);
    expect(freshness.state).toEqual({ status: "current", externalFiles: [] });
  });
  test("a newer external revision cannot be marked current by an older compile", () => {
    const freshness = new PreviewFreshnessController();
    const token = freshness.begin();
    freshness.changed("chapter.typ", true);
    freshness.finish(token, true);
    expect(freshness.state.status).toBe("outdated");
    const retry = freshness.begin();
    freshness.finish(retry, false);
    expect(freshness.state.status).toBe("failed");
    expect(freshness.state.externalFiles).toEqual(["chapter.typ"]);
  });
  test("late completion or interruption cannot alter a newer workspace compilation", () => {
    const freshness = new PreviewFreshnessController();
    const old = freshness.begin();
    freshness.reset();
    const current = freshness.begin();
    freshness.finish(old, true);
    freshness.interrupted(old);
    expect(freshness.state.status).toBe("compiling");
    freshness.finish(current, true);
    expect(freshness.state.status).toBe("current");
  });
  test("external adoption cancels pending automatic work without scheduling a compilation", () => {
    const freshness = new PreviewFreshnessController();
    let cancellations = 0;
    const controller = Object.assign(Object.create(PdfPreviewRenderController.prototype), {
      deps: { freshness }, externalRevision: 0, queuedContents: "old snapshot", queuedForced: false,
      cancelOnTypeSchedule: () => { cancellations++; },
    });
    controller.noteExternalSourceChange("chapter.typ");
    expect(controller.queuedContents).toBeNull();
    expect(cancellations).toBe(1);
    expect(freshness.state.status).toBe("outdated");
  });
  test("adopting an active external source does not invoke the editor's automatic compilation path", () => {
    const changes: string[] = [];
    const app = Object.assign(Object.create(TypsastraWorkspaceController.prototype), {
      editorSessionController: { activeFilePath: "main.typ" }, activeMode: "CODE",
      pdfPreviewRenderController: { noteExternalSourceChange: (path: string) => changes.push(path) },
      scheduleDocumentOutlineUpdate: () => {},
      handleContentMutation: () => { throw new Error("External reload must not trigger an editor mutation"); },
    });
    app.handleExternalSourceChange({ path: "main.typ", content: "external content" });
    expect(changes).toEqual(["main.typ"]);
  });
});
