import { describe, expect, test } from "bun:test";
import { PreviewFreshnessController, renderPreviewFreshnessBanner } from "../src/preview/previewFreshnessController";
import { PreviewFrame } from "../src/preview/previewFrame";
import { normalizeAppSettings } from "../src/settings";
import { PdfPreviewRenderController } from "../src/preview/pdfPreviewRenderController";
import { TypsastraWorkspaceController } from "../src/appController";

describe("preview freshness", () => {
  test("source errors keep the banner visible and disable only its recompile action", () => {
    const button = { disabled: false, title: "", onclick: () => {} };
    const label = { textContent: "" };
    const banner = { hidden: true, dataset: {}, querySelector: (selector: string) => selector.includes("recompile") ? button : selector.includes("label") ? label : null };
    let clicks = 0;
    const toolbar = { disabled: false, title: "", click: () => clicks++ };
    const root = { getElementById: (id: string) => id === "preview-status-banner" ? banner : id === "preview-recompile-btn" ? toolbar : null } as unknown as Document;
    const freshness = new PreviewFreshnessController();
    freshness.editorChanged("main.typ", "valid", "invalid");
    freshness.setLspErrors(true);
    renderPreviewFreshnessBanner(freshness.state, root);
    expect(banner.hidden).toBe(false);
    expect(button.disabled).toBe(true);
    expect(toolbar.disabled).toBe(true);
    expect(label.textContent).toBe("Source changed - preview outdated");
    button.onclick();
    expect(clicks).toBe(0);
    freshness.setLspErrors(false);
    renderPreviewFreshnessBanner(freshness.state, root);
    expect(button.disabled).toBe(false);
    expect(toolbar.disabled).toBe(false);
    button.onclick();
    expect(clicks).toBe(1);
  });
  test("programmatic recompile actions cannot bypass LSP errors", async () => {
    const freshness = new PreviewFreshnessController();
    freshness.setLspErrors(true);
    const app = Object.assign(Object.create(TypsastraWorkspaceController.prototype), { previewFreshness: freshness });
    // No active document or restart dependencies are available: the shared
    // action must reject the request before accessing them.
    await app.recompilePreviewManually();
    expect(freshness.state.lspErrors).toBe(true);
    expect(freshness.state.status).toBe("current");
  });
  test("compiler error panel defaults off and can reveal or hide the latest error", () => {
    expect(normalizeAppSettings({}).preview.showErrorPanel).toBe(false);
    expect(normalizeAppSettings({ preview: { showErrorPanel: true } }).preview.showErrorPanel).toBe(true);
    let presented = 0;
    let loadingCleared = 0;
    const frame = Object.assign(Object.create(PreviewFrame.prototype), {
      compilerErrorPanelEnabled: false, errorOverlay: null,
      clearLoadingHost: () => loadingCleared++,
    });
    frame.setCompilerError("Error", "Invalid source", { displayPath: (path: string) => path, navigate: () => {} });
    expect(loadingCleared).toBe(1);
    frame.presentCompilerError = () => { presented++; frame.errorOverlay = { remove: () => {} }; };
    frame.setCompilerErrorPanelEnabled(true);
    expect(presented).toBe(1);
    frame.setCompilerErrorPanelEnabled(false);
    expect(frame.errorOverlay).toBeNull();
    frame.clearErrorOverlay();
    frame.setCompilerErrorPanelEnabled(true);
    expect(presented).toBe(1);
  });
  test("hides freshness status for Typst files that do not participate in the preview", () => {
    const previousDocument = globalThis.document;
    const attributes = new Map<string, string>();
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: {
        getElementById: (id: string) => id === "preview-container-wrapper"
          ? { setAttribute: (name: string, value: string) => attributes.set(name, value) }
          : null,
      },
    });
    try {
      const app = Object.assign(Object.create(TypsastraWorkspaceController.prototype), {
        previewFreshness: new PreviewFreshnessController(),
        previewUiController: { updateActionsToolbar: () => {} },
        previewSessionController: { disabled: true },
      });
      app.updatePreviewActionsToolbar("C:/project/copied.typ");
      expect(attributes.get("data-preview-status-enabled")).toBe("false");

      app.previewSessionController.disabled = false;
      app.updatePreviewActionsToolbar("C:/project/included.typ");
      expect(attributes.get("data-preview-status-enabled")).toBe("true");
    } finally {
      Object.defineProperty(globalThis, "document", { configurable: true, value: previousDocument });
    }
  });

  test("undo clears source changed only when every edited file matches the preview", () => {
    const freshness = new PreviewFreshnessController();
    freshness.editorChanged("main.typ", "main", "edited main");
    freshness.editorChanged("include.typ", "include", "edited include");
    freshness.editorChanged("main.typ", "edited main", "main");
    expect(freshness.state.status).toBe("outdated");
    freshness.editorChanged("include.typ", "edited include", "include");
    expect(freshness.state.status).toBe("current");
    freshness.editorChanged("main.typ", "main", "edited main");
    expect(freshness.state.status).toBe("outdated");
  });
  test("undo cannot hide changes to an externally edited file", () => {
    const freshness = new PreviewFreshnessController();
    freshness.editorChanged("main.typ", "main", "edited");
    freshness.changed("data.json", true);
    freshness.editorChanged("main.typ", "edited", "main");
    expect(freshness.state.status).toBe("outdated");
    expect(freshness.state.externalFiles).toEqual(["data.json"]);
  });
  test("successful compilation replaces the undo baseline", () => {
    const freshness = new PreviewFreshnessController();
    freshness.editorChanged("main.typ", "old", "compiled");
    freshness.finish(freshness.begin(), true);
    freshness.editorChanged("main.typ", "compiled", "old");
    expect(freshness.state.status).toBe("outdated");
    freshness.editorChanged("main.typ", "old", "compiled");
    expect(freshness.state.status).toBe("current");
  });
  test("undo during a cancelled on-type compile restores the prior preview status", () => {
    const freshness = new PreviewFreshnessController();
    freshness.editorChanged("main.typ", "old", "new");
    const token = freshness.begin();
    freshness.editorChanged("main.typ", "new", "old");
    freshness.interrupted(token);
    expect(freshness.state.status).toBe("current");
  });
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
      controller.deps.freshness.editorChanged("main.typ", "compiled", "unsaved edit");
      await controller.restore("unsaved edit");
      expect(compileRequests).toBe(0);
      expect(controller.deps.freshness.state.status).toBe("outdated");
      controller.deps.freshness.changed("data.json", true);
      controller.runningValue = true;
      await controller.restore("unsaved edit");
      expect(compileRequests).toBe(0);
      expect(controller.deps.freshness.state.externalFiles).toEqual(["data.json"]);
      controller.runningValue = false;
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
      deps: {
        freshness,
        preparation: { isPreviewDependency: () => true },
      },
      externalRevision: 0, queuedContents: "old snapshot", queuedForced: false,
      cancelOnTypeSchedule: () => { cancellations++; },
    });
    controller.noteExternalSourceChange("chapter.typ");
    expect(controller.queuedContents).toBeNull();
    expect(cancellations).toBe(1);
    expect(freshness.state.status).toBe("outdated");
  });
  test("ignores external changes outside the main preview dependency graph", () => {
    const freshness = new PreviewFreshnessController();
    let cancellations = 0;
    const controller = Object.assign(Object.create(PdfPreviewRenderController.prototype), {
      deps: {
        freshness,
        preparation: {
          isPreviewDependency: (path: string) => path === "C:/project/main.typ",
        },
      },
      externalRevision: 0, queuedContents: "old snapshot", queuedForced: false,
      cancelOnTypeSchedule: () => { cancellations++; },
    });

    controller.noteExternalSourceChange("C:/project/copied.typ");
    expect(controller.externalRevision).toBe(0);
    expect(controller.queuedContents).toBe("old snapshot");
    expect(cancellations).toBe(0);
    expect(freshness.state.status).toBe("current");
    expect(freshness.state.externalFiles).toEqual([]);

    controller.noteExternalSourceChange("C:/project/main.typ");
    expect(controller.externalRevision).toBe(1);
    expect(controller.queuedContents).toBeNull();
    expect(cancellations).toBe(1);
    expect(freshness.state.status).toBe("outdated");
    expect(freshness.state.externalFiles).toEqual(["C:/project/main.typ"]);
  });
  test("adopting an active external source does not invoke the editor's automatic compilation path", () => {
    const changes: string[] = [];
    const app = Object.assign(Object.create(TypsastraWorkspaceController.prototype), {
      editorSessionController: { activeFilePath: "main.typ" }, activeMode: "CODE",
      pdfPreviewRenderController: { noteExternalSourceChange: (path: string) => changes.push(path) },
      diagnosticsController: { clearForPath: () => {} },
      projectTextService: { invalidate: () => {} },
      lspSyncController: { queueContentMutation: () => {} },
      scheduleDocumentOutlineUpdate: () => {},
      handleContentMutation: () => { throw new Error("External reload must not trigger an editor mutation"); },
    });
    app.handleExternalSourceChange({ path: "main.typ", content: "external content" });
    expect(changes).toEqual(["main.typ"]);
  });
});
