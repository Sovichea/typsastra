import type { EditorView } from "@codemirror/view";
import { fileExtension, isBinaryImagePath, isMarkdownDocumentPath, isSupportedInAppPath, isTypstDocumentPath } from "../platform/fileTypes";
import { filePathKey } from "../platform/paths";
import type { PreviewSessionState, EditorTab } from "./editorTab";
import type { LargeFileOpeningNotice } from "../workspace/largeFileOpening";
import type { EditorTabPresentationController } from "./editorTabPresentationController";
import type { EditorPreviewActivationController } from "./editorPreviewActivationController";
import type { TypographyController } from "../typography/typographyController";
import type { PreviewSyncController } from "../preview/previewSyncController";
import type { DraftPreviewController } from "../preview/draftPreviewController";
import type { SpellcheckController } from "./spellcheck";
import type { DocumentOutlineController } from "../outline/documentOutline";
import type { EditorToolbarController } from "./toolbarController";
import type { EditorController } from "./editorController";

export type ActivateEditorTabOptions = {
  preservePreviewSession?: PreviewSessionState;
  skipPreviewActivation?: boolean;
  focusEditor?: boolean;
  largeFileConfirmed?: boolean;
};

export interface EditorTabActivationDependencies {
  explorer: {
    setActiveFile(path: string | null): void;
    revealPath(path: string): Promise<void>;
  };
  workspaceRootPath(): string | null;
  openTabs(): EditorTab[];
  activeFilePath(): string | null;
  setActiveFilePath(path: string | null): void;
  classifyUnknownTextPath(path: string): Promise<boolean>;
  largeFileNoticeForTab(tab: EditorTab): Promise<LargeFileOpeningNotice | null>;
  persistActiveTabState(): void;
  capturePreviewViewport(): void;
  showLargeFileConfirmation(tab: EditorTab, notice: LargeFileOpeningNotice): void;
  loadEditorTabContent(tab: EditorTab): Promise<void>;
  clearGuardrailAlignment(): void;
  isInternallySupportedPath(path: string): boolean;
  editor(): EditorView;
  markdownPreview: {
    activate(path: string, content: string): void;
    deactivate(): void;
  };
  setMarkdownPreviewActive(active: boolean): void;
  updatePreviewActionsToolbar(path: string | null): void;
  applyPreviewSessionToTab(tab: EditorTab, session: PreviewSessionState): void;
  activatePreviewSession(sessionKey: string): void;
  previewScrollTopForTab(tab: EditorTab): number | undefined;
  queuePreviewScrollPosition(scrollTop?: number): void;
  renderEditorTabs(): void;
  saveWorkspaceState(): void;
  cancelManualForwardSync(): void;
  updateManualForwardSyncAction(): void;
  typography: TypographyController;
  setCurrentVersion(version: number): void;
  setLatestDocumentVersion(version: number): void;
  previewSync: PreviewSyncController;
  clearEditorDiagnostics(): void;
  setLoadingFile(loading: boolean): void;
  presentation: EditorTabPresentationController;
  activateSpellcheckDocument(path: string | null): void;
  clearOutline(): void;
  restoreCachedEditorDiagnostics(path: string): void;
  draftPreview: DraftPreviewController;
  updateWorkspaceViewportVisibility(): void;
  resumeDeferredWorkspaceServices(): Promise<void>;
  isLowMemoryMode(): boolean;
  restoreTabFoldState(tab: EditorTab): void;
  restoreEditorTabViewport(tab: EditorTab, path: string): Promise<void>;
  toolbar: EditorToolbarController;
  setDiagnosticWaitStartedAt(startedAt: number): void;
  previewActivation: EditorPreviewActivationController;
  clearPendingLspSync(): void;
  spellcheck: SpellcheckController;
  scheduleDocumentOutlineUpdate(path: string, delay?: number): void;
  outline: DocumentOutlineController;
  activeMode(): "CODE" | "WYSIWYM";
  mapMarkupToWysiwym(markup: string): void;
  editorController: EditorController;
  logPreview(message: string): void;
}

export class EditorTabActivationController {
  private activationGeneration = 0;
  private pendingActivation: { path: string; tab: EditorTab | undefined; operation: Promise<void> } | null = null;
  constructor(private readonly deps: EditorTabActivationDependencies) {}

  activate(path: string, persistCurrent = true, options: ActivateEditorTabOptions = {}): Promise<void> {
    const key = filePathKey(path);
    const tab = this.deps.openTabs().find(candidate => filePathKey(candidate.path) === key);
    if (this.pendingActivation?.path === key && this.pendingActivation.tab === tab
      && !options.largeFileConfirmed && !options.preservePreviewSession && !options.skipPreviewActivation) {
      return this.pendingActivation.operation;
    }
    const operation = this.activateRequested(path, persistCurrent, options).finally(() => {
      if (this.pendingActivation?.operation === operation) this.pendingActivation = null;
    });
    this.pendingActivation = { path: key, tab, operation };
    return operation;
  }

  private async activateRequested(path: string, persistCurrent: boolean, options: ActivateEditorTabOptions): Promise<void> {
    const generation = ++this.activationGeneration;
    const deps = this.deps;
    deps.explorer.setActiveFile(path);
    if (deps.workspaceRootPath()) void deps.explorer.revealPath(path);

    const tab = deps.openTabs().find(candidate => filePathKey(candidate.path) === filePathKey(path));
    const isCurrent = () => generation === this.activationGeneration && (!tab || deps.openTabs().includes(tab));
    let activeFilePath = deps.activeFilePath();
    let sameActivePath = activeFilePath !== null && filePathKey(activeFilePath) === filePathKey(path);
    deps.logPreview(`Tab activation started: path=${path}; sameActive=${sameActivePath}; found=${Boolean(tab)}; loaded=${tab?.contentLoaded}; confirmed=${options.largeFileConfirmed === true}; lowMemory=${deps.isLowMemoryMode()}.`);
    if (tab && !isSupportedInAppPath(tab.path)) {
      const supported = await deps.classifyUnknownTextPath(tab.path);
      if (!isCurrent()) return;
      if (supported && !tab.content && !tab.savedContent) tab.contentLoaded = false;
    }
    if (tab && !tab.contentLoaded) {
      deps.logPreview(`Tab file inspection started: path=${path}.`);
      const notice = await deps.largeFileNoticeForTab(tab);
      if (!isCurrent()) return;
      deps.logPreview(`Tab file inspection finished: path=${path}; guarded=${Boolean(notice)}.`);
      if (notice && !options.largeFileConfirmed) {
        deps.logPreview(`Tab activation blocked by large-file guard: tab=${path}; kind=${notice.kind}; previewRoot=${notice.previewRootPath ?? "none"}.`);
        if (persistCurrent && !sameActivePath) deps.persistActiveTabState();
        deps.showLargeFileConfirmation(tab, notice);
        return;
      }
      if (isBinaryImagePath(tab.path)) {
        deps.presentation.showImageLoading(tab.path);
      }
      deps.logPreview(`Tab content loading started: path=${path}.`);
      await deps.loadEditorTabContent(tab);
      if (!isCurrent()) return;
      deps.logPreview(`Tab content loading finished: path=${path}; loaded=${tab.contentLoaded}.`);
    }
    if (!isCurrent()) return;
    // Loading may have yielded while another tab was displayed. Persist the
    // editor actually on screen, rather than the tab active when IO began.
    activeFilePath = deps.activeFilePath();
    sameActivePath = activeFilePath !== null && filePathKey(activeFilePath) === filePathKey(path);
    deps.clearGuardrailAlignment();
    const activeEditorMatchesTab = tab !== undefined && (
      !deps.isInternallySupportedPath(tab.path)
      || isBinaryImagePath(tab.path)
      || fileExtension(tab.path) === "pdf"
      || deps.editor().state.doc.toString() === tab.content
    );
    if (sameActivePath && tab && activeEditorMatchesTab && !options.largeFileConfirmed) {
      if (isMarkdownDocumentPath(tab.path)) {
        deps.setMarkdownPreviewActive(true);
        deps.markdownPreview.activate(tab.path, tab.content);
        deps.updatePreviewActionsToolbar(tab.path);
      }
      if (persistCurrent) {
        deps.persistActiveTabState();
        deps.renderEditorTabs();
      }
      if (options.preservePreviewSession) {
        const activeTab = deps.openTabs().find(candidate => filePathKey(candidate.path) === filePathKey(tab.path));
        if (activeTab) deps.applyPreviewSessionToTab(activeTab, options.preservePreviewSession);
        if (options.preservePreviewSession.previewSessionKey) {
          deps.activatePreviewSession(options.preservePreviewSession.previewSessionKey);
        }
      }
      if (options.focusEditor !== false) deps.editor().focus();
      deps.saveWorkspaceState();
      return;
    }

    if (!sameActivePath) deps.capturePreviewViewport();
    if (persistCurrent && !sameActivePath) deps.persistActiveTabState();
    if (!sameActivePath) deps.cancelManualForwardSync();

    if (!tab) {
      if (sameActivePath) deps.setActiveFilePath(null);
      deps.updateManualForwardSyncAction();
      return;
    }

    path = tab.path;
    const isTypstDocument = isTypstDocumentPath(path);
    const isMarkdownDocument = isMarkdownDocumentPath(path);
    if (!isMarkdownDocument) {
      deps.markdownPreview.deactivate();
      deps.setMarkdownPreviewActive(false);
    }
    deps.typography.setAcceptedFonts(path, deps.typography.fromText(tab.content)?.fonts ?? []);
    deps.setCurrentVersion(tab.version);
    deps.setLatestDocumentVersion(tab.latestVersion);
    deps.previewSync.reset();
    deps.clearEditorDiagnostics();
    // The first persistence pass captures the outgoing tab before diagnostics
    // are cleared. Refresh its runtime EditorState now so a later warm tab
    // activation cannot briefly restore stale diagnostic decorations.
    if (!sameActivePath) deps.persistActiveTabState();

    deps.setLoadingFile(true);
    try {
      const unsupportedFile = !deps.isInternallySupportedPath(path);
      const isPdf = fileExtension(path) === "pdf";
      if (unsupportedFile || isBinaryImagePath(path) || isPdf) {
        if (!sameActivePath) deps.queuePreviewScrollPosition(deps.previewScrollTopForTab(tab));
        deps.presentation.presentNonText(
          tab,
          path,
          unsupportedFile,
          isPdf,
          options.skipPreviewActivation === true,
          () => {
            deps.activateSpellcheckDocument(null);
            deps.clearOutline();
          },
        );
        deps.setActiveFilePath(path);
        deps.draftPreview.publishWarnings();
        deps.setLoadingFile(false);
        deps.updateManualForwardSyncAction();
        deps.updateWorkspaceViewportVisibility();
        deps.renderEditorTabs();
        deps.saveWorkspaceState();
        void deps.resumeDeferredWorkspaceServices();
        return;
      }
      deps.presentation.presentText(tab, path);
    } finally {
      deps.setLoadingFile(false);
    }
    deps.restoreTabFoldState(tab);
    deps.setActiveFilePath(path);
    if (isMarkdownDocument) {
      deps.setMarkdownPreviewActive(true);
      deps.markdownPreview.activate(path, tab.content);
    }
    deps.draftPreview.publishWarnings();
    deps.renderEditorTabs();
    await deps.restoreEditorTabViewport(tab, path);
    if (!isCurrent()) return;
    deps.presentation.finishTextPresentation(path);
    const activeTypography = await deps.typography.effective(path, tab.content);
    if (!isCurrent()) return;
    if (activeTypography) deps.toolbar.synchronizeDocumentTypography(activeTypography);

    if (path.toLowerCase().endsWith(".typ")) deps.setDiagnosticWaitStartedAt(performance.now());
    const previewOptions = { ...options, isCurrent };
    const previewActivation = await deps.previewActivation.prepare(tab, path, isTypstDocument, previewOptions);
    if (!isCurrent()) return;
    // Included files share the main document's preview session. Resolve that
    // relationship before restoring the offset so a newly opened include
    // cannot reset the mounted PDF to its own stale or empty tab position.
    // Reusing the mounted main-document session must leave its live viewport
    // untouched. Queuing a saved chapter offset after activateSession() has
    // already run defers that offset until the *next* tab activation, causing
    // include tabs to appear one position behind each other. Only seed an
    // offset when this activation is going to mount a different PDF session.
    if (!sameActivePath && !previewActivation.presentationReused) {
      deps.queuePreviewScrollPosition(deps.previewScrollTopForTab(tab));
    }
    // A large-file confirmation initially holds workspace services back. The
    // preview target must be resolved first: for an included file that target
    // is its effective main document, not the tab itself. In low-memory mode
    // wait for preparation before the one-shot render so the first confirmed
    // preview cannot race the cache/render-project setup.
    if (deps.isLowMemoryMode()) {
      deps.logPreview(`Tab activation resumes deferred low-memory services: tab=${path}; root=${tab.previewMainPath ?? tab.previewRootPath ?? "none"}.`);
      await deps.resumeDeferredWorkspaceServices();
      if (!isCurrent()) return;
    } else {
      void deps.resumeDeferredWorkspaceServices();
    }
    deps.activateSpellcheckDocument(isMarkdownDocument ? null : path);
    deps.clearPendingLspSync();
    deps.previewSync.clearForward();
    deps.renderEditorTabs();
    if (!isMarkdownDocument) deps.spellcheck.schedule();
    if (path.toLowerCase().endsWith(".typ")) {
      deps.scheduleDocumentOutlineUpdate(path, 0);
      deps.outline.setCursorPosition(deps.editor().state.selection.main.head, deps.activeFilePath());
      deps.restoreCachedEditorDiagnostics(path);
    } else {
      deps.clearOutline();
    }

    await deps.previewActivation.finish(tab, path, isTypstDocument, previewActivation, previewOptions);
    if (!isCurrent()) return;
    deps.updatePreviewActionsToolbar(path);

    if (deps.activeMode() === "WYSIWYM") deps.mapMarkupToWysiwym(tab.content);

    deps.updateWorkspaceViewportVisibility();
    deps.editorController.refreshLayout("tab activation");
    deps.updateManualForwardSyncAction();
    if (options.focusEditor !== false) deps.editor().focus();
    deps.saveWorkspaceState();
  }
}
