import type { Extension, StateEffect, StateField } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { forceParsing, Language, syntaxTree, syntaxTreeAvailable } from "@codemirror/language";
import type { EditorFontManager } from "./fontManager";
import type { EditorToolbarController } from "./toolbarController";
import type { EditorTab } from "./editorTab";
import type { ImagePreviewController } from "../preview/imagePreviewController";
import type { PreviewFrame } from "../preview/previewFrame";
import { isBinaryImagePath } from "../platform/fileTypes";
import { completionCompartment, languageCompartment } from "./extensions";
import { createTabEditorState } from "./tabHistory";
import { prepareVisibleBracketColors } from "./bracketColorizer";

interface ViewportParseContext {
  treeLen: number;
  viewport: { from: number; to: number };
  updateViewport(viewport: { from: number; to: number }): boolean;
  reset(): void;
  isDone(upto: number): boolean;
  work(timeout: number, upto?: number): boolean;
  takeTree(): void;
}

interface ViewportLanguageState {
  context?: ViewportParseContext;
}

export interface EditorTabPresentationDependencies {
  editor(): EditorView;
  editorExtensions(): Extension;
  currentSettingsEffects(): readonly StateEffect<unknown>[];
  editorLanguageForPath(path: string): Extension;
  editorCompletionForPath(path: string): Extension;
  fontManager(): EditorFontManager;
  toolbar(): EditorToolbarController;
  imagePreview(): ImagePreviewController;
  previewFrame(): PreviewFrame;
  activeMode(): "CODE" | "WYSIWYM";
  workspaceLoading(): boolean;
  logSyntax(message: string): void;
  updatePreviewActionsToolbar(path: string): void;
  renderNonTextPlaceholder(path: string, unsupported: boolean, source?: string): void;
  renderInteractiveImageViewer(source: string, previewPath: string): void;
  loadPdfPath(path: string): void;
  applyFoldRanges(ranges: { from: number; to: number }[]): void;
  clearPreviewPane(): void;
  clearOutline(): void;
  mapMarkupToWysiwym(contents: string): void;
}

/** Owns editor/preview DOM presentation while a tab is being activated. */
export class EditorTabPresentationController {
  private loading = false;
  private syntaxPresentationGeneration = 0;
  private pendingSyntaxPath: string | null = null;
  private syntaxViewportSeededGeneration = -1;
  private syntaxPrewarmHandle: number | null = null;
  private syntaxPrewarmUsesIdleCallback = false;

  constructor(private readonly deps: EditorTabPresentationDependencies) {}

  get isLoading(): boolean { return this.loading; }
  set isLoading(value: boolean) { this.loading = value; }

  showImageLoading(path: string): void {
    this.deps.imagePreview().clear();
    this.deps.updatePreviewActionsToolbar(path);
    this.deps.previewFrame().setLoading("Preparing image preview…", false);
  }

  presentNonText(
    tab: EditorTab,
    path: string,
    unsupportedFile: boolean,
    isPdf: boolean,
    skipPreviewActivation: boolean,
    beforePreviewActivation: () => void,
  ): void {
    const codeRenderPane = document.getElementById("code-render-pane");
    const imageViewerPane = document.getElementById("image-viewer-pane");
    const imageViewerImg = document.getElementById("image-viewer-img") as HTMLImageElement | null;

    codeRenderPane?.classList.add("hidden");
    imageViewerPane?.classList.remove("hidden");
    if (imageViewerImg) imageViewerImg.style.display = "none";
    this.deps.renderNonTextPlaceholder(path, unsupportedFile, tab.content);
    document.getElementById("wysiwym-editor-pane")?.classList.add("hidden");
    this.deps.imagePreview().clear();
    beforePreviewActivation();

    if (!skipPreviewActivation) {
      this.deps.updatePreviewActionsToolbar(path);
      if (isBinaryImagePath(path)) {
        this.deps.renderInteractiveImageViewer(tab.content, path);
      } else if (isPdf) {
        this.deps.loadPdfPath(path);
      } else {
        this.deps.previewFrame().setMessage(
          `<div class="preview-disabled-placeholder">` +
          `<div class="preview-disabled-title">Preview Unavailable</div>` +
          `<div class="preview-disabled-msg">Open this file with its system application to view it.</div>` +
          `</div>`,
        );
      }
    }
    this.deps.toolbar().setDisabled(true);
  }

  replaceActiveTextContents(tab: EditorTab, contents: string): void {
    const editor = this.deps.editor();
    const selection = editor.state.selection.main;
    this.loading = true;
    tab.editorState = undefined;
    tab.editorStateLanguage = undefined;
    try {
      const editorFontEffect = this.deps.fontManager().prepareDocument(contents);
      editor.setState(createTabEditorState({
        doc: contents,
        anchor: Math.min(selection.anchor, contents.length),
        head: Math.min(selection.head, contents.length),
        extensions: this.deps.editorExtensions(),
      }));
      editor.dispatch({
        effects: [
          ...this.deps.currentSettingsEffects(),
          ...(editorFontEffect ? [editorFontEffect] : []),
          languageCompartment.reconfigure(this.deps.editorLanguageForPath(tab.path)),
          completionCompartment.reconfigure(this.deps.editorCompletionForPath(tab.path)),
        ],
      });
    } finally {
      this.loading = false;
    }
  }

  presentText(tab: EditorTab, path: string): void {
    const codeRenderPane = document.getElementById("code-render-pane");
    const imageViewerPane = document.getElementById("image-viewer-pane");
    const imageViewerImg = document.getElementById("image-viewer-img") as HTMLImageElement | null;

    this.deps.imagePreview().clear();
    this.deps.updatePreviewActionsToolbar(path);
    codeRenderPane?.classList.remove("hidden");
    imageViewerPane?.classList.add("hidden");
    if (imageViewerImg) imageViewerImg.style.display = "block";
    if (this.deps.activeMode() === "WYSIWYM") {
      document.getElementById("wysiwym-editor-pane")?.classList.remove("hidden");
    }

    const ext = path.split(".").pop()?.toLowerCase();
    if (ext === "typ") {
      this.deps.toolbar().setDisabled(false);
    } else {
      this.deps.toolbar().setDisabled(true);
      if (ext === "md" || ext === "markdown") {
        // Markdown owns an overlay renderer. Leave the persistent PDF
        // presentation underneath untouched so returning to Typst is instant.
      } else if (ext === "svg") {
        this.deps.previewFrame().setMessageOverlay(
          `<div style="display:flex;align-items:center;justify-content:center;height:100%;width:100%;background:var(--ui-bg);box-sizing:border-box;padding:20px;overflow:auto;">` +
          tab.content +
          `</div>`,
        );
      } else {
        this.deps.previewFrame().setMessageOverlay(
          `<div class="preview-disabled-placeholder">` +
          `<div class="preview-disabled-icon">🚫</div>` +
          `<div class="preview-disabled-title">Preview Unavailable</div>` +
          `<div class="preview-disabled-msg">Live preview is not supported for ${ext?.toUpperCase() || "this"} files.</div>` +
          `</div>`,
        );
      }
    }

    const editorFontEffect = this.deps.fontManager().prepareDocument(tab.content);
    const editor = this.deps.editor();
    const language = this.editorLanguageKey(path);
    const reusableState = tab.editorState?.doc.toString() === tab.content
      && tab.editorStateLanguage === language
      ? tab.editorState
      : undefined;
    let nextState = reusableState ?? createTabEditorState({
        doc: tab.content,
        anchor: tab.selectionAnchor,
        head: tab.selectionHead,
        extensions: this.deps.editorExtensions(),
        undoHistory: tab.undoHistory,
      });
    nextState = nextState.update({
      effects: [
        ...this.deps.currentSettingsEffects(),
        ...(editorFontEffect ? [editorFontEffect] : []),
        ...(reusableState
          ? []
          : [languageCompartment.reconfigure(this.deps.editorLanguageForPath(path))]),
        completionCompartment.reconfigure(this.deps.editorCompletionForPath(path)),
      ],
    }).state;

    this.cancelSyntaxPrewarm();
    ++this.syntaxPresentationGeneration;
    // View plugins (including bracket colors) are recreated by setState even
    // when the immutable syntax state is retained. Keep the next tab hidden
    // until its restored viewport has both syntax and bracket decorations.
    if (ext === "typ") {
      editor.dom.classList.add("editor-syntax-preparing");
      this.pendingSyntaxPath = path;
      this.deps.logSyntax(
        `Presentation queued: path=${path}; generation=${this.syntaxPresentationGeneration}; ` +
        `docUtf16=${nextState.doc.length}; reusableState=${reusableState !== undefined}; ` +
        `workspaceLoading=${this.deps.workspaceLoading()}; savedSelection=${tab.selectionAnchor}:${tab.selectionHead}; ` +
        `savedScroll=${(tab.scrollTop ?? 0).toFixed(0)}:${(tab.scrollLeft ?? 0).toFixed(0)}.`,
      );
    } else {
      editor.dom.classList.remove("editor-syntax-preparing");
      this.pendingSyntaxPath = null;
    }
    editor.setState(nextState);
    tab.editorState = nextState;
    tab.editorStateLanguage = language;
  }

  finishTextPresentation(path: string): void {
    if (this.pendingSyntaxPath !== path) {
      this.deps.logSyntax(
        `Presentation finish ignored: requested=${path}; pending=${this.pendingSyntaxPath ?? "none"}.`,
      );
      return;
    }
    // Workspace restoration activates the tab while the editor pane is still
    // hidden. Its visible range is therefore the temporary top-of-document
    // range, not the persisted scroll destination. Keep the syntax cover in
    // place until WorkspaceLifecycleController restores the viewport after
    // the real layout becomes visible and calls this method again.
    if (this.deps.workspaceLoading()) {
      this.deps.logSyntax(
        `Presentation deferred until workspace layout restoration: path=${path}; ` +
        `${this.editorSnapshot(this.deps.editor())}.`,
      );
      return;
    }
    const editor = this.deps.editor();
    const visibleTo = editor.visibleRanges.reduce((maximum, range) => Math.max(maximum, range.to), 0);
    // Restoring a retained state often already painted this viewport. Avoid
    // hiding it for another measure and several animation frames.
    if (editor.visibleRanges.length > 0 && syntaxTreeAvailable(editor.state, visibleTo)
      && prepareVisibleBracketColors(editor)) {
      this.pendingSyntaxPath = null;
      editor.dom.classList.remove("editor-syntax-preparing");
      this.deps.logSyntax(`Visible syntax reused immediately: path=${path}; visibleTo=${visibleTo}.`);
      this.scheduleSyntaxPrewarm(editor, this.syntaxPresentationGeneration, visibleTo);
      return;
    }
    this.seedColdSyntaxAtDistantViewport(path);
    this.revealAfterVisibleSyntaxIsReady(
      this.deps.editor(),
      this.syntaxPresentationGeneration,
      path,
    );
  }

  /**
   * StreamLanguage normally starts parsing at the top of a new document. If
   * the persisted viewport is restored only after that parse has started, the
   * already-running parser keeps walking every intervening line. Reset that
   * parse after CodeMirror has received the real viewport. The retained prefix
   * fragment then lets StreamLanguage's built-in `skipUntilInView` path jump
   * directly to a distant viewport.
   *
   * CodeMirror doesn't currently expose this parse-context reset as public
   * API. Keep the compatibility bridge local and fail safely if a future
   * CodeMirror release changes its internal language-state shape.
   */
  private seedColdSyntaxAtDistantViewport(path: string): void {
    const generation = this.syntaxPresentationGeneration;
    if (this.syntaxViewportSeededGeneration === generation) return;

    const editor = this.deps.editor();
    const visibleFrom = editor.visibleRanges.reduce(
      (minimum, range) => Math.min(minimum, range.from),
      editor.state.doc.length,
    );
    const parsedTo = syntaxTree(editor.state).length;
    if (visibleFrom - parsedTo <= 100_000) return;

    const context = this.languageParseContext(editor);
    if (!context || typeof context.reset !== "function" || typeof context.updateViewport !== "function") {
      this.deps.logSyntax(
        `Cold syntax viewport seed unavailable: path=${path}; generation=${generation}; ` +
        `parsedTo=${parsedTo}; visibleFrom=${visibleFrom}.`,
      );
      return;
    }

    this.syntaxViewportSeededGeneration = generation;
    const viewport = { from: visibleFrom, to: Math.max(visibleFrom, editor.viewport.to) };
    context.updateViewport(viewport);
    context.reset();
    this.deps.logSyntax(
      `Cold syntax seeded at restored viewport: path=${path}; generation=${generation}; ` +
      `parsedTo=${parsedTo}; visibleFrom=${visibleFrom}; distance=${visibleFrom - parsedTo}; ` +
      `parseViewport=${context.viewport.from}:${context.viewport.to}; treeLen=${context.treeLen}.`,
    );
  }
  presentEmpty(): void {
    const editor = this.deps.editor();
    this.cancelSyntaxPrewarm();
    ++this.syntaxPresentationGeneration;
    this.pendingSyntaxPath = null;
    editor.dom.classList.remove("editor-syntax-preparing");
    this.loading = true;
    try {
      editor.setState(createTabEditorState({
        doc: "",
        anchor: 0,
        head: 0,
        extensions: this.deps.editorExtensions(),
      }));
      editor.dispatch({ effects: this.deps.currentSettingsEffects() });
      this.deps.applyFoldRanges([]);
    } finally {
      this.loading = false;
    }
    this.deps.clearPreviewPane();
    this.deps.previewFrame().clear();
    this.deps.fontManager().updateDocument("");
    this.deps.clearOutline();
    if (this.deps.activeMode() === "WYSIWYM") {
      this.deps.mapMarkupToWysiwym("");
    }
  }

  private revealAfterVisibleSyntaxIsReady(
    editor: EditorView,
    generation: number,
    path: string,
  ): void {
    const startedAt = performance.now();
    let attempts = 0;
    let lastProgressAt = -Infinity;
    let lastViewport = "";
    this.deps.logSyntax(
      `Visible syntax gate started: path=${path}; generation=${generation}; ${this.editorSnapshot(editor)}.`,
    );
    const attempt = () => {
      if (generation !== this.syntaxPresentationGeneration) {
        this.deps.logSyntax(
          `Visible syntax gate cancelled: path=${path}; generation=${generation}; ` +
          `currentGeneration=${this.syntaxPresentationGeneration}; elapsedMs=${(performance.now() - startedAt).toFixed(1)}.`,
        );
        return;
      }
      attempts += 1;
      const visibleFrom = editor.visibleRanges.reduce(
        (minimum, range) => Math.min(minimum, range.from),
        editor.state.doc.length,
      );
      const visibleTo = editor.visibleRanges.reduce(
        (maximum, range) => Math.max(maximum, range.to),
        0,
      );
      const viewport = `${visibleFrom}:${visibleTo}`;
      if (viewport !== lastViewport) {
        this.deps.logSyntax(
          `Visible viewport changed during syntax gate: path=${path}; viewport=${viewport}; ` +
          `scrollTop=${editor.scrollDOM.scrollTop.toFixed(1)}; attempt=${attempts}.`,
        );
        lastViewport = viewport;
      }
      const syntaxReady = this.parseVisibleSyntax(
        editor,
        generation,
        visibleFrom,
        visibleTo,
        24,
      );
      if (syntaxReady && this.syntaxViewportSeededGeneration !== generation) {
        // StreamLanguage may finish a forced parse without producing a view
        // update when its parse context already exposes the resulting tree.
        // The next unrelated transaction (commonly the first Tinymist
        // diagnostics notification) would then be the event that finally
        // projects syntax highlighting into the DOM. Publish an editor update
        // ourselves so presentation never depends on LSP startup timing.
        editor.dispatch({});
      }
      const bracketsReady = syntaxReady && prepareVisibleBracketColors(editor);
      if (!syntaxReady || !bracketsReady) {
        const now = performance.now();
        if (now - lastProgressAt >= 250) {
          lastProgressAt = now;
          this.deps.logSyntax(
            `Visible syntax pending: path=${path}; elapsedMs=${(now - startedAt).toFixed(1)}; ` +
            `attempt=${attempts}; viewport=${viewport}; syntaxReady=${syntaxReady}; ` +
            `treeAvailable=${syntaxTreeAvailable(editor.state, visibleTo)}; ` +
            `treeLength=${syntaxTree(editor.state).length}; bracketsReady=${bracketsReady}; ` +
            `renderedSpans=${this.renderedSpanCount(editor)}.`,
          );
        }
        requestAnimationFrame(attempt);
        return;
      }

      // `forceParsing` publishes the tree synchronously, but CodeMirror's
      // highlighter still needs a measure/write pass to project that tree into
      // the viewport DOM. Releasing the cover immediately here briefly paints
      // plain text when a restored tab starts far into a large document.
      // Keep the viewport covered until that projection has completed, and
      // restart if layout restoration moved the visible range meanwhile.
      editor.requestMeasure({
        read: () => ({
          from: editor.visibleRanges.reduce(
            (minimum, range) => Math.min(minimum, range.from),
            editor.state.doc.length,
          ),
          to: editor.visibleRanges.reduce(
            (maximum, range) => Math.max(maximum, range.to),
            0,
          ),
        }),
        write: measured => {
          if (generation !== this.syntaxPresentationGeneration) return;
          if (measured.from !== visibleFrom || measured.to !== visibleTo) {
            requestAnimationFrame(attempt);
            return;
          }
          requestAnimationFrame(() => {
            if (generation !== this.syntaxPresentationGeneration) return;
            const viewportStable = editor.visibleRanges.length > 0
              && editor.visibleRanges[0].from === visibleFrom
              && editor.visibleRanges[editor.visibleRanges.length - 1].to === visibleTo;
            const projected = viewportStable
              && this.parseVisibleSyntax(editor, generation, visibleFrom, visibleTo, 4)
              && prepareVisibleBracketColors(editor);
            if (!projected) {
              requestAnimationFrame(attempt);
              return;
            }
            requestAnimationFrame(() => {
              if (generation !== this.syntaxPresentationGeneration) return;
              this.pendingSyntaxPath = null;
              editor.dom.classList.remove("editor-syntax-preparing");
              this.deps.logSyntax(
                `Visible syntax revealed: path=${path}; elapsedMs=${(performance.now() - startedAt).toFixed(1)}; ` +
                `attempts=${attempts}; ${this.editorSnapshot(editor)}; ` +
                `treeAvailable=${syntaxTreeAvailable(editor.state, visibleTo)}; ` +
                `treeLength=${syntaxTree(editor.state).length}; renderedSpans=${this.renderedSpanCount(editor)}.`,
              );
              this.schedulePostRevealAudit(editor, generation, path, visibleTo, startedAt);
              if (this.syntaxViewportSeededGeneration !== generation) {
                this.scheduleSyntaxPrewarm(editor, generation, visibleTo);
              }
            });
          });
        },
      });
    };
    requestAnimationFrame(attempt);
  }

  private schedulePostRevealAudit(
    editor: EditorView,
    generation: number,
    path: string,
    parsedTo: number,
    startedAt: number,
  ): void {
    for (const delay of [100, 500, 1_500]) {
      window.setTimeout(() => {
        if (generation !== this.syntaxPresentationGeneration || !editor.dom.isConnected) return;
        this.deps.logSyntax(
          `Post-reveal audit +${delay}ms: path=${path}; elapsedMs=${(performance.now() - startedAt).toFixed(1)}; ` +
          `${this.editorSnapshot(editor)}; treeAvailable=${syntaxTreeAvailable(editor.state, parsedTo)}; ` +
          `treeLength=${syntaxTree(editor.state).length}; renderedSpans=${this.renderedSpanCount(editor)}; ` +
          `covered=${editor.dom.classList.contains("editor-syntax-preparing")}.`,
        );
      }, delay);
    }
  }

  private editorSnapshot(editor: EditorView): string {
    const ranges = editor.visibleRanges.map(range => `${range.from}:${range.to}`).join(",") || "none";
    return `viewport=${ranges}; selection=${editor.state.selection.main.anchor}:${editor.state.selection.main.head}; ` +
      `scroll=${editor.scrollDOM.scrollTop.toFixed(1)}:${editor.scrollDOM.scrollLeft.toFixed(1)}; ` +
      `scrollClient=${editor.scrollDOM.clientWidth}x${editor.scrollDOM.clientHeight}; ` +
      `editorRect=${editor.dom.clientWidth}x${editor.dom.clientHeight}; connected=${editor.dom.isConnected}`;
  }

  private renderedSpanCount(editor: EditorView): number {
    return editor.contentDOM.querySelectorAll(".cm-line span").length;
  }

  private languageParseContext(editor: EditorView): ViewportParseContext | undefined {
    const languageStateField = (Language as unknown as {
      state?: StateField<ViewportLanguageState>;
    }).state;
    return languageStateField
      ? editor.state.field(languageStateField, false)?.context
      : undefined;
  }

  private parseVisibleSyntax(
    editor: EditorView,
    generation: number,
    visibleFrom: number,
    visibleTo: number,
    timeout: number,
  ): boolean {
    if (this.syntaxViewportSeededGeneration !== generation) {
      return forceParsing(editor, visibleTo, timeout);
    }

    const context = this.languageParseContext(editor);
    if (!context) return forceParsing(editor, visibleTo, timeout);

    // `forceParsing` asks for the range 0..visibleTo. That is appropriate for
    // ordinary documents, but it overwrites the distant viewport and defeats
    // StreamLanguage's skip path. Keep the parse viewport local here.
    context.updateViewport({ from: visibleFrom, to: visibleTo });
    const ready = context.isDone(visibleTo) || context.work(timeout, visibleTo);
    if (!ready) return false;

    context.takeTree();
    // Publish the mutable parse context's new tree through Language.state so
    // CodeMirror's highlighter can project it into the visible DOM.
    editor.dispatch({});
    return syntaxTreeAvailable(editor.state, visibleTo);
  }

  /**
   * Continue parsing a large Typst document only while the WebView is idle.
   * This makes later distant jumps progressively warmer without delaying the
   * viewport that the user can currently see or running an unbounded task.
   */
  private scheduleSyntaxPrewarm(editor: EditorView, generation: number, parsedTo: number): void {
    if (parsedTo >= editor.state.doc.length || generation !== this.syntaxPresentationGeneration) return;

    const runSlice = (availableMs: number) => {
      this.syntaxPrewarmHandle = null;
      if (generation !== this.syntaxPresentationGeneration || !editor.dom.isConnected) return;

      const nextTarget = Math.min(editor.state.doc.length, parsedTo + 64 * 1024);
      const budget = Math.max(2, Math.min(8, availableMs));
      forceParsing(editor, nextTarget, budget);
      this.scheduleSyntaxPrewarm(editor, generation, nextTarget);
    };

    if (typeof window.requestIdleCallback === "function") {
      this.syntaxPrewarmUsesIdleCallback = true;
      this.syntaxPrewarmHandle = window.requestIdleCallback(deadline => {
        if (deadline.timeRemaining() < 2 && !deadline.didTimeout) {
          this.scheduleSyntaxPrewarm(editor, generation, parsedTo);
          return;
        }
        runSlice(deadline.timeRemaining() || 2);
      }, { timeout: 1_000 });
      return;
    }

    this.syntaxPrewarmUsesIdleCallback = false;
    this.syntaxPrewarmHandle = window.setTimeout(() => runSlice(4), 250);
  }

  private cancelSyntaxPrewarm(): void {
    if (this.syntaxPrewarmHandle === null) return;
    if (this.syntaxPrewarmUsesIdleCallback && typeof window.cancelIdleCallback === "function") {
      window.cancelIdleCallback(this.syntaxPrewarmHandle);
    } else {
      window.clearTimeout(this.syntaxPrewarmHandle);
    }
    this.syntaxPrewarmHandle = null;
  }

  private editorLanguageKey(path: string): string {
    const fileName = path.replace(/\\/gu, "/").split("/").pop() ?? path;
    const extensionIndex = fileName.lastIndexOf(".");
    return extensionIndex >= 0 ? fileName.slice(extensionIndex + 1).toLowerCase() : "";
  }

}
