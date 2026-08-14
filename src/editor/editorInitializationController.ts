import { listen } from "@tauri-apps/api/event";
import type { Extension, Text } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { completionStatus } from "@codemirror/autocomplete";
import { editorMatchQuery, getEditorExtensions } from "./extensions";
import { setEditorDiagnosticsEffect } from "./diagnostics";
import { setImageOptimizationWarningsEffect } from "./imageWarnings";
import { createTabEditorState } from "./tabHistory";
import type { SpellcheckController } from "./spellcheck";
import type { EditorController } from "./editorController";
import type { TinymistLspClient } from "../compiler/lsp";
import type { DocumentOutlineController } from "../outline/documentOutline";
import type { LogConsoleController } from "../diagnostics/logConsoleController";
import type { PreviewSyncController } from "../preview/previewSyncController";
import type { EditorFontManager } from "./fontManager";
import type { DraftPreviewController, DraftThumbnailQueueMetric } from "../preview/draftPreviewController";

export interface EditorInitializationDependencies {
  editorFontManager: EditorFontManager;
  editorController: EditorController;
  spellcheck: SpellcheckController;
  documentOutline: DocumentOutlineController;
  logConsole: LogConsoleController;
  previewSync: PreviewSyncController;
  draftPreview: DraftPreviewController;
  codeRenderPane: HTMLElement;
  lspClient(): TinymistLspClient;
  activeLspUri(): string;
  flushPendingLspSync(): Promise<void>;
  navigateToLspLocation(uri: string, line: number, character: number): void;
  appendDeveloperLog(entry: { kind: "info" | "warning"; source: string; message: string }): void;
  isLoadingFile(): boolean;
  activeFilePath(): string | null;
  markActiveTabDirty(): void;
  scheduleEditorContentMutation(doc: Text): void;
  syncSelectedSpellingLocation(): void;
  forwardSyncDebounceMs(): number;
  isDeveloperPerformanceLogEnabled(): boolean;
}

export class EditorInitializationController {
  private isComposing = false;

  constructor(private readonly deps: EditorInitializationDependencies) {}

  initialize(): { editor: EditorView; extensions: Extension } {
    const deps = this.deps;
    const initialDocument = "";
    deps.editorFontManager.initialize();
    const extensions: Extension = [
      getEditorExtensions(
        () => deps.lspClient(),
        () => deps.activeLspUri(),
        () => deps.flushPendingLspSync(),
        (uri, line, character) => deps.navigateToLspLocation(uri, line, character),
        () => deps.spellcheck.getProviders(),
        event => deps.appendDeveloperLog({
          kind: "info",
          source: "grapheme pointer",
          message: JSON.stringify(event),
        }),
      ),
      deps.spellcheck.extension(),
      EditorView.updateListener.of(update => {
        const inputProfile = deps.editorController.beginInputProfile();
        deps.spellcheck.completionStateChanged(completionStatus(update.state) !== null);
        const wasComposing = this.isComposing;
        this.isComposing = update.view.composing;

        if (update.docChanged && !deps.isLoadingFile()) {
          deps.previewSync.clearForward();
          deps.markActiveTabDirty();
          if (!update.view.composing) {
            deps.scheduleEditorContentMutation(update.state.doc);
            deps.spellcheck.documentChanged(update);
          }
        } else if (!deps.isLoadingFile() && wasComposing && !update.view.composing) {
          deps.scheduleEditorContentMutation(update.state.doc);
          deps.spellcheck.documentChanged(update);
        }
        if (update.selectionSet) {
          deps.spellcheck.selectionChanged(update.docChanged);
          deps.syncSelectedSpellingLocation();
          deps.documentOutline.setCursorPosition(
            update.state.selection.main.head,
            deps.activeFilePath(),
            true,
          );
        } else if (update.docChanged) {
          deps.logConsole.setActiveSpellcheckLocation(null);
        }
        if (update.selectionSet || update.docChanged) {
          deps.editorController.updateCursorStatus();
          deps.editorController.updateCaretMarker();
        }
        if (update.viewportChanged) {
          deps.editorController.updateCaretMarker();
          const topVisiblePosition = update.view.lineBlockAtHeight(update.view.scrollDOM.scrollTop).from;
          deps.documentOutline.setCursorPosition(topVisiblePosition, deps.activeFilePath());
        }
        const diagnosticsChanged = update.transactions.some(transaction =>
          transaction.effects.some(effect =>
            effect.is(setEditorDiagnosticsEffect) || effect.is(setImageOptimizationWarningsEffect)
          )
        );
        const currentMatchQuery = editorMatchQuery(update.state);
        const previousMatchQuery = editorMatchQuery(update.startState);
        const matchQueryChanged = currentMatchQuery === null
          ? previousMatchQuery !== null
          : previousMatchQuery === null || !currentMatchQuery.eq(previousMatchQuery);

        if (update.docChanged || update.geometryChanged || diagnosticsChanged) deps.editorController.updateDiagnosticMarkers();
        if (update.docChanged || update.selectionSet || matchQueryChanged) deps.editorController.scheduleMatchMarkers();
        deps.editorController.handleFoldTransactions(update.transactions);
        if (!update.docChanged && deps.editorController.shouldForwardSyncSelectionUpdate(update)) {
          deps.previewSync.schedule(deps.forwardSyncDebounceMs());
        }
        deps.editorController.finishInputProfile(inputProfile, update.state.doc.length, update.view.composing);
      }),
    ];

    const editor = new EditorView({
      state: createTabEditorState({ doc: initialDocument, anchor: 0, head: 0, extensions }),
      parent: deps.codeRenderPane,
    });
    deps.editorController.install(editor);

    listen<DraftThumbnailQueueMetric>("draft-thumbnail-queue-metric", event => {
      const metric = event.payload;
      if (!deps.isDeveloperPerformanceLogEnabled()) return;
      if (metric.status === "completed" && !deps.draftPreview.acceptsThumbnailMetric(metric.generation)) return;
      deps.appendDeveloperLog({
        kind: metric.failed > 0 ? "warning" : "info",
        source: "performance",
        message: `Draft thumbnail cache ${metric.status} (generation ${metric.generation}): ${metric.totalImages} image(s); ${metric.cacheHits} cache hit(s); ${metric.generated} generated; ${metric.failed} failed; ${metric.skipped} skipped; total=${metric.totalMs.toFixed(1)} ms; decode=${metric.decodeMs.toFixed(1)} ms; resize=${metric.resizeMs.toFixed(1)} ms; encode=${metric.encodeMs.toFixed(1)} ms; output=${(metric.outputBytes / 1024 / 1024).toFixed(2)} MiB.`,
      });
    });
    editor.contentDOM.tabIndex = -1;
    deps.editorFontManager.updateDocument(initialDocument);
    deps.editorController.updateCursorStatus();
    deps.editorController.updateAll();
    return { editor, extensions };
  }
}
