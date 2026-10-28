import { afterEach, describe, expect, test } from "bun:test";
import type { EditorTab } from "../src/editor/editorTab";
import { EditorTabPresentationController } from "../src/editor/editorTabPresentationController";
import { PreviewContentController } from "../src/preview/previewContentController";
import { PreviewUiController } from "../src/preview/previewUiController";

class FakeClassList {
  private readonly values = new Set<string>();

  add(name: string): void {
    this.values.add(name);
  }

  remove(name: string): void {
    this.values.delete(name);
  }

  toggle(name: string, force?: boolean): boolean {
    const enabled = force ?? !this.values.has(name);
    if (enabled) this.values.add(name);
    else this.values.delete(name);
    return enabled;
  }

  contains(name: string): boolean {
    return this.values.has(name);
  }
}

function fakeElement(): HTMLElement {
  return {
    classList: new FakeClassList(),
    dataset: {},
    style: {},
    textContent: "",
    value: "",
    disabled: false,
    setAttribute: () => {},
    addEventListener: () => {},
  } as unknown as HTMLElement;
}

const previousDocument = globalThis.document;

afterEach(() => {
  Object.defineProperty(globalThis, "document", { configurable: true, value: previousDocument });
});

function installPreviewToolbarDom(): {
  previewActions: HTMLElement;
  pageControls: HTMLElement;
  controls: Map<string, HTMLElement>;
} {
  const previewActions = fakeElement();
  const pageControls = fakeElement();
  const controls = new Map(
    [
      "preview-content-mode-toggle",
      "preview-recompile-btn",
      "preview-search-btn",
      "preview-menu-btn",
      "preview-image-warning-btn",
    ].map(id => [id, fakeElement()]),
  );
  controls.get("preview-image-warning-btn")!.dataset.active = "false";
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      getElementById: (id: string) => controls.get(id) ?? null,
      querySelector: (selector: string) => {
        if (selector === ".preview-actions") return previewActions;
        if (selector === ".preview-page-controls") return pageControls;
        return null;
      },
    },
  });
  return { previewActions, pageControls, controls };
}

function createPreviewUi(): PreviewUiController {
  return new PreviewUiController({
    previewFrame: {
      currentZoomPercent: 100,
      isFitMode: true,
    } as never,
    markdownPreviewFrame: { deactivate: () => {} } as never,
    draftPreview: { updateControl: () => {} } as never,
    imagePreview: { zoomPercent: null, isFit: null } as never,
    tablePreview: { zoomPercent: () => null, isFit: () => null } as never,
    getActiveFilePath: () => "main.typ",
    isInternallySupportedPath: () => true,
    setMarkdownPreviewActive: () => {},
    isDeveloperMode: () => false,
    setLspStatus: () => {},
    log: () => {},
  });
}

describe("image preview toolbar", () => {
  test("activating an image tab keeps live-preview controls hidden", () => {
    const { pageControls, controls } = installPreviewToolbarDom();
    const previewUi = createPreviewUi();
    const rendered: Array<{ source: string; path: string }> = [];
    const presentation = new EditorTabPresentationController({
      editor: () => ({}) as never,
      editorExtensions: () => [],
      currentSettingsEffects: () => [],
      editorLanguageForPath: () => [],
      editorCompletionForPath: () => [],
      fontManager: () => ({}) as never,
      toolbar: () => ({ setDisabled: () => {} }) as never,
      imagePreview: () => ({ clear: () => {} }) as never,
      previewFrame: () => ({
        setLoading: () => {},
        setMessage: () => {},
        setMessageOverlay: () => {},
      }) as never,
      activeMode: () => "CODE",
      workspaceLoading: () => false,
      logSyntax: () => {},
      updatePreviewActionsToolbar: path => previewUi.updateActionsToolbar(path),
      renderNonTextPlaceholder: () => {},
      renderInteractiveImageViewer: (source, previewPath) => {
        rendered.push({ source, path: previewPath });
        // ImagePreviewController.render() refreshes the toolbar for the
        // mounted image, so mirror that contract here.
        previewUi.updateActionsToolbar(previewPath);
      },
      loadPdfPath: () => {},
      applyFoldRanges: () => {},
      clearPreviewPane: () => {},
      clearOutline: () => {},
      mapMarkupToWysiwym: () => {},
    });
    const tab = {
      path: "assets/photo.png",
      content: "data:image/png;base64,AAAA",
      contentLoaded: true,
    } as EditorTab;

    presentation.presentNonText(tab, tab.path, false, false, false, () => {});

    expect(rendered).toEqual([{ source: tab.content, path: tab.path }]);
    expect(pageControls.classList.contains("hidden")).toBe(true);
    expect(controls.get("preview-content-mode-toggle")!.classList.contains("hidden")).toBe(true);
    expect(controls.get("preview-recompile-btn")!.classList.contains("hidden")).toBe(true);
    expect(controls.get("preview-search-btn")!.classList.contains("hidden")).toBe(true);
    expect(controls.get("preview-menu-btn")!.classList.contains("hidden")).toBe(true);
  });

  test("image tool previews without a source path never reuse the active document toolbar", () => {
    const rendered: string[] = [];
    const toolbarPaths: string[] = [];
    const controller = new PreviewContentController({
      previewFrame: {} as never,
      imagePreview: {
        clear: () => {},
        render: (_source: string, previewPath: string) => { rendered.push(previewPath); },
      } as never,
      markdownPreview: {} as never,
      setMarkdownPreviewActive: () => {},
      isImageToolActive: () => true,
      isTableToolActive: () => false,
      getActiveFilePath: () => "main.typ",
      getPinnedMainFilePath: () => null,
      getWorkspaceRootPath: () => null,
      getPreviewSessionKey: () => null,
      getPreviewRenderMode: () => "on-type",
      getActiveTab: () => null,
      getEditorText: () => "",
      isInternallySupportedPath: () => true,
      updateActionsToolbar: path => { toolbarPaths.push(path); },
      prepareTemplateAwarePreview: async target => target,
      ensureLargePreviewApproved: async () => true,
      updatePinnedMain: async () => true,
      applyPreviewTargetToTab: () => {},
      configureDocumentLanguageTools: () => {},
      invalidatePreviewWork: () => {},
      renderPdfPreview: async () => {},
      loadPdfPath: async () => 0,
      setPreviewPaneHtml: () => {},
    });

    controller.renderImageToolPreview("data:image/png;base64,AAAA");

    expect(rendered).toEqual(["image-tools.png"]);
    expect(toolbarPaths).not.toContain("main.typ");
  });
});
