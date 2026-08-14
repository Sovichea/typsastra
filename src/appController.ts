import { message } from "@tauri-apps/plugin-dialog";
import { open as openUrl } from "@tauri-apps/plugin-shell";
import { Channel, invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { dirname, join } from "@tauri-apps/api/path";
import { EditorState, type Extension, type Text } from "@codemirror/state";
import { EditorView, highlightActiveLine, highlightActiveLineGutter, lineNumbers } from "@codemirror/view";
import { undo, redo, undoDepth } from "@codemirror/commands";
import { indentUnit } from "@codemirror/language";
import { closeBrackets } from "@codemirror/autocomplete";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { themeCompartment, getThemeExtension, wrapCompartment, lineNumbersCompartment, activeLineCompartment, closeBracketsCompartment, indentationGuidesCompartment, tabSizeCompartment, completionCompartment, showZwsCompartment, showZeroWidthSpaces, visibleIndentationMarkers } from "./editor/extensions";
import { typstLanguage } from "./editor/typstLanguage";
import { createTypstAutocomplete } from "./editor/autocomplete";
import { EditorController } from "./editor/editorController";
import { EditorInitializationController } from "./editor/editorInitializationController";
import { SurroundWithDiscoveryController } from "./editor/surroundWithDiscoveryController";
import { isForwardSyncContentPosition } from "./editor/forwardSyncEligibility";
import type { EditorFoldRange } from "./editor/folding";
import { WorkspaceExplorer } from "./components/explorer";
import { SidebarController } from "./sidebar/sidebarController";
import { TypographyController } from "./typography/typographyController";
import { PinnedMainTypographyController } from "./typography/pinnedMainTypographyController";
import { ImageToolsController, type ProjectImageReference } from "./components/imageTools";
import { TinymistLspClient } from "./compiler/lsp";
import { DocumentSessionController } from "./session/documentSessionController";
import { LspDocumentController } from "./session/lspDocumentController";
import { LspSyncController } from "./session/lspSyncController";
import { type LspDiagnostic, type LspInverseSyncResult, type LspLogEntry, type LspSourcePosition, type LspStatus } from "./compiler/lsp";
import type { AppSettings, DeveloperLogCategory, PreviewColorMode, PreviewRenderMode } from "./settings";
import { SettingsController } from "./settingsController";
import { SettingsRuntimeController } from "./settingsRuntimeController";
import { fileNameFromPath, filePathKey, relativeFilePath } from "./platform/paths";
import { isBinaryImagePath, isMarkdownDocumentPath, isTypstDocumentPath, fileExtension } from "./platform/fileTypes";
import { WysiwymAdapter } from "./wysiwym/adapter";
import type { PreviewFrame, PreviewClickPoint, PreviewInteractionStatus, PreviewPageStatus, PreviewSurface } from "./preview/previewFrame";
import type { MarkdownPreviewFrame, MarkdownResource } from "./preview/markdownPreviewFrame";
import { PreviewController } from "./preview/previewController";
import { PreviewSyncController } from "./preview/previewSyncController";
import { PreviewSourceNavigationController } from "./preview/previewSourceNavigationController";
import { PreviewUiController } from "./preview/previewUiController";
import { PreviewContentController } from "./preview/previewContentController";
import { PreviewWindowController } from "./preview/previewWindowController";
import { PreviewSessionController } from "./preview/previewSessionController";
import { TinymistPreviewRecoveryController } from "./preview/tinymistPreviewRecoveryController";
import { SourceMapSessionController } from "./preview/sourceMapSessionController";
import { ImagePreviewController } from "./preview/imagePreviewController";
import {
  DraftPreviewController,
} from "./preview/draftPreviewController";
import { PdfPreviewPreparationController } from "./preview/pdfPreviewPreparationController";
import { PdfPreviewRenderController } from "./preview/pdfPreviewRenderController";
import { activeFileCanRenderPreview, participatesInPreviewCompilation, previewRefreshStyle, type PreviewTarget, type PreviewRefreshStyle } from "./preview/previewPolicy";
import { LogConsoleController, type LogConsoleEntryInput } from "./diagnostics/logConsoleController";
import { DiagnosticsController } from "./diagnostics/diagnosticsController";
import { PreviewFailureController } from "./diagnostics/previewFailureController";
import { DeveloperLogController } from "./diagnostics/developerLogController";
import { PreviewDiagnosticsRecoveryController } from "./diagnostics/previewDiagnosticsRecoveryController";
import { EditorFontManager } from "./editor/fontManager";
import { TabStripController } from "./editor/tabStripController";
import { EditorSessionController } from "./editor/editorSessionController";
import { EditorTabViewController } from "./editor/editorTabViewController";
import { EditorTabStateController } from "./editor/editorTabStateController";
import { EditorTabPresentationController } from "./editor/editorTabPresentationController";
import { EditorTabLifecycleController, type EditorTabLoadOptions } from "./editor/editorTabLifecycleController";
import { EditorPreviewActivationController } from "./editor/editorPreviewActivationController";
import { EditorTabActivationController, type ActivateEditorTabOptions } from "./editor/editorTabActivationController";
import { AppDialogController } from "./ui/appDialog";
import { LayoutController } from "./layout/layoutController";
import type { WorkspaceMetadata } from "./workspace/workspaceStateStore";
import { RecentProjectsController } from "./workspace/recentProjectsController";
import {
  type WorkspaceChange
} from "./workspace/workspaceWatcher";
import { WorkspaceController } from "./workspace/workspaceController";
import {
  WorkspaceLifecycleController,
  type WorkspaceLifecycleDependencies,
} from "./workspace/workspaceLifecycleController";
import { ProjectImportController } from "./workspace/projectImportController";
import { ExternalWorkspaceController } from "./workspace/externalWorkspaceController";
import { ExternalFileReloadController } from "./workspace/externalFileReloadController";
import { WorkspacePathRenameController } from "./workspace/workspacePathRenameController";
import { PinnedMainFileController } from "./workspace/pinnedMainFileController";
import { LargePreviewGuardController } from "./workspace/largePreviewGuardController";
import type { LargeFileOpeningNotice } from "./workspace/largeFileOpening";
import { PerformanceController } from "./performance/performanceController";
import { EditorToolbarController } from "./editor/toolbarController";
import { ContextMenuController } from "./components/contextMenuController";
import { ToolchainController, type SystemToolchain, type ToolchainStatus } from "./toolchain/toolchainController";
import { ToolchainSetupController, type ToolchainInstallProgress } from "./toolchain/toolchainSetupController";
import { DocumentOutlineController, type DocumentHeading } from "./outline/documentOutline";
import { WindowStateController } from "./window/windowStateController";
import { bindAppEvents } from "./ui/appEventBindings";
import { ReleaseSummaryController } from "./ui/releaseSummaryController";
import { ProjectExportController } from "./export/projectExportController";
import type { DocumentTypography } from "./editor/documentTypography";
import {
  SpellcheckController,
  type SpellcheckDebugEvent,
  type SpellingIssue,
} from "./editor/spellcheck";
import { DocumentLanguageService } from "./editor/languageScopes";
import type { ImportedTypsastraProject } from "./projectArchive";
import { AppUpdateController } from "./appUpdateController";
import { WebviewStorageController } from "./webviewStorageController";
import { SystemResumeMonitor } from "./platform/systemResume";
import { WorkspaceResumeController } from "./platform/workspaceResumeController";
import { installNativeAppMenu, type NativeAppMenuHandle } from "./platform/nativeAppMenu";
import { setImageOptimizationWarningsEffect } from "./editor/imageWarnings";
import type { EditorTab, PreviewSessionState } from "./editor/editorTab";
import { DocumentPersistenceController, type SaveIntent } from "./editor/documentPersistenceController";
import { DocumentFormattingController } from "./editor/documentFormattingController";
import { DocumentLanguageController } from "./editor/documentLanguageController";
import { EditorFileGuardController } from "./editor/editorFileGuardController";
import { EditorFileContentController } from "./editor/editorFileContentController";
import { WorkspaceTextController } from "./workspace/workspaceTextController";
import { DocumentTypographyApplicationController } from "./typography/documentTypographyApplicationController";
import { SourceLocationController } from "./navigation/sourceLocationController";
import { OutlineNavigationController } from "./navigation/outlineNavigationController";
import { TinymistIntegrationController } from "./session/tinymistIntegrationController";


type EditorMode = "CODE" | "WYSIWYM";

const DEFAULT_INPUT_WIDTH_PCT = 50;
const DEFAULT_PREVIEW_WIDTH_PCT = 100 - DEFAULT_INPUT_WIDTH_PCT;
const DEFAULT_EXPLORER_WIDTH_PX = 250;




export class TypsastraWorkspaceController {
  /**
   * Temporary compatibility adapter while lifecycle-owned state is moved out
   * of the root controller. Consumers compile against the explicit port rather
   * than receiving the root as `object` and recovering it through `any`.
   */
  private createWorkspaceLifecycleDependencies(): WorkspaceLifecycleDependencies {
    // This property is consumed dynamically by the temporary lifecycle proxy.
    void this.inspectedPreviewRoots;
    void this.lastPreviewRenderMode;
    void this.finishEditorTextPresentation;
    void this.restoreActiveNonTextPreview;
    const root = this;
    return new Proxy({} as WorkspaceLifecycleDependencies, {
      get(_target, property) {
        const value: unknown = Reflect.get(root, property, root);
        return typeof value === "function" ? value.bind(root) : value;
      },
      set(_target, property, value) {
        return Reflect.set(root, property, value, root);
      },
    });
  }

  private async restoreActiveNonTextPreview(): Promise<void> {
    await this.refreshActivePreviewRoot(true);
  }

  private readonly startupStart = performance.now();
  private activeMode: EditorMode = "CODE";
  private readonly editorSessionController = new EditorSessionController();
  private readonly editorTabStateController = new EditorTabStateController({
    editor: () => this.editorInstance,
    editorController: () => this.editorController,
    activeTab: () => this.getActiveTab(),
    activeFilePath: () => this.activeFilePath,
    workspaceLoading: () => this.workspaceLoading,
    activeMode: () => this.activeMode,
    currentVersion: () => this.currentVersion,
    latestDocumentVersion: () => this.latestDocumentVersion,
    isInternallySupportedPath: path => this.isInternallySupportedPath(path),
    flushEditorContentMutation: () => this.flushEditorContentMutation(),
    wysiwymMarkup: () => this.mapWysiwymToMarkup(),
    renderTabs: () => this.renderEditorTabs(),
    saveWorkspaceState: () => this.saveWorkspaceState(),
    logSyntax: message => this.appendDeveloperLog({
      kind: "info",
      source: "editor syntax",
      message,
    }),
  });
  private readonly editorFileContentController = new EditorFileContentController({
    normalizeFoldRanges: (value, docLength) => this.normalizeFoldRanges(value, docLength),
  });
  private readonly previewSessionController = new PreviewSessionController({
    workspaceRootPath: () => this.workspaceRootPath,
    previewRenderMode: () => this.effectivePreviewRenderMode,
    readWorkspaceText: path => this.workspaceText(path),
    logWarning: message => this.appendLspLog({ kind: "warning", source: "preview", message }),
  });
  private readonly lspDocumentController = new LspDocumentController({
    client: () => this.documentSessionController.hasClient ? this.lspClient : undefined,
    ready: () => this.lspReady,
    activeFilePath: () => this.activeFilePath,
    activeTab: () => this.getActiveTab(),
    resolveDocument: (path, text) => this.getLspUriAndContent(path, text),
    clearDiagnostics: () => this.clearDiagnostics(),
    log: (kind, source, message) => this.appendDeveloperLog({ kind, source, message }),
  });
  private readonly documentLanguageController = new DocumentLanguageController({
    languageService: () => this.documentLanguageService,
    spellcheck: () => this.spellcheckController,
    outline: () => this.documentOutlineController,
    activeFilePath: () => this.activeFilePath,
    pinnedMainFilePath: () => this.pinnedMainFilePath,
    previewImported: () => this.previewImported,
    isPinnedMainFile: path => this.isPinnedMainFile(path),
    editorText: () => this.editorInstance.state.doc.toString(),
    workspaceRootPath: () => this.workspaceRootPath,
    activeTab: () => this.getActiveTab(),
    editorCursorPosition: () => this.editorInstance.state.selection.main.head,
  });
  private readonly editorTabPresentationController = new EditorTabPresentationController({
    editor: () => this.editorInstance,
    editorExtensions: () => this.editorExtensions,
    currentSettingsEffects: () => this.currentEditorSettingsEffects(),
    editorLanguageForPath: path => this.editorLanguageForPath(path),
    editorCompletionForPath: path => this.editorCompletionForPath(path),
    fontManager: () => this.editorFontManager,
    toolbar: () => this.editorToolbarController,
    imagePreview: () => this.imagePreviewController,
    previewFrame: () => this.previewFrame,
    activeMode: () => this.activeMode,
    workspaceLoading: () => this.workspaceLoading,
    logSyntax: message => this.appendDeveloperLog({
      kind: "info",
      source: "editor syntax",
      message,
    }),
    updatePreviewActionsToolbar: path => this.updatePreviewActionsToolbar(path),
    renderNonTextPlaceholder: (path, unsupported) => this.renderNonTextEditorPlaceholder(path, unsupported),
    renderInteractiveImageViewer: source => this.renderInteractiveImageViewer(source),
    loadPdfPath: path => { void this.loadPdfPath(path, path); },
    applyFoldRanges: ranges => this.applyFoldRanges(ranges),
    clearPreviewPane: () => { this.previewPane.innerHTML = ""; },
    clearOutline: () => this.documentOutlineController.clear(),
    mapMarkupToWysiwym: contents => { this.mapMarkupToWysiwym(contents); },
  });
  private readonly workspaceTextController = new WorkspaceTextController({
    openTabs: () => this.openTabs,
    activeFilePath: () => this.activeFilePath,
    presentation: () => this.editorTabPresentationController,
    renderEditorTabs: () => this.renderEditorTabs(),
    lspReady: () => this.lspReady,
    lspClient: () => this.documentSessionController.hasClient ? this.lspClient : undefined,
    lspDocuments: () => this.lspDocumentController,
    resolveLspDocument: (path, content) => this.getLspUriAndContent(path, content),
    currentDocumentVersion: () => this.currentVersion,
  });
  private readonly editorTabLifecycleController = new EditorTabLifecycleController({
    session: this.editorSessionController,
    presentation: this.editorTabPresentationController,
    previewSession: this.previewSessionController,
    lspDocuments: this.lspDocumentController,
    typography: () => this.typographyController,
    pinnedMainFilePath: () => this.pinnedMainFilePath,
    persistActiveTabState: () => this.persistActiveTabState(),
    promoteToPermanent: tab => this.promoteToPermanent(tab),
    activateTab: (path, persistCurrent, options) => this.activateEditorTab(path, persistCurrent, options),
    classifyUnknownTextPath: path => this.classifyUnknownTextPath(path),
    renderTabs: () => this.renderEditorTabs(),
    setExplorerActiveFile: path => this.explorer.setActiveFile(path),
    activateSpellcheckDocument: path => this.activateSpellcheckDocument(path),
    clearDiagnostics: () => this.clearDiagnostics(),
    clearPendingLspSync: () => this.clearPendingLspSync(),
    clearForwardSync: () => this.previewSyncController.clearForward(),
    updateWorkspaceViewportVisibility: () => this.updateWorkspaceViewportVisibility(),
    saveWorkspaceState: () => { void this.saveWorkspaceState(); },
  });
  private readonly editorPreviewActivationController = new EditorPreviewActivationController({
    previewSession: this.previewSessionController,
    lspDocuments: this.lspDocumentController,
    previewFrame: () => this.previewFrame,
    workspaceRootPath: () => this.workspaceRootPath,
    pinnedMainFilePath: () => this.pinnedMainFilePath,
    lspAvailable: () => this.lspReady && this.documentSessionController.hasClient,
    currentVersion: () => this.currentVersion,
    resolveLspDocument: (path, text) => this.getLspUriAndContent(path, text),
    ensureLargePreviewApproved: rootPath => this.ensureLargePreviewApproved(rootPath),
    invalidatePreviewWork: reason => this.invalidatePreviewWork(reason),
    noMainFileMessage: () => this.noMainFileMessage(),
    disabledPreviewMessage: () => this.disabledPreviewMessage(),
    renderPdfPreview: contents => { void this.renderPdfPreview(contents); },
  });
  private readonly largePreviewGuardController = new LargePreviewGuardController({
    previewSession: this.previewSessionController,
    previewFrame: () => this.previewFrame,
    workspaceRootPath: () => this.workspaceRootPath,
    pinnedMainFilePath: () => this.pinnedMainFilePath,
    pinnedLspMainPath: () => this.pinnedLspMainPath,
    lspReady: () => this.lspReady,
    activeTab: () => this.getActiveTab(),
    isInternallySupportedPath: path => this.isInternallySupportedPath(path),
    showLargeFileConfirmation: (tab, notice) => this.showLargeFileConfirmation(tab, notice),
    setWorkspaceServicesDeferred: deferred => { this.workspaceServicesDeferredForLargeFile = deferred; },
  });
  private readonly externalFileReloadController = new ExternalFileReloadController({
    presentation: this.editorTabPresentationController,
    documentLanguage: this.documentLanguageController,
    lspDocuments: this.lspDocumentController,
    openTabs: () => this.openTabs,
    activeFilePath: () => this.activeFilePath,
    isInternallySupportedPath: path => this.isInternallySupportedPath(path),
    closeTab: path => this.closeEditorTab(path, true),
    loadPdfPath: path => { void this.loadPdfPath(path, path); },
    renderTabs: () => this.renderEditorTabs(),
    activeMode: () => this.activeMode,
    mapMarkupToWysiwym: contents => { this.mapMarkupToWysiwym(contents); },
    lspClient: () => this.documentSessionController.hasClient ? this.lspClient : undefined,
    lspReady: () => this.lspReady,
    resolveLspDocument: (path, contents) => this.getLspUriAndContent(path, contents),
    pinnedMainFilePath: () => this.pinnedMainFilePath,
    previewRenderMode: () => this.effectivePreviewRenderMode,
    renderPdfPreview: contents => { void this.renderPdfPreview(contents); },
    schedulePdfPreview: contents => this.schedulePdfPreview(contents),
    setLspStatus: status => this.setLspStatus(status),
    appendWorkspaceWarning: message => this.appendLspLog({ kind: "warning", source: "workspace", message }),
  });
  private get activeFilePath(): string | null { return this.editorSessionController.activeFilePath; }
  private set activeFilePath(path: string | null) { this.editorSessionController.activeFilePath = path; }
  private get openTabs(): EditorTab[] { return this.editorSessionController.tabs; }
  private set openTabs(tabs: EditorTab[]) { this.editorSessionController.replaceTabs(tabs); }
  private get previewRootPath(): string | null { return this.previewSessionController.rootPath; }
  private set previewRootPath(path: string | null) { this.previewSessionController.rootPath = path; }
  private get previewMainPath(): string | null { return this.previewSessionController.mainPath; }
  private set previewMainPath(path: string | null) { this.previewSessionController.mainPath = path; }
  private get previewTaskId(): string | null { return this.previewSessionController.taskId; }
  private set previewTaskId(taskId: string | null) { this.previewSessionController.taskId = taskId; }
  private get previewSessionKey(): string | null { return this.previewSessionController.sessionKey; }
  private set previewSessionKey(key: string | null) { this.previewSessionController.sessionKey = key; }
  private get previewImported(): boolean { return this.previewSessionController.imported; }
  private set previewImported(imported: boolean) { this.previewSessionController.imported = imported; }
  private get previewStandalone(): boolean { return this.previewSessionController.standalone; }
  private set previewStandalone(standalone: boolean) { this.previewSessionController.standalone = standalone; }
  private get previewDisabled(): boolean { return this.previewSessionController.disabled; }
  private set previewDisabled(disabled: boolean) { this.previewSessionController.disabled = disabled; }
  private get pinnedLspMainPath(): string | null { return this.lspDocumentController.pinnedMainPath; }
  private set pinnedLspMainPath(path: string | null) { this.lspDocumentController.pinnedMainPath = path; }
  private pinnedMainFilePath: string | null = null;
  private get mainDocumentScripts(): DocumentTypography["fonts"] { return this.documentLanguageController.mainDocumentScripts; }
  private set mainDocumentScripts(value: DocumentTypography["fonts"]) { this.documentLanguageController.mainDocumentScripts = value; }
  private workspaceRootPath: string | null = null;
  private workspaceMetadata: WorkspaceMetadata | null = null;
  private workspaceLoading = false;
  private workspaceServicesDeferredForLargeFile = false;
  private get approvedLargePreviewRoots(): Set<string> { return this.largePreviewGuardController.approvedRoots; }
  private get inspectedPreviewRoots(): Set<string> { return this.largePreviewGuardController.inspectedRoots; }
  private get blockedLargePreviewRoot(): string | null { return this.largePreviewGuardController.blockedRoot; }
  private set blockedLargePreviewRoot(rootPath: string | null) { this.largePreviewGuardController.blockedRoot = rootPath; }
  private previewScrollTop = 0;
  private previewScrollSaveTimer: number | null = null;
  private recommendedWorkspaceToolchain: { tinymistVersion: string; typstVersion: string } | null = null;
  private selectedWorkspaceToolchain: { tinymistVersion: string; typstVersion: string } | null = null;
  private get currentVersion(): number { return this.lspDocumentController.currentVersion; }
  private set currentVersion(version: number) { this.lspDocumentController.currentVersion = version; }
  private get isLoadingFile(): boolean { return this.editorTabPresentationController.isLoading; }
  private set isLoadingFile(loading: boolean) { this.editorTabPresentationController.isLoading = loading; }
  private readonly lspSyncDebounceMs = 50;
  private get latestDocumentVersion(): number { return this.lspDocumentController.latestVersion; }
  private set latestDocumentVersion(version: number) { this.lspDocumentController.latestVersion = version; }
  private diagnosticWaitStartedAt: number | null = null;
  private projectImportQueue: Promise<void> = Promise.resolve();
  private readonly blockedLargePdfPaths = new Set<string>();
  private get previewPageStatus(): PreviewPageStatus { return this.previewUiController.pageStatus; }
  private get pdfPreviewGeneration(): number { return this.pdfPreviewRenderController.generation; }
  private get pdfPreparationRevision(): number { return this.pdfPreviewRenderController.preparationRevision; }
  private get pdfPreviewRunning(): boolean { return this.pdfPreviewRenderController.running; }
  private get pdfPreviewSourceMapRootPath(): string | null { return this.pdfPreviewRenderController.sourceMapRootPath; }
  private get pdfPreviewSourceMapTaskId(): string | null { return this.pdfPreviewRenderController.sourceMapTaskId; }
  private get lastPdfPath(): string { return this.pdfPreviewRenderController.lastPdfPath; }
  private get lastPdfIdentity(): string { return this.pdfPreviewRenderController.lastPdfIdentity; }
  private get lastPdfSessionKey(): string { return this.pdfPreviewRenderController.lastPdfSessionKey; }
  private get lastPdfSurface(): PreviewSurface { return this.pdfPreviewRenderController.lastPdfSurface; }
  private get externalConflictPaths(): Set<string> { return this.externalFileReloadController.conflictPaths; }
  private externalPreviewRefreshPending = false;
  private get managedPreviewPdfPathKeys(): ReadonlySet<string> { return this.pdfPreviewRenderController.managedPdfPathKeys; }
  private readonly managedImageToolPathKeys = new Set<string>();
  private lastBroadcastPreviewColorMode: PreviewColorMode | null = null;
  private readonly settingsController: SettingsController = new SettingsController(
    settings => this.applySettingsToRuntime(settings),
    providers => this.handleLanguageProvidersChanged(providers),
    () => this.typographyController.privateFontDirectoriesChanged(),
    () => this.typographyController.privateFontDirectoriesChanged()
  );
  private readonly toolchainController = new ToolchainController({
    getSelectedVersion: () => this.settingsController.value.toolchain.tinymistVersion,
    setSelectedVersion: version => this.settingsController.update(settings => {
      settings.toolchain.tinymistVersion = version;
    }),
    onToolchainChanged: status => {
      if (this.workspaceRootPath && status.tinymistVersion && status.typstVersion) {
        this.selectedWorkspaceToolchain = {
          tinymistVersion: status.tinymistVersion,
          typstVersion: status.typstVersion
        };
        this.saveWorkspaceState();
      }
      return this.handleToolchainChanged(status);
    }
  });

  private editorInstance!: EditorView;
  private editorExtensions: Extension = [];
  private readonly performanceController = new PerformanceController({
    isLogEnabled: category => this.isDeveloperLogEnabled(category),
    appendLog: entry => this.appendDeveloperLog(entry),
    previewMemorySnapshot: () => this.previewFrame.memorySnapshot(),
    lastPdfPath: () => this.lastPdfPath,
    openTabCount: () => this.openTabs.length,
    openDocumentUtf16: () => this.openTabs.reduce((total, tab) => total + tab.content.length, 0),
    editorUndoDepth: () => this.editorInstance?.state ? undoDepth(this.editorInstance.state) : 0,
  });
  private readonly editorController = new EditorController({
    isLowMemoryMode: () => this.settingsController.value.preview.lowMemoryMode,
    performanceEnabled: () => this.isDeveloperLogEnabled("performance"),
    recordPerformance: metric => this.performanceController.record(metric),
    logLayoutRefresh: reason => this.appendDeveloperLog({
      kind: "log",
      source: "editor layout",
      message: `Requested CodeMirror layout refresh after ${reason}.`,
    }),
    suppressPreviewSync: durationMs => this.previewSyncController.suppressForwardFor(durationMs),
    revealPreviewAtCursor: cursor => void this.previewSyncController.renderAtCursor(cursor),
    activePath: () => this.activeFilePath,
    pathKey: filePathKey,
    contentMutationDelay: () => this.effectivePreviewRenderMode === "on-type"
      ? Math.min(300, this.settingsController.value.preview.syncDebounceMs)
      : 300,
    onContentMutationStart: path => {
      if (
        this.effectivePreviewRenderMode === "on-type"
        && activeFileCanRenderPreview(
          path,
          this.pinnedMainFilePath,
          this.previewImported,
          this.previewDisabled,
        )
      ) this.invalidatePreviewWork("editor input");
    },
    onContentMutation: (_path, text, previewDebounceElapsedMs) => {
      this.configureDocumentLanguageTools(text);
      this.editorFontManager.scheduleDocumentUpdate(text);
      this.handleContentMutation(text, previewDebounceElapsedMs);
    },
    onFoldStateChanged: ranges => {
      const tab = this.getActiveTab();
      if (!tab) return;
      tab.foldStateExplicit = true;
      tab.foldRanges = ranges;
      void this.saveWorkspaceState();
    },
  });
  private readonly editorFontManager = new EditorFontManager(() => this.editorInstance);
  private readonly markdownEditorLanguage = markdown({ base: markdownLanguage });
  private readonly spellcheckController = new SpellcheckController(
    () => this.editorInstance,
    issues => this.updateSpellcheckLog(issues),
    metric => this.performanceController.record(metric),
    event => this.appendSpellcheckDebug(event),
  );
  private readonly settingsRuntimeController = new SettingsRuntimeController({
    projectTerminology: () => this.workspaceMetadata?.project.terminology ?? [],
    configureAutoSave: (enabled, intervalSeconds) => this.configureAutoSave(enabled, intervalSeconds),
    editorFontManager: this.editorFontManager,
    spellcheck: this.spellcheckController,
    syncPreviewTheme: () => this.previewFrame.syncTheme(),
    isPreviewOnlyWindow: () => this.previewWindowController.isPreviewOnlyWindow(),
    effectivePreviewRenderMode: () => this.effectivePreviewRenderMode,
    cancelOnTypeSchedule: () => this.pdfPreviewRenderController.cancelOnTypeSchedule(),
    prepareRenderProject: () => this.prepareRenderProjectIfNeeded(),
    refreshActivePreviewRoot: () => this.refreshActivePreviewRoot(),
    editor: () => this.editorInstance ?? null,
    currentEditorSettingsEffects: () => this.currentEditorSettingsEffects(),
    clearForwardSync: () => this.previewSyncController.clearForward(),
    applyLowMemoryMode: enabled => {
      document.documentElement.classList.toggle("low-memory-mode", enabled);
      this.previewSyncController.applyLowMemoryMode(enabled);
      this.editorController.scheduleMatchMarkers();
      if (enabled && this.documentSessionController.hasClient) {
        void this.stopTinymistSession("Low memory mode: compiler starts only while rendering");
      } else if (
        !enabled
        && this.workspaceRootPath
        && this.documentSessionController.hasClient
        && !this.documentSessionController.ready
      ) {
        void this.restartTinymistSession("Restoring Tinymist language services...")
          .then(() => this.restoreActiveDocumentAfterTinymistRestart())
          .catch(error => this.appendDeveloperLog({
            kind: "error",
            source: "lsp",
            message: `Failed to restore Tinymist after leaving low memory mode: ${String(error)}`,
          }));
      }
    },
    updateSettings: update => this.settingsController.update(update),
  });
  private get forwardSyncDebounceMs(): number { return this.settingsRuntimeController.forwardSyncDebounceMs; }
  private get lastPreviewRenderMode(): PreviewRefreshStyle | undefined { return this.settingsRuntimeController.lastPreviewRenderMode; }
  private set lastPreviewRenderMode(mode: PreviewRefreshStyle | undefined) { this.settingsRuntimeController.lastPreviewRenderMode = mode; }
  private explorer!: WorkspaceExplorer;
  private readonly documentSessionController = new DocumentSessionController({
    createClient: () => this.createTinymistClient(),
    resetSessionState: () => this.resetTinymistSessionState(),
    onConnected: () => this.handleTinymistConnected(),
    onRestarted: () => {
      // Temporary discovery documents can interfere with restoration of the
      // real workspace document immediately after a restart.
      this.surroundWithDiscoveryController.reset();
    },
    setStoppedStatus: message => this.setLspStatus({ kind: "stopped", message }),
    setStartingStatus: message => this.setLspStatus({ kind: "starting", message }),
    logLifecycle: message => this.appendDeveloperLog({
      kind: "info",
      source: "lsp lifecycle",
      message,
    }),
    logConnectionFailure: error => console.warn("Tinymist LSP instance offline.", error),
  });
  private readonly lspSyncController = new LspSyncController({
    session: () => this.documentSessionController,
    documents: () => this.lspDocumentController,
    client: () => this.documentSessionController.hasClient ? this.lspClient : undefined,
    ready: () => this.lspReady,
    activeFilePath: () => this.activeFilePath,
    activeTab: () => this.getActiveTab(),
    workspaceRootPath: () => this.workspaceRootPath,
    pinnedMainFilePath: () => this.pinnedMainFilePath,
    previewImported: () => this.previewImported,
    previewStandalone: () => this.previewStandalone,
    previewRenderMode: () => this.effectivePreviewRenderMode,
    syncDebounceMs: () => this.lspSyncDebounceMs,
    isLoadingFile: () => this.isLoadingFile,
    activeEditorText: () => this.editorInstance.state.doc.toString(),
    flushEditorContentMutation: () => this.flushEditorContentMutation(),
    resetPreviewSync: () => this.previewSyncController.reset(),
    prepareTemplateAwarePreview: (target, path, text) =>
      this.prepareTemplateAwarePreview(target, path, text),
    resolveLspDocument: (path, text) => this.getLspUriAndContent(path, text),
    updatePinnedMain: (path, force) => this.updatePinnedMain(path, force),
    recheckActiveDocumentAfterPin: text => this.recheckActiveDocumentAfterPin(text),
    refreshActivePreviewRoot: force => this.refreshActivePreviewRoot(force),
    appendLog: entry => this.appendDeveloperLog(entry),
  });
  private get lspClient(): TinymistLspClient {
    return this.documentSessionController.client;
  }
  private get lspReady(): boolean {
    return this.documentSessionController.ready;
  }
  private set lspReady(ready: boolean) {
    this.documentSessionController.setReady(ready);
  }
  private readonly pdfPreviewPreparationController = new PdfPreviewPreparationController({
    getActiveFilePath: () => this.activeFilePath,
    getPreviewRootPath: () => this.previewRootPath,
    getPreviewMainPath: () => this.previewMainPath,
    getPinnedMainFilePath: () => this.pinnedMainFilePath,
    isPreviewStandalone: () => this.previewStandalone,
    getWorkspaceRootPath: () => this.workspaceRootPath,
    getCacheRootPath: () => this.getCacheRootPath(),
    mapToOriginalPath: path => this.mapToOriginalPath(path),
    getOpenTabs: () => this.openTabs,
    isKhmerRenderPreparationEnabled: () => this.settingsController.value.preview.khmerRenderPreparation,
    getPreviewRenderMode: () => this.effectivePreviewRenderMode,
    getPreparationRevision: () => this.pdfPreparationRevision,
    getLspClient: () => this.lspClient,
    listOpenedDocumentUris: () => this.lspDocumentController.listOpenedUris(),
    addOpenedDocumentUri: uri => this.lspDocumentController.addOpenedUri(uri),
    removeOpenedDocumentUri: uri => this.lspDocumentController.removeOpenedUri(uri),
    nextDocumentVersion: () => this.lspDocumentController.nextVersion(),
    isRenderCachePath: path => this.isRenderCachePath(path),
    log: (kind, source, message) => this.appendDeveloperLog({ kind, source, message }),
  });
  private get pdfPreviewGeneratedFiles() {
    return this.pdfPreviewPreparationController.generatedFiles;
  }
  private readonly sourceLocationController = new SourceLocationController({
    workspaceRootPath: () => this.workspaceRootPath,
    activeFilePath: () => this.activeFilePath,
    editor: () => this.editorInstance,
    lspClient: () => this.documentSessionController.hasClient ? this.lspClient : undefined,
    loadFile: path => this.loadFile(path),
    activeTabContentLoaded: () => this.getActiveTab()?.contentLoaded === true,
    generatedPreviewText: path => this.pdfGeneratedPreviewText(path),
  });
  private readonly surroundWithDiscoveryController = new SurroundWithDiscoveryController({
    client: () => this.documentSessionController.hasClient ? this.lspClient : null,
    workspaceRootPath: () => this.workspaceRootPath,
    ready: () => this.lspReady,
    appendLog: (kind, message) => this.appendDeveloperLog({ kind, source: "lsp autocomplete", message }),
  });
  private get surroundWithOptions() { return this.surroundWithDiscoveryController.options; }

  private codePane = document.getElementById("code-editor-pane")!;
  private editorTabBar = document.getElementById("editor-tab-bar")!;
  private readonly editorTabViewController = new EditorTabViewController(this.editorTabBar, {
    tabs: () => this.openTabs,
    activeFilePath: () => this.activeFilePath,
    pinnedMainFilePath: () => this.pinnedMainFilePath,
    sortPinnedMainFirst: () => this.editorSessionController.sortPinnedMainFirst(this.pinnedMainFilePath),
    activateTab: path => this.activateEditorTab(path),
    closeTab: path => this.closeEditorTab(path),
    promoteTab: tab => this.promoteToPermanent(tab),
    reportActivationFailure: (path, error) => {
      console.error("Failed to load restored tab:", path, error);
      void message(`Could not open ${fileNameFromPath(path)}: ${String(error)}`, {
        title: "Unable to Open File",
        kind: "error"
      });
    },
  });
  private readonly editorFileGuardController = new EditorFileGuardController({
    previewFrame: () => this.previewFrame,
    onPdfBlocked: path => {
      this.blockedLargePdfPaths.add(filePathKey(path));
      this.pdfPreviewRenderController.cancelPendingPdfLoad();
      this.invalidatePreviewWork(`waiting for confirmation to open ${path}`);
    },
    onPdfUnblocked: path => this.blockedLargePdfPaths.delete(filePathKey(path)),
    onPdfReblocked: path => { this.blockedLargePdfPaths.add(filePathKey(path)); },
    onTypstPreviewBlocked: rootPath => {
      this.workspaceServicesDeferredForLargeFile = true;
      this.blockedLargePreviewRoot = rootPath;
    },
    approveLargePreview: (tab, notice) => this.approveLargePreviewForTab(tab, notice),
    activateConfirmedTab: path => this.activateEditorTab(path, false, { largeFileConfirmed: true }),
    onGuardedTabSelected: path => {
      this.activeFilePath = path;
      this.activateSpellcheckDocument(null);
      this.documentOutlineController.clear();
      this.clearDiagnostics();
      this.clearPendingLspSync();
      this.previewSyncController.clearForward();
      this.editorToolbarController.setDisabled(true);
      this.updatePreviewActionsToolbar(path);
      this.updateManualForwardSyncAction();
      this.updateWorkspaceViewportVisibility();
      this.renderEditorTabs();
      void this.saveWorkspaceState();
    },
  });
  private readonly tabStripController = new TabStripController(
    this.editorTabBar,
    document.getElementById("editor-tabs-previous") as HTMLButtonElement,
    document.getElementById("editor-tabs-next") as HTMLButtonElement
  );
  private editorVisualToolbar = document.getElementById("editor-visual-toolbar")!;
  private codeRenderPane = document.getElementById("code-render-pane")!;
  // WYSIWYM is intentionally disabled for this release. Keep a detached
  // container so the future adapter code can remain compiled without putting
  // the WYSIWYM pane into the active editor layout.
  private wysiwymPane = document.getElementById("wysiwym-editor-pane") as HTMLElement | null;
  private wysiwymContainer = this.wysiwymPane?.querySelector<HTMLElement>(".wysiwym-container") ?? document.createElement("div");
  private readonly wysiwymAdapter = new WysiwymAdapter(this.wysiwymContainer);
  private previewPane = document.getElementById("preview-render-pane")!;
  private readonly imageToolsController = new ImageToolsController(
    document.getElementById("image-tools-sidebar")!,
    document.getElementById("image-tools-inspector")!,
    document.getElementById("image-tools-comparison")!,
    reference => void this.navigateToImageReference(reference),
    (source, imagePath) => this.renderImageToolPreview(source, imagePath),
    (paths, phase) => this.handleImageToolFilesWritten(paths, phase),
  );
  private readonly sidebarController = new SidebarController({
    hasWorkspace: () => !!this.workspaceRootPath,
    isWorkspaceLoading: () => this.workspaceLoading,
    isActiveSurfaceNonText: () => {
      const path = this.activeFilePath;
      return !!path && (
        !this.isInternallySupportedPath(path)
        || isBinaryImagePath(path)
        || fileExtension(path) === "pdf"
      );
    },
    invalidatePreview: reason => this.invalidatePreviewWork(reason),
    showImageTools: () => {
      this.previewContentController.suspendDocumentPreviewForImageTools();
      this.imageToolsController.show();
    },
    hideImageTools: () => this.imageToolsController.hide(),
    showRestoringPreview: () => this.previewFrame.setMessage(
      `<div class="preview-disabled-placeholder"><div class="guardrail-placeholder-content">` +
      `<div class="preview-disabled-title preview-accent-title">Restoring Preview</div>` +
      `<div class="preview-disabled-msg">Preparing the active document preview.</div>` +
      `</div></div>`,
    ),
    restoreDocumentPreview: () => {
      if (!this.previewContentController.restoreMarkdownPreviewIfActive()) {
        void this.refreshActivePreviewRoot(false);
      }
    },
    setMainPreviewVisibleWhileUndocked: visible =>
      this.layoutController.setMainPreviewVisibleWhileUndocked(visible),
    reconcileDockedPaneWidths: () => this.layoutController.reconcileDockedPaneWidths(),
    persist: () => void this.saveWorkspaceState(),
  }, this.codeRenderPane, this.previewPane);
  private readonly previewController = new PreviewController(this.previewPane, {
    onPreviewClick: point => void this.handlePdfPreviewClick(point),
    onInteractionStatus: status => this.reportPreviewInteractionStatus(status),
    onZoomChanged: zoomPercent => this.updatePreviewZoomLabel(zoomPercent),
    onPerformance: metric => {
      this.performanceController.recordFirst(metric) ?? this.performanceController.record(metric);
    },
    onPageChanged: status => this.updatePreviewPageStatus(status),
    loadDraftImage: id => this.draftPreviewController.loadImage(id),
    onDocumentOutline: items => this.documentOutlineController.updatePreviewPositions(items),
    onScrollPositionChanged: scrollTop => {
      this.previewScrollTop = Math.max(0, scrollTop);
      const activeTab = this.getActiveTab();
      if (activeTab) activeTab.previewScrollTop = this.previewScrollTop;
      if (!this.workspaceRootPath || !this.workspaceMetadata) return;
      if (this.previewScrollSaveTimer !== null) window.clearTimeout(this.previewScrollSaveTimer);
      this.previewScrollSaveTimer = window.setTimeout(() => {
        this.previewScrollSaveTimer = null;
        void this.saveWorkspaceState();
      }, 750);
    },
    onLoadStage: (stage, detail) => {
      // Preview-only windows skip the workspace bootstrap. Their PDF lifecycle
      // is already represented by the main window's diagnostics.
      if (this.previewWindowController.isPreviewOnlyWindow()) return;
      return this.performanceController.logMemoryDiagnostics(`PDF ${stage}`, detail);
    },
    resolveMarkdownImage: (documentPath, source) => this.resolveMarkdownImage(documentPath, source),
    openMarkdownLink: (documentPath, href) => this.openMarkdownLink(documentPath, href),
  });
  private get previewFrame(): PreviewFrame { return this.previewController.pdf; }
  private get markdownPreviewFrame(): MarkdownPreviewFrame { return this.previewController.markdown; }
  private readonly sourceMapSessionController: SourceMapSessionController = new SourceMapSessionController({
    log: (source, kind, message) => this.appendDeveloperLog({ kind, source, message }),
    onPositionPayload: text => this.previewSyncController.handlePositionPayload(text),
    activeFilePath: () => this.activeFilePath,
    pathKey: filePathKey,
  });
  private readonly previewSyncController: PreviewSyncController = new PreviewSyncController({
    getEditor: () => this.editorInstance,
    getClient: () => this.lspClient,
    getActiveFilePath: () => this.activeFilePath,
    getPreviewRootPath: () => this.previewRootPath,
    getPreviewTaskId: () => this.previewTaskId,
    isReady: () => this.lspReady,
    isLowMemoryMode: () => this.settingsController.value.preview.lowMemoryMode,
    // TODO: Re-enable in prerelease v0.9.0 after improving performance and timeout reliability
    // isEnabled: () => this.settingsController.value.preview.cursorSync,
    isEnabled: () => false,
    handleForwardPosition: (path, cursor) => this.previewSyncController.handlePdfForward(path, cursor),
    mapForwardPosition: async () => null,
    sourceMap: this.sourceMapSessionController,
    getPdfContext: () => ({
      rootPath: this.pdfPreviewSourceMapRootPath ?? this.previewRootPath,
      taskId: this.pdfPreviewSourceMapTaskId ?? this.previewTaskId,
      previewUrl: this.previewFrame.currentUrl,
      previewGeneration: this.pdfPreviewGeneration,
      refreshStyle: previewRefreshStyle(this.effectivePreviewRenderMode),
      timeoutMs: this.settingsController.value.preview.forwardSyncTimeoutMs,
      externalRefreshPending: this.externalPreviewRefreshPending,
      previewRunning: this.pdfPreviewRunning,
      previewDisabled: this.previewDisabled,
      interactionBlocked: this.workspaceResumeController.interactionBlocked,
    }),
    isForwardPositionEligible: (path, cursor) => !(
      this.activeFilePath
      && filePathKey(path) === filePathKey(this.activeFilePath)
      && !isForwardSyncContentPosition(this.editorInstance.state, cursor)
    ),
    mapPdfForwardTarget: (path, cursor) => this.forwardSyncTarget(path, cursor),
    setStatus: status => this.setLspStatus(status),
    updateManualAction: (busy, available) => this.renderManualForwardSyncAction(busy, available),
    log: (source, kind, message) => this.appendDeveloperLog({ kind, source, message }),
    revealDocumentPosition: position => this.previewFrame.revealDocumentPosition(position, { ripple: true }),
    emitForwardPosition: position => {
      import("@tauri-apps/api/event").then(({ emit }) => {
        emit("pdf-forward-sync", position);
      }).catch(err => console.error("Error emitting pdf-forward-sync", err));
    },
  });
  private readonly logConsoleController = new LogConsoleController(entry => this.navigateToLogEntry(entry));
  private readonly developerLogController = new DeveloperLogController({
    logConsole: () => this.logConsoleController,
    activeFilePath: () => this.activeFilePath,
    developerLogging: () => ({
      enabled: this.settingsController.value.developerMode,
      categories: this.settingsController.value.developerLogs,
    }),
  });
  private readonly diagnosticsController = new DiagnosticsController(this.logConsoleController, {
    editor: () => this.editorInstance,
    client: () => this.lspClient,
    activeFilePath: () => this.activeFilePath,
    pathKey: filePathKey,
    mapToOriginalPath: path => this.mapToOriginalPath(path),
    isRenderCachePath: path => this.isRenderCachePath(path),
    previewImported: () => this.previewImported,
    previewStandalone: () => this.previewStandalone,
    latestDocumentVersion: () => this.latestDocumentVersion,
    hasPendingSync: path => this.documentSessionController.hasPendingSyncFor(path, filePathKey),
    spellcheck: () => this.spellcheckController,
    recordFirstDiagnostics: diagnosticCount => {
      if (this.diagnosticWaitStartedAt === null) return;
      this.performanceController.recordFirst({
        name: "diagnostics.first",
        milliseconds: performance.now() - this.diagnosticWaitStartedAt,
        detail: { diagnosticCount },
      });
      this.diagnosticWaitStartedAt = null;
    },
    logDeveloper: (kind, source, message) => this.appendDeveloperLog({ kind, source, message }),
    acceptedDiagnosticsChanged: diagnostics => this.recoverPreviewAfterAcceptedDiagnostics(diagnostics),
    openDiagnosticFile: async path => {
      const previewSession = this.previewRootPath ? this.capturePreviewSession() : undefined;
      await this.loadFile(path, { preservePreviewSession: previewSession });
    },
    activeTabContentLoaded: () => this.getActiveTab()?.contentLoaded === true,
    editorPositionFromSourceLocation: (line, column) => this.editorPositionFromSourceLocation(line, column),
  });
  private readonly previewFailureController = new PreviewFailureController(this.logConsoleController, {
    mapToOriginalPath: path => this.mapToOriginalPath(path),
    sourceForPath: async path => {
      const generated = this.pdfPreviewGeneratedFiles.get(filePathKey(path));
      const openTab = this.openTabs.find(tab => filePathKey(tab.path) === filePathKey(path));
      return generated?.preparedText
        ?? (openTab?.contentLoaded ? openTab.content : null)
        ?? await invoke<string>("read_workspace_file", { path }).catch(() => "");
    },
    isRenderCachePath: path => this.isRenderCachePath(path),
    includePrimaryCompilerDiagnostic: () => this.settingsController.value.preview.lowMemoryMode,
    setCompilerRelatedDiagnostics: entries =>
      this.diagnosticsController.setCompilerRelatedDiagnostics(entries),
  });
  private readonly previewDiagnosticsRecoveryController = new PreviewDiagnosticsRecoveryController({
    activeFilePath: () => this.activeFilePath,
    pinnedMainFilePath: () => this.pinnedMainFilePath,
    previewImported: () => this.previewImported,
    previewDisabled: () => this.previewDisabled,
    renderMode: () => this.effectivePreviewRenderMode,
    editorText: () => this.editorInstance.state.doc.toString(),
    previewFrame: () => this.previewFrame,
    renderPdfPreview: contents => { void this.renderPdfPreview(contents); },
    log: message => this.appendDeveloperLog({ kind: "info", source: "preview scheduler", message }),
  });
  private readonly layoutController = new LayoutController(
    () => this.saveWorkspaceState(),
    () => this.logConsoleController.setVisible(false),
    message => this.appendDeveloperLog({ kind: "info", source: "preview layout", message }),
    () => this.workspaceResumeController.beginHorizontalResize(),
    () => this.workspaceResumeController.endHorizontalResize()
  );
  private readonly workspaceController = new WorkspaceController({
    dockPreview: () => this.layoutController.dockPreview(),
    applySidebarVisibility: () => this.sidebarController.applyVisibility(),
    pathKey: filePathKey,
    handleWorkspaceChange: change => this.handleWorkspaceChange(change),
    reportWatchError: error => this.reportWorkspaceWatchError(error),
    persistActiveTabState: () => this.persistActiveTabState(),
    persistenceSnapshot: () => ({
      rootPath: this.workspaceRootPath,
      metadata: this.workspaceMetadata,
      activeFilePath: this.activeFilePath,
      pinnedMainFilePath: this.pinnedMainFilePath,
      recommendedToolchain: this.recommendedWorkspaceToolchain,
      selectedToolchain: this.selectedWorkspaceToolchain,
      openTabs: this.openTabs,
      expandedDirectories: this.explorer.expandedDirectoryPaths(),
      inputContainerWidthPct: this.layoutController.getDockedInputWidthPct(),
      explorerSidebarWidthPx: parseInt(
        document.getElementById("explorer-sidebar")?.style.width ?? "",
        10,
      ) || DEFAULT_EXPLORER_WIDTH_PX,
      sidebarVisible: this.sidebarController.visible,
      activeSidebarTool: this.sidebarController.activeTool,
      previewContentMode: this.draftPreviewController.mode,
      previewRenderMode: this.effectivePreviewRenderMode,
      previewScrollTop: this.previewScrollTop,
    }),
    setWorkspaceMetadata: metadata => {
      this.workspaceMetadata = metadata;
    },
    reportPersistenceError: error => this.appendDeveloperLog({
      kind: "error",
      source: "workspace",
      message: `Failed to save workspace state: ${String(error)}`,
    }),
  });
  private readonly workspacePathRenameController = new WorkspacePathRenameController({
    workspaceRootPath: () => this.workspaceRootPath,
    workspace: () => this.workspaceController,
    imageTools: () => this.imageToolsController,
    typography: () => this.typographyController,
    documentSession: () => this.documentSessionController,
    previewSession: () => this.previewSessionController,
    previewPreparation: () => this.pdfPreviewPreparationController,
    previewRender: () => this.pdfPreviewRenderController,
    lspDocuments: () => this.lspDocumentController,
    openTabs: () => this.openTabs,
    activeFilePath: () => this.activeFilePath,
    setActiveFilePath: path => { this.activeFilePath = path; },
    pinnedMainFilePath: () => this.pinnedMainFilePath,
    setPinnedMainFilePath: path => { this.pinnedMainFilePath = path; },
    setExplorerActiveFile: path => this.explorer.setActiveFile(path),
    activateSpellcheckDocument: path => this.activateSpellcheckDocument(path),
    sortPinnedMainFirst: path => this.editorSessionController.sortPinnedMainFirst(path),
    renderTabs: () => this.renderEditorTabs(),
    saveWorkspaceState: () => this.saveWorkspaceState(),
    reloadOpenFilesFromDisk: force => this.reloadOpenFilesFromDisk(force),
    handleImageToolFilesWritten: (paths, phase) => this.handleImageToolFilesWritten(paths, phase),
    prepareRenderProjectIfNeeded: () => this.prepareRenderProjectIfNeeded(),
    refreshActivePreviewRoot: force => this.refreshActivePreviewRoot(force),
    appendLog: entry => this.appendDeveloperLog(entry),
  });
  private readonly workspaceLifecycleController = new WorkspaceLifecycleController(
    this.createWorkspaceLifecycleDependencies(),
  );
  private readonly imagePreviewController = new ImagePreviewController({
    setMessage: html => this.previewFrame.setMessage(html),
    setError: (title, detail) => this.previewFrame.setError(title, detail),
    updateToolbar: path => this.updatePreviewActionsToolbar(path),
    updateZoomLabel: scale => this.updatePreviewZoomLabel(scale),
  });
  private readonly projectImportController = new ProjectImportController({
    setStatus: status => this.setLspStatus(status),
    selectToolchainVersion: version => this.settingsController.update(settings => {
      settings.toolchain.tinymistVersion = version;
    }),
    handleToolchainChanged: status => this.handleToolchainChanged(status),
    completeImport: (imported, projectName) => this.completeProjectImport(imported, projectName),
  });
  private readonly externalWorkspaceController = new ExternalWorkspaceController({
    workspaceRoot: () => this.workspaceRootPath,
    pathKey: filePathKey,
    openTabPaths: () => this.openTabs.map(tab => tab.path),
    conflictPaths: () => this.externalConflictPaths,
    managedPathKeys: () => new Set([
      ...this.managedPreviewPdfPathKeys,
      ...this.managedImageToolPathKeys,
    ]),
    reloadOpenFiles: refreshPreview => this.reloadOpenFilesFromDisk(refreshPreview),
    lspClient: () => this.lspClient,
    lspReady: () => this.lspReady,
    loadExplorer: rootPath => this.explorer.loadWorkspace(rootPath),
    refreshImageTools: () => { void this.imageToolsController.refresh(); },
    imageToolsActive: () => this.sidebarController.activeTool === "images",
    clearDiagnostics: () => this.clearDiagnostics(),
    retireSourceMap: reason => this.retirePdfSourceMapSession(reason),
    refreshPreview: force => this.refreshActivePreviewRoot(force),
    waitForPreviewRefresh: () => this.waitForExternalPreviewRefresh(),
    setRefreshPending: pending => { this.externalPreviewRefreshPending = pending; },
    updateForwardSyncAction: () => this.updateManualForwardSyncAction(),
    log: (kind, message) => this.appendDeveloperLog({ kind, source: "workspace", message }),
  });
  private readonly typographyController: TypographyController = new TypographyController({
    getWorkspaceRootPath: () => this.workspaceRootPath,
    readWorkspaceText: path => this.workspaceText(path),
    logWarning: message => this.appendDeveloperLog({
      kind: "warning",
      source: "typography",
      message,
    }),
    getActiveFilePath: () => this.activeFilePath,
    getActiveDocumentText: () => this.editorInstance.state.doc.toString(),
    dispatchDocumentEdit: (edit, userEvent) => this.editorInstance.dispatch({
      changes: edit,
      userEvent,
    }),
    synchronizeDocumentTypography: config =>
      this.editorToolbarController.synchronizeDocumentTypography(config),
    isPinnedMainFile: path => this.isPinnedMainFile(path),
    getPinnedMainFilePath: () => this.pinnedMainFilePath,
    isPreviewImported: () => this.previewImported,
    getPreviewDebounceMs: () => this.settingsController.value.preview.syncDebounceMs,
    getPreviewRootPath: () => this.previewRootPath,
    getPreviewMainPath: () => this.previewMainPath,
    isPreviewStandalone: () => this.previewStandalone,
    isLargePreviewBlocked: () => Boolean(this.blockedLargePreviewRoot),
    hasLspClient: () => this.lspReady && this.documentSessionController.hasClient,
    restartTinymistSession: status => this.restartTinymistSession(status),
    restoreActiveDocumentAfterRestart: () => this.restoreActiveDocumentAfterTinymistRestart(),
    refreshActivePreviewRoot: force => this.refreshActivePreviewRoot(force),
    updatePinnedMain: (path, force) => this.updatePinnedMain(path, force),
    recheckActiveDocumentAfterPin: text => this.recheckActiveDocumentAfterPin(text),
    resetSourceMap: () => this.sourceMapSessionController.reset({ retry: false }),
    setPreviewLoading: text => this.previewFrame.setLoading(text),
    appendLog: (kind, source, text) => {
      if (kind === "error") {
        this.appendLspLog({ kind, source, message: text });
      } else {
        this.appendDeveloperLog({ kind, source, message: text });
      }
    },
  });
  private readonly documentFormattingController = new DocumentFormattingController({
    activeFilePath: () => this.activeFilePath,
    activeMode: () => this.activeMode,
    lspReady: () => this.lspReady,
    client: () => this.documentSessionController.hasClient ? this.lspClient : undefined,
    editor: () => this.editorInstance,
    tabSize: () => this.settingsController.value.editor.tabSize,
    flushPendingLspSync: () => this.flushPendingLspSync(),
    reloadWorkspaceFonts: () => this.typographyController.reloadWorkspaceFonts(),
    setLspStatus: status => this.setLspStatus(status),
    appendLspLog: entry => this.appendLspLog(entry),
    appendDeveloperLog: entry => this.appendDeveloperLog(entry),
  });
  private readonly documentTypographyApplicationController = new DocumentTypographyApplicationController({
    activeFilePath: () => this.activeFilePath,
    editor: () => this.editorInstance,
    typography: () => this.typographyController,
    workspaceText: () => this.workspaceTextController,
    isPinnedMainFile: path => this.isPinnedMainFile(path),
    previewStandalone: () => this.previewStandalone,
    previewMainPath: () => this.previewMainPath,
    workspaceRootPath: () => this.workspaceRootPath,
    saveActiveFile: () => this.saveActiveFile(),
    refreshActivePreviewRoot: fontsChanged => this.refreshActivePreviewRoot(fontsChanged),
    configureDocumentLanguageTools: text => this.configureDocumentLanguageTools(text),
    setMainDocumentScripts: fonts => { this.mainDocumentScripts = fonts; },
    setLspStatus: status => this.setLspStatus(status),
    appendLspLog: entry => this.appendLspLog(entry),
  });
  private readonly pinnedMainTypographyController = new PinnedMainTypographyController({
    typography: () => this.typographyController,
    workspaceRootPath: () => this.workspaceRootPath,
    readWorkspaceText: path => this.workspaceText(path),
    writeWorkspaceText: (path, text) => this.writeWorkspaceText(path, text),
    appendLog: (kind, source, text) => this.appendLspLog({ kind, source, message: text }),
  });
  private readonly documentLanguageService = new DocumentLanguageService();
  private readonly recentProjectsController = new RecentProjectsController(
    path => this.openWorkspace(path),
    async path => {
      await message(
        `Typsastra could not find this project folder:\n\n${path}\n\nIt will be removed from your recent projects.`,
        {
          title: "Recent Project Not Found",
          kind: "warning",
          buttons: { ok: "Remove from Recent Projects" }
        }
      );
    }
  );
  private nativeAppMenu: NativeAppMenuHandle | null = null;
  private readonly editorToolbarController = new EditorToolbarController({
    getMode: () => this.activeMode,
    getEditor: () => this.editorInstance,
    wysiwymContainer: this.wysiwymContainer,
    serializeWysiwym: () => this.mapWysiwymToMarkup(),
    renderWysiwym: markup => this.mapMarkupToWysiwym(markup),
    save: () => this.saveActiveFile(),
    syncPreview: cursor => this.previewSyncController.renderAtCursor(cursor),
    applyTypography: (config, target) => this.applyTypography(config, target),
    getWorkspaceRoot: () => this.workspaceRootPath,
    onWorkspacePrivateFontDirectoriesChanged: () => this.typographyController.privateFontDirectoriesChanged()
    // TODO: Re-enable when the WYSIWYM layout is ready for use.
    // toggleMode: () => this.switchViewLayoutMode()
  });
  private readonly contextMenuController = new ContextMenuController({
    getWorkspaceRoot: () => this.workspaceRootPath,
    getActiveFile: () => this.activeFilePath,
    getEditor: () => this.editorInstance,
    getExplorer: () => this.explorer,
    getExplorerForElement: element => element.closest(".image-tool-list")
      ? this.imageToolsController.getExplorer()
      : this.explorer,
    refreshSecondaryExplorer: () => this.sidebarController.activeTool === "images"
      ? this.imageToolsController.refresh()
      : undefined,
    getPreviewFrame: () => this.previewFrame.element,
    getPreviewColorMode: () => this.settingsController.value.preview.colorMode,
    setPreviewColorMode: mode => this.settingsController.update(settings => {
      settings.preview.colorMode = mode;
    }),
    loadFile: path => this.loadFile(path),
    save: () => this.saveActiveFile(),
    renameWorkspacePath: (oldPath, newPath, updateImageReferences) =>
      this.renameWorkspacePath(oldPath, newPath, updateImageReferences),
    closeTab: path => this.closeEditorTab(path, true),
    closeTabInteractive: path => this.closeEditorTab(path, false),
    closeOtherTabs: path => this.closeOtherTabs(path),
    restartWorkspace: () => this.restartWorkspace(),
    getSpellingIssue: (x, y, target) => {
      if (target) {
        const spellingSpan = target.closest(".cm-spelling-unknown, .cm-spelling-ignored");
        if (spellingSpan) {
          try {
            let pos = spellingSpan.firstChild ? this.editorInstance.posAtDOM(spellingSpan.firstChild) : null;
            if (pos === null) {
              pos = this.editorInstance.posAtDOM(spellingSpan);
            }
            if (pos !== null) {
              const issue = this.spellcheckController.issueAt(pos);
              if (issue) return issue;
            }
          } catch (e) {
            console.error("posAtDOM failed in getSpellingIssue:", e);
          }
        }
      }
      
      try {
        let position = this.editorInstance.posAtCoords({ x, y });
        if (position === null) {
          position = this.editorInstance.state.selection.main.head;
        }
        const issue = this.spellcheckController.issueAt(position);
        if (issue) return issue;
      } catch (e) {
        console.error("posAtCoords or line lookup failed in getSpellingIssue:", e);
      }
      return null;
    },
    getSpellingIssuesInRange: (from, to) => this.spellcheckController.issuesInRange(from, to),
    getSpellingSuggestions: issue => this.spellcheckController.suggestions(issue),
    replaceSpelling: (issue, replacement) => this.spellcheckController.replace(issue, replacement),
    addSpellingToDictionary: words => this.settingsController.update(settings => {
      for (const word of words) {
        if (!settings.editor.userDictionary.includes(word)) {
          settings.editor.userDictionary.push(word);
        }
      }
    }),
    addSpellingTerminology: (issue, scope) => {
      const entry = { term: issue.sourceText, exactCase: true };
      if (scope === "project") {
        if (!this.workspaceMetadata) return;
        const existing = this.workspaceMetadata.project.terminology;
        if (!existing.some(candidate => candidate.term === entry.term && candidate.exactCase === entry.exactCase)) {
          this.workspaceMetadata.project.terminology = [...existing, entry];
          this.settingsController.setProjectTerminology(this.workspaceMetadata.project.terminology);
          this.spellcheckController.setTerminology(
            this.settingsController.value.editor.globalTerminology,
            this.workspaceMetadata.project.terminology,
            this.settingsController.value.editor.languageTerminology,
            this.settingsController.value.editor.scopedIgnoredWords,
          );
          void this.saveWorkspaceState();
        }
        return;
      }
      this.settingsController.update(settings => {
        if (scope === "languageFamily" && issue.languageFamily) {
          if (!settings.editor.languageTerminology.some(candidate =>
            candidate.term === entry.term && candidate.languageFamily === issue.languageFamily)) {
            settings.editor.languageTerminology.push({ ...entry, languageFamily: issue.languageFamily });
          }
        } else if (!settings.editor.globalTerminology.some(candidate => candidate.term === entry.term)) {
          settings.editor.globalTerminology.push(entry);
        }
      });
    },
    setSpellingIgnored: (issue, ignored) => this.settingsController.update(settings => {
      if (ignored) {
        const entry = issue.languageFamily
          ? { term: issue.sourceText, scope: "languageFamily" as const, languageFamily: issue.languageFamily }
          : { term: issue.sourceText, scope: "global" as const };
        if (!settings.editor.scopedIgnoredWords.some(candidate => candidate.term === entry.term
          && candidate.scope === entry.scope && candidate.languageFamily === entry.languageFamily)) {
          settings.editor.scopedIgnoredWords.push(entry);
        }
      } else {
        settings.editor.ignoredWords = settings.editor.ignoredWords.filter(word => word !== issue.word);
        settings.editor.scopedIgnoredWords = settings.editor.scopedIgnoredWords.filter(entry =>
          entry.term !== issue.sourceText || (entry.languageFamily && entry.languageFamily !== issue.languageFamily));
      }
    }),
    isPinnedMainFile: path => this.isPinnedMainFile(path),
    setPinnedMainFile: path => this.setPinnedMainFile(path),
    getPinnedMainFile: () => this.pinnedMainFilePath,
    canRevealCursorInPreview: () => this.previewSyncController.canRevealManually()
      && isForwardSyncContentPosition(
        this.editorInstance.state,
        this.editorInstance.state.selection.main.head
      ),
    revealCursorInPreview: () => this.revealCursorInPreviewManually(),
    getSurroundWithOptions: () => this.surroundWithOptions,
  });
  private readonly documentOutlineController = new DocumentOutlineController(
    document.getElementById("document-outline-tree")!,
    document.getElementById("document-outline-section")!,
    heading => void this.navigateToOutlineHeading(heading),
    heading => this.outlineNavigationController.revealInPreview(heading),
  );
  private readonly outlineNavigationController = new OutlineNavigationController({
    activeTab: () => this.getActiveTab(),
    activeFilePath: () => this.activeFilePath,
    activeMode: () => this.activeMode,
    promoteToPermanent: tab => this.promoteToPermanent(tab),
    loadFile: (path, options) => this.loadFile(path, options),
    activeTabContentLoaded: () => this.getActiveTab()?.contentLoaded === true,
    switchToCodeMode: () => { if (this.activeMode === "WYSIWYM") this.switchViewLayoutMode(); },
    outline: () => this.documentOutlineController,
    previewSync: () => this.previewSyncController,
    previewFrame: () => this.previewFrame,
    editor: () => this.editorInstance,
  });
  private readonly appDialogController = new AppDialogController();
  private readonly releaseSummaryController = new ReleaseSummaryController();
  private readonly draftPreviewController = new DraftPreviewController(
    this.appDialogController,
    {
      activeFilePath: () => this.activeFilePath,
      workspaceRootPath: () => this.workspaceRootPath,
      editor: () => this.editorInstance ?? null,
      previewFrame: () => this.previewFrame,
      previewPageStatus: () => this.previewPageStatus,
      previewGeneration: () => this.pdfPreviewGeneration,
      renderMode: () => this.effectivePreviewRenderMode,
      saveWorkspaceState: () => this.saveWorkspaceState(),
      invalidatePreviewWork: reason => this.invalidatePreviewWork(reason),
      refreshActivePreviewRoot: force => this.refreshActivePreviewRoot(force),
      setPreviewRenderMode: mode => this.setPreviewRenderMode(mode),
      setImageOptimizationIssues: entries => this.logConsoleController.setImageOptimizationIssues(entries),
      setEditorWarnings: warnings => {
        if (!this.editorInstance) return;
        this.editorInstance.dispatch({ effects: setImageOptimizationWarningsEffect.of(warnings) });
      },
      showImages: async imagePath => {
        this.sidebarController.setTool("images");
        if (imagePath) await this.imageToolsController.selectImage(imagePath);
      },
      log: (kind, source, message) => this.appendDeveloperLog({ kind, source, message }),
    },
  );
  private readonly appUpdateController = new AppUpdateController(
    () => this.openTabs.some(tab => tab.isDirty),
    this.appDialogController
  );
  private readonly projectExportController = new ProjectExportController({
    activeFilePath: () => this.activeFilePath,
    activeContents: () => this.editorInstance.state.doc.toString(),
    previewStandalone: () => this.previewStandalone,
    previewRootPath: () => this.previewRootPath,
    previewMainPath: () => this.previewMainPath,
    workspaceRootPath: () => this.workspaceRootPath,
    cacheRootPath: () => this.getCacheRootPath(),
    mapToOriginalPath: path => this.mapToOriginalPath(path),
    openTabs: () => this.openTabs,
    khmerRenderPreparationEnabled: () => this.settingsController.value.preview.khmerRenderPreparation,
    setLspStatus: status => this.setLspStatus(status),
  });
  private readonly documentPersistenceController = new DocumentPersistenceController({
    activeFilePath: () => this.activeFilePath,
    activeMode: () => this.activeMode,
    workspaceRootPath: () => this.workspaceRootPath,
    openTabs: () => this.openTabs,
    isInternallySupportedPath: path => this.isInternallySupportedPath(path),
    flushEditorContentMutation: () => this.flushEditorContentMutation(),
    formatOnSave: () => this.settingsController.value.editor.formatOnSave,
    autoSaveSettings: () => ({
      enabled: this.settingsController.value.editor.autoSave,
      intervalSeconds: this.settingsController.value.editor.autoSaveIntervalSeconds,
    }),
    formatActiveDocument: options => this.formatActiveDocument(options),
    removeTrailingSpaces: () => this.removeTrailingSpaces(),
    editorText: () => this.editorInstance.state.doc.toString(),
    wysiwymMarkup: () => this.mapWysiwymToMarkup(),
    isPinnedMainFile: path => this.isPinnedMainFile(path),
    refreshWorkspaceExplorer: async workspaceRootPath => {
      await this.explorer.loadWorkspace(workspaceRootPath);
    },
    loadFile: path => this.loadFile(path),
    setPinnedMainFile: path => this.setPinnedMainFile(path),
    lspReady: () => this.lspReady && Boolean(this.lspClient),
    flushPendingLspSync: () => this.flushPendingLspSync(),
    notifyLspSave: async (path, content) => {
      const lspRes = await this.getLspUriAndContent(path, content);
      if (!lspRes) return;
      await this.lspClient.notifyTextSave(lspRes.uri, lspRes.content);
    },
    logMemoryDiagnostics: reason => this.performanceController.logMemoryDiagnostics(reason),
    clearExternalConflict: path => this.externalConflictPaths.delete(filePathKey(path)),
    renderEditorTabs: () => this.renderEditorTabs(),
    shouldRenderPreviewAfterManualSave: path => (
      participatesInPreviewCompilation(path, this.pinnedMainFilePath, this.previewImported)
      && !this.previewDisabled
    ),
    renderPdfPreview: content => this.renderPdfPreview(content),
    setLspStatus: status => this.setLspStatus(status),
    log: (kind, source, message) => this.appendDeveloperLog({ kind, source, message }),
  });
  private readonly webviewStorageController = new WebviewStorageController(() =>
    this.pdfPreviewRunning
    || this.typographyController.fontUpdateInProgress
    || this.projectExportController.isBusy
    || this.settingsController.isLanguageProviderOperationInProgress
    || this.toolchainController.isBusy
    || this.appUpdateController.isInstalling,
    () => this.getCacheRootPath(),
  );
  private readonly workspaceResumeController = new WorkspaceResumeController({
    canDeferWordWrap: () => Boolean(this.editorInstance) && this.settingsController.value.editor.wordWrap,
    disableWordWrap: () => {
      this.editorInstance.dispatch({ effects: wrapCompartment.reconfigure([]) });
    },
    restoreWordWrap: () => {
      this.editorInstance.dispatch({
        effects: wrapCompartment.reconfigure(
          this.settingsController.value.editor.wordWrap ? EditorView.lineWrapping : []
        )
      });
      this.editorController.refreshLayout("resize completed");
    },
    suspendPreviewResize: () => this.previewFrame.suspendResizeLayout(),
    resumePreviewResize: () => this.previewFrame.resumeResizeLayout(),
    recoverInterruptedResize: () => this.layoutController.recoverInterruptedResize(),
    hasActiveWorkspaceDocument: () => Boolean(this.workspaceRootPath && this.activeFilePath),
    cancelManualForwardSync: () => this.cancelManualForwardSync(),
    resetSourceMap: () => this.sourceMapSessionController.reset(),
    restoreEditorFonts: async () => {
      await this.editorFontManager.ready();
      if (this.editorInstance) this.editorFontManager.updateDocument(this.editorInstance.state.doc.toString());
    },
    rehydratePreviewAndSidebar: () => {
      this.previewFrame.syncTheme();
      if (this.workspaceRootPath) this.sidebarController.applyVisibility();
      this.layoutController.reconcileDockedPaneWidths();
    },
    remeasureWorkspace: reason => {
      this.layoutController.reconcileDockedPaneWidths();
      this.editorInstance?.requestMeasure();
      this.editorController.updateCaretMarker();
      this.editorController.updateDiagnosticMarkers();
      this.previewFrame.syncTheme();
      this.appendDeveloperLog({
        kind: "log",
        source: "editor layout",
        message: `Rehydrated workspace layout after ${reason}.`
      });
    },
    canWarmSourceMap: () => Boolean(
      this.lspReady
      && this.previewFrame.currentUrl
      && this.pdfPreviewGeneration > 0
      && !this.pdfPreviewRunning
    ),
    warmSourceMap: () => this.schedulePdfSourceMapWarmup(this.pdfPreviewGeneration),
    log: (kind, source, message) => this.appendDeveloperLog({ kind, source, message }),
  });
  private readonly pdfPreviewRenderController = new PdfPreviewRenderController({
    previewFrame: this.previewFrame,
    preparation: this.pdfPreviewPreparationController,
    draftPreview: this.draftPreviewController,
    typography: this.typographyController,
    performance: this.performanceController,
    workspaceResume: this.workspaceResumeController,
    previewFailure: this.previewFailureController,
    logConsole: this.logConsoleController,
    getLspClient: () => this.lspClient,
    isLspReady: () => this.lspReady,
    getActiveFilePath: () => this.activeFilePath,
    getPinnedMainFilePath: () => this.pinnedMainFilePath,
    isPreviewImported: () => this.previewImported,
    isPreviewDisabled: () => this.previewDisabled,
    getPreviewRootPath: () => this.previewRootPath,
    getPreviewSessionKey: () => this.previewSessionKey,
    getWorkspaceRootPath: () => this.workspaceRootPath,
    getPreviewRenderMode: () => this.effectivePreviewRenderMode,
    isLowMemoryMode: () => this.settingsController.value.preview.lowMemoryMode,
    ensureLargePreviewApproved: rootPath => this.ensureLargePreviewApproved(rootPath),
    isPdfBlocked: path => this.blockedLargePdfPaths.has(filePathKey(path)),
    getCacheRootPath: () => this.getCacheRootPath(),
    getEditorText: () => this.editorInstance.state.doc.toString(),
    cancelManualForwardSync: () => this.cancelManualForwardSync(),
    updateManualForwardSyncAction: () => this.updateManualForwardSyncAction(),
    setLspStatus: status => this.setLspStatus(status),
    scheduleSourceMapWarmup: generation => this.schedulePdfSourceMapWarmup(generation),
    recoverTinymistPreviewAfterUnexpectedStop: (contents, generation) =>
      this.recoverTinymistPreviewAfterUnexpectedStop(contents, generation),
    isRenderCachePath: path => this.isRenderCachePath(path),
    mapToOriginalPath: path => this.mapToOriginalPath(path),
    navigateToCompilerLocation: (filePath, line, column) => {
      void this.navigateToLogEntry({
        kind: "error",
        source: "typst(compiler)",
        message: "Compiler source location",
        filePath,
        line,
        column,
      });
    },
    log: (kind, source, message) => this.appendDeveloperLog({ kind, source, message }),
    onRenderSucceeded: () => {
      this.previewDiagnosticsRecoveryController.onRenderSucceeded();
      this.tinymistPreviewRecoveryController.resetAttempts();
    },
    onRenderFailed: contents => this.previewDiagnosticsRecoveryController.onRenderFailed(contents),
  });
  private readonly tinymistPreviewRecoveryController = new TinymistPreviewRecoveryController({
    workspaceRootPath: () => this.workspaceRootPath,
    activeFilePath: () => this.activeFilePath,
    hasClient: () => this.documentSessionController.hasClient,
    lspReady: () => this.lspReady,
    previewFrame: () => this.previewFrame,
    restartTinymistSession: status => this.restartTinymistSession(status),
    restoreActiveDocumentAfterRestart: () => this.restoreActiveDocumentAfterTinymistRestart(false),
    queueRecovery: contents => this.pdfPreviewRenderController.queueRecovery(contents),
    setLspStatus: status => this.setLspStatus(status),
    appendLog: (kind, message) => this.appendDeveloperLog({ kind, source: "lsp lifecycle", message }),
  });
  private readonly tinymistIntegrationController = new TinymistIntegrationController({
    workspaceRootPath: () => this.workspaceRootPath,
    editor: () => this.editorInstance,
    setLspStatus: status => this.setLspStatus(status),
    handleInverseSync: (uri, position) => this.handleInverseSync(uri, position),
    handleDiagnostics: (uri, diagnostics, version) => this.handleLspDiagnostics(uri, diagnostics, version),
    appendLspLog: entry => this.appendLspLog(entry),
    updateOutlinePreviewPositions: items => this.documentOutlineController.updatePreviewPositions(items),
    discoverSurroundWithOptions: () => this.discoverSurroundWithOptions(),
    resetSurroundWithDiscovery: () => this.surroundWithDiscoveryController.reset(),
    resetSourceMap: options => this.sourceMapSessionController.reset(options),
    resetSourceMapIfTaskFailed: taskId => this.sourceMapSessionController.resetIfTaskFailed(taskId),
    resetLspDocuments: () => this.lspDocumentController.resetSessionState(),
    clearPendingLspSync: () => this.clearPendingLspSync(),
    clearForwardSync: () => this.previewSyncController.clearForward(),
    clearDiagnostics: () => this.clearDiagnostics(),
    clearSourceMapWarmup: () => this.previewSyncController.clearWarmup(),
    resetPdfSourceMapIdentity: () => this.pdfPreviewRenderController.resetSourceMapIdentity(),
    setLspReady: ready => { this.lspReady = ready; },
    appendDeveloperLog: entry => this.appendDeveloperLog(entry),
    activeFilePath: () => this.activeFilePath,
    previewRootPath: () => this.previewRootPath,
    previewMainPath: () => this.previewMainPath,
    setToolchainStatus: status => this.toolchainController.setStatus(status),
    clearPreview: () => this.previewFrame.clear(),
    initializeLsp: shouldConnect => this.initLsp(
      shouldConnect && !this.settingsController.value.preview.lowMemoryMode,
    ),
    reactivateFile: async path => {
      this.activeFilePath = null;
      await this.activateEditorTab(path, false);
    },
  });
  private readonly previewSourceNavigationController = new PreviewSourceNavigationController({
    previewSync: this.previewSyncController,
    draftPreview: this.draftPreviewController,
    preparation: this.pdfPreviewPreparationController,
    getEditor: () => this.editorInstance,
    getActiveFilePath: () => this.activeFilePath,
    getOpenTabs: () => this.openTabs,
    getWorkspaceRootPath: () => this.workspaceRootPath,
    getPreviewRootPath: () => this.previewRootPath,
    isPreviewStandalone: () => this.previewStandalone,
    getSourceMapRootPath: () => this.pdfPreviewSourceMapRootPath,
    getActiveMode: () => this.activeMode,
    switchViewLayoutMode: () => this.switchViewLayoutMode(),
    loadFile: (path, options) => this.loadFile(path, options),
    capturePreviewSession: () => this.capturePreviewSession(),
    getActiveTab: () => this.getActiveTab(),
    mapToOriginalPath: path => this.mapToOriginalPath(path),
    isRenderCachePath: path => this.isRenderCachePath(path),
    pdfGeneratedPreviewText: path => this.pdfGeneratedPreviewText(path),
    mapCacheLspPositionToOriginalEditorOffset: (relativePath, position, cacheContent) =>
      this.mapCacheLspPositionToOriginalEditorOffset(relativePath, position, cacheContent),
    editorPositionFromLspPosition: position => this.editorPositionFromLspPosition(position),
    navigateToLogEntry: entry => this.navigateToLogEntry(entry),
    getCacheRootPath: () => this.getCacheRootPath(),
    utf8ByteOffsetToStringOffset: (text, byteOffset) => this.utf8ByteOffsetToStringOffset(text, byteOffset),
    isPreviewOnlyWindow: () => this.previewWindowController.isPreviewOnlyWindow(),
    isLowMemoryMode: () => this.settingsController.value.preview.lowMemoryMode,
    setPreviewReadyStatus: message => this.setLspStatus({ kind: "preview-ready", message }),
    log: (kind, source, message) => this.appendDeveloperLog({ kind, source, message }),
  });
  private readonly previewUiController = new PreviewUiController({
    previewFrame: this.previewFrame,
    markdownPreviewFrame: this.markdownPreviewFrame,
    draftPreview: this.draftPreviewController,
    imagePreview: this.imagePreviewController,
    getActiveFilePath: () => this.activeFilePath,
    isInternallySupportedPath: path => this.isInternallySupportedPath(path),
    setMarkdownPreviewActive: active => this.setMarkdownPreviewActive(active),
    isDeveloperMode: () => this.settingsController.value.developerMode,
    setLspStatus: status => this.setLspStatus(status),
    log: (kind, source, message) => this.appendDeveloperLog({ kind, source, message }),
  });
  private readonly previewContentController = new PreviewContentController({
    previewFrame: this.previewFrame,
    imagePreview: this.imagePreviewController,
    markdownPreview: this.markdownPreviewFrame,
    setMarkdownPreviewActive: active => this.setMarkdownPreviewActive(active),
    isImageToolActive: () => this.sidebarController.activeTool === "images",
    getActiveFilePath: () => this.activeFilePath,
    getPinnedMainFilePath: () => this.pinnedMainFilePath,
    getWorkspaceRootPath: () => this.workspaceRootPath,
    getPreviewSessionKey: () => this.previewSessionKey,
    getPreviewRenderMode: () => this.effectivePreviewRenderMode,
    getActiveTab: () => this.getActiveTab(),
    getEditorText: () => this.editorInstance.state.doc.toString(),
    isInternallySupportedPath: path => this.isInternallySupportedPath(path),
    updateActionsToolbar: path => this.updatePreviewActionsToolbar(path),
    prepareTemplateAwarePreview: (target, activePath, contents) =>
      this.prepareTemplateAwarePreview(target, activePath, contents),
    ensureLargePreviewApproved: rootPath => this.ensureLargePreviewApproved(rootPath),
    updatePinnedMain: path => this.updatePinnedMain(path),
    applyPreviewTargetToTab: (tab, target) => this.applyPreviewTargetToTab(tab, target),
    configureDocumentLanguageTools: contents => this.configureDocumentLanguageTools(contents),
    invalidatePreviewWork: reason => this.invalidatePreviewWork(reason),
    renderPdfPreview: contents => this.renderPdfPreview(contents),
    loadPdfPath: (path, identity) => this.loadPdfPath(path, identity),
    setPreviewPaneHtml: html => { this.previewPane.innerHTML = html; },
  });
  private readonly editorInitializationController = new EditorInitializationController({
    editorFontManager: this.editorFontManager,
    editorController: this.editorController,
    spellcheck: this.spellcheckController,
    documentOutline: this.documentOutlineController,
    logConsole: this.logConsoleController,
    previewSync: this.previewSyncController,
    draftPreview: this.draftPreviewController,
    codeRenderPane: this.codeRenderPane,
    lspClient: () => this.lspClient,
    activeLspUri: () => this.getActiveLspUri(),
    flushPendingLspSync: () => this.flushPendingLspSync(),
    navigateToLspLocation: (uri, line, character) => { void this.navigateToLspLocation(uri, line, character); },
    appendDeveloperLog: entry => this.appendDeveloperLog(entry),
    isLoadingFile: () => this.isLoadingFile,
    activeFilePath: () => this.activeFilePath,
    markActiveTabDirty: () => this.markActiveTabDirty(),
    scheduleEditorContentMutation: doc => this.scheduleEditorContentMutation(doc),
    syncSelectedSpellingLocation: () => this.syncSelectedSpellingLocation(),
    forwardSyncDebounceMs: () => this.forwardSyncDebounceMs,
    isDeveloperPerformanceLogEnabled: () => this.isDeveloperLogEnabled("performance"),
  });
  private readonly toolchainSetupController = new ToolchainSetupController({
    listReleases: () => invoke("list_tinymist_releases"),
    listSystemToolchains: () => invoke<SystemToolchain[]>("list_system_tinymist_toolchains"),
    install: (version, onProgress) => {
      const progress = new Channel<ToolchainInstallProgress>();
      progress.onmessage = onProgress;
      return invoke<ToolchainStatus>("install_tinymist_toolchain_with_progress", {
        version,
        onProgress: progress,
      });
    },
    selectSystemToolchain: path => invoke<ToolchainStatus>("select_system_tinymist_toolchain", { path }),
    closeWindow: () => getCurrentWindow().close(),
    showInstallError: async error => {
      await message(String(error), { title: "Toolchain installation failed", kind: "error" });
    },
    showSelectionError: async error => {
      await message(String(error), { title: "Toolchain selection failed", kind: "error" });
    },
  });
  private readonly previewWindowController = new PreviewWindowController({
    loadSettings: () => this.settingsController.load(),
    theme: () => this.settingsController.value.appearance.theme,
    previewColorMode: () => this.settingsController.value.preview.colorMode,
    setPreviewColorMode: mode => this.settingsController.update(settings => {
      settings.preview.colorMode = mode;
    }),
    previewFrame: this.previewFrame,
    draftPreview: this.draftPreviewController,
    zoomIn: () => this.zoomIn(),
    zoomOut: () => this.zoomOut(),
    zoomToFit: () => this.zoomToFit(),
    initializePreviewPageControls: () => this.initializePreviewPageControls(),
    sourceMapRootPath: () => this.pdfPreviewSourceMapRootPath,
    previewRootPath: () => this.previewRootPath,
    setWorkspaceRootPath: path => { this.workspaceRootPath = path; },
    loadPdfPath: (path, identity, sessionKey, surface) => { void this.loadPdfPath(path, identity, sessionKey, surface); },
  });
  private readonly editorTabActivationController = new EditorTabActivationController({
    explorer: {
      setActiveFile: path => this.explorer.setActiveFile(path),
      revealPath: path => this.explorer.revealPath(path),
    },
    workspaceRootPath: () => this.workspaceRootPath,
    openTabs: () => this.openTabs,
    activeFilePath: () => this.activeFilePath,
    setActiveFilePath: path => { this.activeFilePath = path; },
    classifyUnknownTextPath: path => this.classifyUnknownTextPath(path),
    largeFileNoticeForTab: tab => this.largeFileNoticeForTab(tab),
    persistActiveTabState: () => this.persistActiveTabState(),
    showLargeFileConfirmation: (tab, notice) => this.showLargeFileConfirmation(tab, notice),
    loadEditorTabContent: tab => this.loadEditorTabContent(tab),
    clearGuardrailAlignment: () => this.clearGuardrailAlignment(),
    isInternallySupportedPath: path => this.isInternallySupportedPath(path),
    editor: () => this.editorInstance,
    markdownPreview: this.markdownPreviewFrame,
    setMarkdownPreviewActive: active => this.setMarkdownPreviewActive(active),
    updatePreviewActionsToolbar: path => this.updatePreviewActionsToolbar(path),
    applyPreviewSessionToTab: (tab, session) => this.applyPreviewSessionToTab(tab, session),
    activatePreviewSession: sessionKey => this.previewFrame.activateSession(sessionKey),
    queuePreviewScrollPosition: scrollTop => this.previewFrame.queueTabScrollPosition(scrollTop),
    renderEditorTabs: () => this.renderEditorTabs(),
    saveWorkspaceState: () => { void this.saveWorkspaceState(); },
    cancelManualForwardSync: () => this.cancelManualForwardSync(),
    updateManualForwardSyncAction: () => this.updateManualForwardSyncAction(),
    typography: this.typographyController,
    setCurrentVersion: version => { this.currentVersion = version; },
    setLatestDocumentVersion: version => { this.latestDocumentVersion = version; },
    previewSync: this.previewSyncController,
    clearEditorDiagnostics: () => this.clearEditorDiagnostics(),
    setLoadingFile: loading => { this.isLoadingFile = loading; },
    presentation: this.editorTabPresentationController,
    activateSpellcheckDocument: path => this.activateSpellcheckDocument(path),
    clearOutline: () => this.documentOutlineController.clear(),
    restoreCachedEditorDiagnostics: path => this.restoreCachedEditorDiagnostics(path),
    draftPreview: this.draftPreviewController,
    updateWorkspaceViewportVisibility: () => this.updateWorkspaceViewportVisibility(),
    resumeDeferredWorkspaceServices: () => this.resumeDeferredWorkspaceServices(),
    restoreTabFoldState: tab => this.restoreTabFoldState(tab),
    restoreEditorTabViewport: (tab, path) => this.restoreEditorTabViewport(tab, path),
    toolbar: this.editorToolbarController,
    setDiagnosticWaitStartedAt: startedAt => { this.diagnosticWaitStartedAt = startedAt; },
    previewActivation: this.editorPreviewActivationController,
    clearPendingLspSync: () => this.clearPendingLspSync(),
    spellcheck: this.spellcheckController,
    scheduleDocumentOutlineUpdate: (path, delay) => this.scheduleDocumentOutlineUpdate(path, delay),
    outline: this.documentOutlineController,
    activeMode: () => this.activeMode,
    mapMarkupToWysiwym: markup => { this.mapMarkupToWysiwym(markup); },
    editorController: this.editorController,
  });
  private readonly pinnedMainFileController = new PinnedMainFileController({
    pinnedMainFilePath: () => this.pinnedMainFilePath,
    setPinnedMainFilePath: path => { this.pinnedMainFilePath = path; },
    activeFilePath: () => this.activeFilePath,
    workspaceRootPath: () => this.workspaceRootPath,
    largePreviewNoticeForRoot: path => this.largePreviewNoticeForRoot(path),
    isLargePreviewApproved: path => this.approvedLargePreviewRoots.has(filePathKey(path)),
    prepareTypography: path => this.preparePinnedMainTypography(path),
    synchronizeTypography: typography => this.editorToolbarController.synchronizeDocumentTypography(typography),
    setImageWorkspace: (root, main) => this.imageToolsController.setWorkspace(root, main),
    isImageToolActive: () => this.sidebarController.activeTool === "images",
    showImageTool: () => this.imageToolsController.show(),
    clearBlockedLargePreviewRoot: () => { this.blockedLargePreviewRoot = null; },
    setMainDocumentScripts: scripts => { this.mainDocumentScripts = scripts; },
    configureDocumentLanguageTools: text => this.configureDocumentLanguageTools(text),
    activeEditorText: () => this.editorInstance.state.doc.toString(),
    saveWorkspaceState: () => { void this.saveWorkspaceState(); },
    setWorkspaceServicesDeferred: deferred => { this.workspaceServicesDeferredForLargeFile = deferred; },
    setBlockedLargePreviewRoot: path => { this.blockedLargePreviewRoot = path; },
    hasLspClient: () => this.lspReady && this.documentSessionController.hasClient,
    stopTinymistSession: message => this.stopTinymistSession(message),
    findOpenTab: path => this.openTabs.find(candidate => filePathKey(candidate.path) === filePathKey(path)),
    showLargeFileConfirmation: (tab, notice) => this.showLargeFileConfirmation(tab, notice),
    loadFile: path => this.loadFile(path, { temporary: false }),
    sortPinnedMainFirst: () => this.editorSessionController.sortPinnedMainFirst(this.pinnedMainFilePath),
    renderEditorTabs: () => this.renderEditorTabs(),
    reloadExplorer: () => this.workspaceRootPath ? this.explorer.loadWorkspace(this.workspaceRootPath) : Promise.resolve(),
    resetPdfForMainFileChange: () => this.pdfPreviewRenderController.resetForMainFileChange(),
    prepareRenderProject: () => this.prepareRenderProjectIfNeeded(),
    restartTinymistSession: message => this.restartTinymistSession(message),
    setLspReady: ready => { this.lspReady = ready; },
    logRestartFailure: message => this.appendDeveloperLog({ kind: "error", source: "lsp", message }),
    updatePinnedMain: path => this.updatePinnedMain(path),
    activeTabContentLoaded: () => this.getActiveTab()?.contentLoaded === true,
    restoreActiveDocumentAfterRestart: force => this.restoreActiveDocumentAfterTinymistRestart(force),
    refreshActivePreviewRoot: force => this.refreshActivePreviewRoot(force),
  });
  private readonly systemResumeMonitor = new SystemResumeMonitor(suspendedMs => {
    void this.workspaceResumeController.recoverAfterSystemResume(suspendedMs);
  });
  private readonly windowStateController = new WindowStateController(getCurrentWindow());
  private lspStatus = document.getElementById("lsp-status")!;
  private lspStatusDot = this.lspStatus.querySelector(".status-dot") as HTMLElement;
  private lspStatusText = this.lspStatus.querySelector(".status-text") as HTMLElement;

  private get effectivePreviewRenderMode(): PreviewRenderMode {
    if (this.settingsController.value.preview.lowMemoryMode) return "on-save";
    return this.workspaceMetadata?.workspace.previewRenderMode
      ?? this.settingsController.value.preview.renderMode;
  }

  private async setPreviewRenderMode(mode: PreviewRenderMode): Promise<void> {
    if (!this.workspaceMetadata) {
      this.settingsController.update(settings => {
        settings.preview.renderMode = mode;
      });
      return;
    }
    if (this.workspaceMetadata.workspace.previewRenderMode === mode) return;
    this.workspaceMetadata.workspace.previewRenderMode = mode;
    this.settingsController.setWorkspacePreviewRenderMode(
      mode,
      nextMode => void this.setPreviewRenderMode(nextMode)
    );
    this.applySettingsToRuntime(this.settingsController.value);
    this.draftPreviewController.updateImageHeavyWarning();
    await this.saveWorkspaceState();
  }

  public async bootstrap() {
    const isPreviewWindow = this.previewWindowController.isPreviewOnlyWindow();
    if (isPreviewWindow) {
      await this.bootstrapPreviewWindow();
      return;
    }
    document.documentElement.classList.remove("preview-only-mode");
    document.body.classList.remove("preview-only-mode");

    await this.performanceController.timeStartup("load settings", () => this.settingsController.load());
    await this.performanceController.timeStartup("restore main window", async () => {
      try {
        await this.windowStateController.restore();
      } catch (error) {
        console.warn("Failed to restore the main window state:", error);
      }
    });
    for (const entry of this.settingsController.getTimings()) this.performanceController.recordStartupTimingEntry(entry);
    this.performanceController.timeStartupSync("initialize recent projects", () => this.recentProjectsController.initialize());
    this.performanceController.timeStartupSync("initialize CodeMirror", () => this.initCodeMirror());
    this.performanceController.timeStartupSync("initialize document outline", () => this.documentOutlineController.initialize());
    this.performanceController.timeStartupSync("apply settings to runtime", () => this.applySettingsToRuntime(this.settingsController.value));
    await this.performanceController.timeStartup("load editor fonts", () => this.editorFontManager.ready());
    this.performanceController.timeStartupSync("initialize explorer", () => this.initExplorer());
    this.performanceController.timeStartupSync("initialize editor toolbar", () => this.editorToolbarController.initialize());
    this.performanceController.timeStartupSync("initialize tab strip", () => this.tabStripController.initialize());
    this.performanceController.timeStartupSync("bind global events", () => this.bindGlobalEvents());
    this.performanceController.timeStartupSync("initialize layout", () => this.layoutController.initialize());
    this.performanceController.timeStartupSync("monitor system resume", () => this.systemResumeMonitor.start());
    this.performanceController.timeStartupSync("initialize word wrap label", () => this.initWordWrap());
    this.performanceController.timeStartupSync("initialize invisibles toggle", () => this.initZwsToggle());
    this.performanceController.timeStartupSync("initialize settings panel", () => this.settingsController.initializePanel());
    this.performanceController.timeStartupSync("initialize toolchain UI", () => this.toolchainController.initialize());
    this.performanceController.timeStartupSync("initialize context menu", () => this.contextMenuController.initialize());
    this.performanceController.timeStartupSync("initialize log console", () => this.logConsoleController.initialize());
    this.performanceController.timeStartupSync("update workspace visibility", () => this.updateWorkspaceViewportVisibility());

    await this.performanceController.timeStartup("show main window", () => getCurrentWindow().show());
    this.appUpdateController.initialize();
    this.webviewStorageController.initialize();
    void this.installNativeAppMenu();
    this.editorController.refreshLayout("main window shown");
    this.performanceController.recordStartupTiming("frontend startup", "frontend bootstrap until window shown", this.startupStart);
    this.performanceController.recordFirst({
      name: "startup.usable-editor",
      milliseconds: performance.now() - this.startupStart
    });
    void this.performanceController.logNativeStartupTimings();
    void this.finishStartupInitialization();

    this.setLspStatus({ kind: "starting", message: "Preparing toolchain" });

    let toolchain: ToolchainStatus | null = null;
    try {
      toolchain = await this.performanceController.timeStartup("get toolchain status", () => invoke<ToolchainStatus>("get_toolchain_status"));
    } catch (e) {
      console.error("Failed to check toolchain status:", e);
    }

    if (!toolchain?.tinymistVersion) {
      toolchain = await this.showToolchainSetupDialog();
    }

    this.toolchainController.setStatus(toolchain ?? { typstVersion: null, typstSource: null, tinymistVersion: null, tinymistSource: null, lspAvailable: false, message: "" });
    await this.releaseSummaryController.showIfNeeded();
    await this.performanceController.timeStartup("initialize Tinymist LSP", () => this.initLsp(
      Boolean(toolchain?.lspAvailable) && !this.settingsController.value.preview.lowMemoryMode
    ));
    await this.drainPendingProjectImports();
    this.performanceController.recordStartupTiming("frontend startup", "frontend bootstrap including LSP", this.startupStart);
  }

  private bootstrapPreviewWindow(): Promise<void> {
    return this.previewWindowController.bootstrap();
  }

  private updateWorkspaceViewportVisibility() {
    this.workspaceController.updateViewport({
      activeFilePath: this.activeFilePath,
      workspaceRootPath: this.workspaceRootPath,
      loading: this.workspaceLoading,
    });
    this.nativeAppMenu?.syncWorkspaceState(this.workspaceRootPath !== null);
  }

  private async installNativeAppMenu(): Promise<void> {
    this.recentProjectsController.observe(() => this.nativeAppMenu?.refreshRecentProjects());
    this.nativeAppMenu = await installNativeAppMenu({
      wordWrapEnabled: () => this.settingsController.value.editor.wordWrap,
      editorToolbarVisible: () => this.settingsController.value.editor.visualToolbar,
      workspaceOpen: () => this.workspaceRootPath !== null,
      recentProjects: () => this.recentProjectsController.visibleEntries(),
      openRecentProject: path => this.recentProjectsController.open(path),
      showAllRecentProjects: () => this.recentProjectsController.showPopup(),
    });
  }

  private async navigateToImageReference(reference: ProjectImageReference): Promise<void> {
    this.sidebarController.setTool("explorer");
    if (filePathKey(reference.sourcePath) !== filePathKey(this.activeFilePath ?? "")) {
      await this.loadFile(reference.sourcePath, { focusEditor: false });
    }
    if (!this.getActiveTab()?.contentLoaded) return;
    const from = Math.max(0, Math.min(reference.fromUtf16, this.editorInstance.state.doc.length));
    const to = Math.max(from, Math.min(reference.toUtf16, this.editorInstance.state.doc.length));
    this.editorInstance.dispatch({
      selection: { anchor: from, head: to },
      effects: EditorView.scrollIntoView(from, { y: "center" }),
    });
  }

  private async navigateToImageTool(imagePath: string): Promise<void> {
    this.sidebarController.setTool("images");
    await this.imageToolsController.selectImage(imagePath);
  }

  private async handleImageToolFilesWritten(
    paths: readonly string[],
    phase: "before" | "after",
  ): Promise<void> {
    const keys = paths.map(filePathKey);
    keys.forEach(key => this.managedImageToolPathKeys.add(key));
    window.setTimeout(() => {
      keys.forEach(key => this.managedImageToolPathKeys.delete(key));
    }, phase === "before" ? 10000 : 3000);
    if (phase === "before") return;

    const openFilesChanged = await this.reloadOpenFilesFromDisk(false);
    if (this.workspaceRootPath) await this.explorer.loadWorkspace(this.workspaceRootPath);
    if (openFilesChanged && this.activeFilePath && isTypstDocumentPath(this.activeFilePath)) {
      await this.refreshActivePreviewRoot(true);
    }
  }

  private toggleEditorToolbar(): void {
    this.settingsController.update(settings => {
      settings.editor.visualToolbar = !settings.editor.visualToolbar;
    });
  }

  private restoreDefaultLayout(): void {
    if (!this.workspaceRootPath) return;
    this.sidebarController.setVisible(true);
    if (!this.settingsController.value.editor.visualToolbar) this.toggleEditorToolbar();

    const explorerSidebar = document.getElementById("explorer-sidebar");
    if (explorerSidebar) explorerSidebar.style.width = `${DEFAULT_EXPLORER_WIDTH_PX}px`;
    this.sidebarController.applyVisibility();

    const inputWrapper = document.getElementById("input-container-wrapper");
    const previewWrapper = document.getElementById("preview-container-wrapper");
    const previewResizer = document.getElementById("editor-preview-resizer");
    const dockButton = document.getElementById("dock-preview-status-btn");

    if (inputWrapper) {
      inputWrapper.style.width = `${DEFAULT_INPUT_WIDTH_PCT}%`;
      this.layoutController.setDockedInputWidthPct(DEFAULT_INPUT_WIDTH_PCT);
      if (this.activeFilePath) inputWrapper.classList.remove("hidden");
    }
    if (previewWrapper) {
      previewWrapper.style.width = `${DEFAULT_PREVIEW_WIDTH_PCT}%`;
      if (this.activeFilePath) {
        previewWrapper.classList.remove("hidden");
        previewWrapper.style.display = "flex";
      } else {
        previewWrapper.style.display = "";
      }
    }
    if (previewResizer) {
      previewResizer.style.display = this.activeFilePath ? "block" : "";
      previewResizer.classList.toggle("hidden", !this.activeFilePath);
    }
    dockButton?.classList.add("hidden");

    const logConsole = document.getElementById("log-console");
    if (logConsole) logConsole.style.height = "";
    this.logConsoleController.setVisible(false);

    this.updateWorkspaceViewportVisibility();
    this.saveWorkspaceState();
  }

  private applySettingsToRuntime(settings: AppSettings): void {
    const { editor } = settings;
    this.settingsRuntimeController.apply(settings);
    this.previewFrame.setColorMode(settings.preview.colorMode);
    this.updatePreviewColorModeButton(settings.preview.colorMode);
    if (this.lastBroadcastPreviewColorMode !== settings.preview.colorMode) {
      this.lastBroadcastPreviewColorMode = settings.preview.colorMode;
      if (new URLSearchParams(window.location.search).get("mode") !== "preview") {
        void import("@tauri-apps/api/event").then(({ emit }) =>
          emit("preview-color-mode-update", settings.preview.colorMode)
        ).catch(error => console.error("Failed to synchronize preview color mode", error));
      }
    }
    this.editorToolbarController.setVisible(editor.visualToolbar);
    this.nativeAppMenu?.syncCheckState({ wordWrap: editor.wordWrap, editorToolbar: editor.visualToolbar });
  }

  private updatePreviewColorModeButton(mode: PreviewColorMode): void {
    const button = document.getElementById("preview-menu-btn");
    if (!button) return;
    const label = mode === "dark" ? "Dark preview"
      : mode === "inverted" ? "Inverted preview (experimental)"
      : "Document colors";
    button.title = mode === "document" ? "Preview Options" : `Preview Options · ${label}`;
    button.setAttribute("aria-label", mode === "document" ? "Preview options" : `Preview options; ${label} active`);
  }

  private currentEditorSettingsEffects() {
    const { appearance, editor } = this.settingsController.value;
    const indentation = " ".repeat(editor.tabSize);
    return [
      themeCompartment.reconfigure(getThemeExtension(appearance.theme)),
      wrapCompartment.reconfigure(editor.wordWrap ? EditorView.lineWrapping : []),
      lineNumbersCompartment.reconfigure(editor.lineNumbers ? lineNumbers() : []),
      activeLineCompartment.reconfigure(editor.highlightActiveLine ? [highlightActiveLineGutter(), highlightActiveLine()] : []),
      closeBracketsCompartment.reconfigure(editor.autoCloseBrackets ? closeBrackets() : []),
      indentationGuidesCompartment.reconfigure(editor.indentationGuides ? visibleIndentationMarkers() : []),
      tabSizeCompartment.reconfigure([EditorState.tabSize.of(editor.tabSize), indentUnit.of(indentation)]),
      showZwsCompartment.reconfigure(editor.showZws ? showZeroWidthSpaces : []),
      completionCompartment.reconfigure(this.editorCompletionForPath(this.activeFilePath ?? ""))
    ];
  }

  private handleLanguageProvidersChanged(providers: Parameters<SpellcheckController["setProviders"]>[0]): void {
    this.spellcheckController.setProviders(providers);
    document.dispatchEvent(new CustomEvent("typsastra:language-providers-changed"));
    if (!this.editorInstance) return;
    this.editorInstance.dispatch({
      effects: completionCompartment.reconfigure(this.editorCompletionForPath(this.activeFilePath ?? ""))
    });
  }

  private initWordWrap(): void {
    this.settingsRuntimeController.initializeWordWrapToggle();
  }

  private initZwsToggle(): void {
    this.settingsRuntimeController.initializeZwsToggle();
  }


  private showToolchainSetupDialog(): Promise<ToolchainStatus | null> {
    return this.toolchainSetupController.show();
  }


  private initCodeMirror(): void {
    const initialized = this.editorInitializationController.initialize();
    this.editorExtensions = initialized.extensions;
    this.editorInstance = initialized.editor;
  }

  private initExplorer() {
    this.explorer = new WorkspaceExplorer(
      document.getElementById("workspace-explorer-tree")!,
      (path: string, options?: { temporary?: boolean; focusEditor?: boolean }) => {
        void this.loadFile(path, options);
      },
      (path: string) => this.isPinnedMainFile(path),
      document.getElementById("workspace-explorer-title")!
    );
  }

  private renderEditorTabs(): void {
    this.editorTabViewController.render();
  }

  private promoteToPermanent(tab: EditorTab): Promise<void> {
    return this.editorTabStateController.promoteToPermanent(tab);
  }

  private getActiveTab(): EditorTab | null {
    return this.editorSessionController.activeTab;
  }

  private persistActiveTabState(): void {
    this.editorTabStateController.persistActive();
  }

  private restoreEditorTabViewport(tab: EditorTab, path: string): Promise<void> {
    return this.editorTabStateController.restoreViewport(tab, path);
  }

  private finishEditorTextPresentation(path: string): void {
    this.editorTabPresentationController.finishTextPresentation(path);
  }

  private restoreTabFoldState(tab: EditorTab): void {
    this.editorTabStateController.restoreFoldState(tab);
  }

  private activateSpellcheckDocument(path: string | null): void {
    this.documentLanguageController.activate(path);
  }

  private configureDocumentLanguageTools(text: string): void {
    this.documentLanguageController.configure(text);
  }

  private scheduleDocumentOutlineUpdate(path: string, delay = 180): void {
    this.documentLanguageController.scheduleOutlineUpdate(path, delay);
  }

  private foldCurrentFile(): void {
    if (!this.getActiveTab() || !this.isInternallySupportedPath(this.activeFilePath ?? "") || isBinaryImagePath(this.activeFilePath ?? "") || fileExtension(this.activeFilePath ?? "") === "pdf") return;
    const tab = this.getActiveTab();
    if (tab) tab.foldStateExplicit = true;
    this.editorController.foldDocument();
  }

  private unfoldCurrentFile(): void {
    if (!this.getActiveTab() || !this.isInternallySupportedPath(this.activeFilePath ?? "") || isBinaryImagePath(this.activeFilePath ?? "") || fileExtension(this.activeFilePath ?? "") === "pdf") return;
    const tab = this.getActiveTab();
    if (tab) tab.foldStateExplicit = true;
    this.editorController.unfoldDocument();
  }

  private applyFoldRanges(ranges: EditorFoldRange[]) {
    this.editorController.applyFoldRanges(ranges);
  }

  private normalizeFoldRanges(value: unknown, docLength: number): EditorFoldRange[] {
    return this.editorController.normalizeFoldRanges(value, docLength);
  }

  private updateActiveTabContent(content: string): void {
    this.editorTabStateController.updateActiveContent(content);
  }

  private markActiveTabDirty(): void {
    this.editorTabStateController.markActiveDirty();
  }

  private scheduleEditorContentMutation(doc: Text): void {
    if (!this.activeFilePath) return;
    this.editorController.scheduleContentMutation(this.activeFilePath, doc);
  }

  private flushEditorContentMutation(previewDebounceElapsedMs = 0): void {
    this.editorController.flushContentMutation(
      this.activeFilePath,
      previewDebounceElapsedMs,
    );
  }

  private renameWorkspacePath(
    oldPath: string,
    newPath: string,
    updateImageReferences = false,
  ): Promise<void> {
    return this.workspacePathRenameController.rename(oldPath, newPath, updateImageReferences);
  }

  private closeEditorTab(path: string, skipDirtyCheck = false): Promise<void> {
    return this.editorTabLifecycleController.close(path, skipDirtyCheck);
  }

  private largeFileNoticeForTab(tab: EditorTab): Promise<LargeFileOpeningNotice | null> {
    return this.largePreviewGuardController.noticeForTab(tab);
  }

  private approveLargePreviewForTab(tab: EditorTab, notice: LargeFileOpeningNotice): Promise<void> {
    return this.largePreviewGuardController.approveForTab(tab, notice);
  }

  private largePreviewNoticeForRoot(rootPath: string): Promise<LargeFileOpeningNotice | null> {
    return this.largePreviewGuardController.noticeForRoot(rootPath);
  }

  private ensureLargePreviewApproved(rootPath: string | null): Promise<boolean> {
    return this.largePreviewGuardController.ensureApproved(rootPath);
  }

  private loadEditorTabContent(tab: EditorTab): Promise<void> {
    return this.editorFileContentController.loadTabContent(tab);
  }

  private isInternallySupportedPath(path: string): boolean {
    return this.editorFileContentController.isInternallySupportedPath(path);
  }

  private editorLanguageForPath(path: string): Extension {
    if (isTypstDocumentPath(path)) return typstLanguage;
    if (isMarkdownDocumentPath(path)) return this.markdownEditorLanguage;
    return [];
  }

  private editorCompletionForPath(path: string): Extension {
    if (!isTypstDocumentPath(path)) return [];
    const editor = this.settingsController.value.editor;
    return createTypstAutocomplete(
      () => this.lspClient,
      () => this.getActiveLspUri(),
      () => this.flushPendingLspSync(),
      editor.wordCompletion,
      () => this.spellcheckController.getProviders(),
      providers => this.documentLanguageService.completionProvider(providers),
      () => this.documentLanguageService.currentGeneration(),
      milliseconds => this.performanceController.record({ name: "language.completion", milliseconds }),
      message => this.appendDeveloperLog({ kind: "info", source: "lsp autocomplete", message }),
      () => this.settingsController.value.editor.userDictionary,
    );
  }

  private async resolveMarkdownWorkspacePath(documentPath: string, reference: string): Promise<string | null> {
    if (!this.workspaceRootPath || !reference || reference.startsWith("#")) return null;
    if (/^(?:data:|https?:|mailto:)/iu.test(reference)) return null;
    const pathOnly = reference.split(/[?#]/u, 1)[0];
    if (!pathOnly) return null;
    let decoded = pathOnly;
    try {
      decoded = decodeURIComponent(pathOnly);
    } catch {
      return null;
    }
    const absolute = /^(?:[A-Za-z]:[\\/]|\\\\|\/)/u.test(decoded)
      ? decoded
      : await join(await dirname(documentPath), decoded);
    return relativeFilePath(this.workspaceRootPath, absolute) === null ? null : absolute;
  }

  private async resolveMarkdownImage(documentPath: string, source: string): Promise<MarkdownResource | null> {
    const path = await this.resolveMarkdownWorkspacePath(documentPath, source);
    if (!path || (!isBinaryImagePath(path) && fileExtension(path) !== "svg")) return null;
    const mimeType = ({
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      gif: "image/gif",
      webp: "image/webp",
      avif: "image/avif",
      bmp: "image/bmp",
      ico: "image/x-icon",
      svg: "image/svg+xml",
    } as Record<string, string>)[fileExtension(path)];
    if (!mimeType) return null;
    const base64 = await invoke<string>("read_workspace_file_as_base64", { path });
    return {
      source: `data:${mimeType};base64,${base64}`,
      alt: fileNameFromPath(path),
    };
  }

  private async openMarkdownLink(documentPath: string, href: string): Promise<void> {
    if (/^(?:https?:|mailto:)/iu.test(href)) {
      await openUrl(href);
      return;
    }
    const path = await this.resolveMarkdownWorkspacePath(documentPath, href);
    if (path) await this.loadFile(path);
  }

  private setMarkdownPreviewActive(active: boolean): void {
    document.getElementById("preview-container-wrapper")?.classList.toggle("markdown-preview-active", active);
  }

  private classifyUnknownTextPath(path: string): Promise<boolean> {
    return this.editorFileContentController.classifyUnknownTextPath(path);
  }

  private activateEditorTab(path: string, persistCurrent = true, options: ActivateEditorTabOptions = {}): Promise<void> {
    return this.editorTabActivationController.activate(path, persistCurrent, options);
  }

  private resumeDeferredWorkspaceServices(): void {
    if (!this.workspaceServicesDeferredForLargeFile || !this.workspaceRootPath) return;
    const workspacePath = this.workspaceRootPath;
    this.workspaceServicesDeferredForLargeFile = false;
    void this.startWorkspaceServices(workspacePath);
  }

  private async initLsp(shouldConnect = true) {
    await this.documentSessionController.initialize(shouldConnect);
    if (!shouldConnect && this.settingsController.value.preview.lowMemoryMode) {
      this.setLspStatus({
        kind: "stopped",
        message: "Low memory mode: compiler starts only while rendering",
      });
    }
  }

  private createTinymistClient(): TinymistLspClient {
    return this.tinymistIntegrationController.createClient();
  }

  private handleTinymistConnected(): void {
    this.tinymistIntegrationController.onConnected();
  }

  private discoverSurroundWithOptions(): Promise<void> {
    return this.surroundWithDiscoveryController.discover();
  }

  private resetTinymistSessionState(): void {
    this.tinymistIntegrationController.resetSessionState();
  }

  private stopTinymistSession(statusMessage: string): Promise<void> {
    return this.documentSessionController.stop(statusMessage);
  }

  private restartTinymistSession(statusMessage: string): Promise<void> {
    return this.documentSessionController.restart(statusMessage);
  }

  private recoverTinymistPreviewAfterUnexpectedStop(
    contents: string,
    failedGeneration: number
  ): Promise<boolean> {
    return this.tinymistPreviewRecoveryController.recover(contents, failedGeneration);
  }

  private handleToolchainChanged(status: ToolchainStatus): Promise<void> {
    return this.tinymistIntegrationController.handleToolchainChanged(status);
  }


  private loadFile(path: string, options: EditorTabLoadOptions = {}): Promise<void> {
    return this.editorTabLifecycleController.load(path, options);
  }

  private saveActiveFile(intent: SaveIntent = "manual"): Promise<void> {
    return this.documentPersistenceController.saveActiveFile(intent);
  }

  private configureAutoSave(enabled: boolean, intervalSeconds: number): void {
    this.documentPersistenceController.configureAutoSave(enabled, intervalSeconds);
  }

  private saveActiveFileAs(): Promise<void> {
    return this.documentPersistenceController.saveActiveFileAs();
  }

  private formatActiveDocument(options: { silent?: boolean } = {}): Promise<boolean> {
    return this.documentFormattingController.formatActiveDocument(options);
  }

  private removeTrailingSpaces(): void {
    this.documentFormattingController.removeTrailingSpaces();
  }

  private workspaceText(path: string): Promise<string> {
    return this.workspaceTextController.read(path);
  }

  private writeWorkspaceText(path: string, content: string): Promise<void> {
    return this.workspaceTextController.write(path, content);
  }

  private applyTypography(
    config: DocumentTypography,
    target: "document" | "template"
  ): Promise<boolean> {
    return this.documentTypographyApplicationController.apply(config, target);
  }

  private applyPreviewTargetToTab(tab: EditorTab, target: PreviewTarget): void {
    this.previewSessionController.applyTargetToTab(tab, target);
  }

  private capturePreviewSession(): PreviewSessionState {
    return this.previewSessionController.capture();
  }

  private applyPreviewSessionToTab(tab: EditorTab, session: PreviewSessionState): void {
    this.previewSessionController.applySessionToTab(tab, session);
  }


  private prepareTemplateAwarePreview(
    target: PreviewTarget,
    activePath: string,
    activeContents: string,
  ): Promise<PreviewTarget> {
    return this.previewSessionController.prepareTemplateAware(target, activePath, activeContents);
  }

  private updatePinnedMain(path: string | null, force = false): Promise<boolean> {
    return this.lspDocumentController.updatePinnedMain(path, force);
  }

  private recheckActiveDocumentAfterPin(text: string): Promise<void> {
    return this.lspDocumentController.recheckActiveAfterPin(text);
  }

  private renderPdfPreview(contents: string, force = false): Promise<void> {
    return this.pdfPreviewRenderController.render(contents, force);
  }

  private recompilePreviewManually(): void {
    this.pdfPreviewRenderController.recompileManually();
  }

  private loadPdfPath(
    path: string,
    identity: string,
    sessionKey = identity,
    surface: PreviewSurface = isTypstDocumentPath(identity) ? "live" : "pdf",
    deleteOnClose = false
  ): Promise<number> {
    return this.pdfPreviewRenderController.loadPdfPath(
      path,
      identity,
      sessionKey,
      surface,
      deleteOnClose,
    );
  }

  private schedulePdfPreview(
    contents: string,
    delayMs = this.settingsController.value.preview.syncDebounceMs
  ): void {
    this.pdfPreviewRenderController.schedule(contents, delayMs);
  }

  private handleContentMutation(rawText: string, previewDebounceElapsedMs = 0) {
    const canRenderPreview = activeFileCanRenderPreview(
      this.activeFilePath,
      this.pinnedMainFilePath,
      this.previewImported,
      this.previewDisabled
    );
    if (!this.isLoadingFile && canRenderPreview) {
      this.pdfPreviewRenderController.noteContentMutation(true);
    }
    this.appendDeveloperLog({
      kind: "info",
      source: "preview scheduler",
      message: `Document mutation: active=${this.activeFilePath ?? "none"}; sourceUtf16=${rawText.length}; loading=${this.isLoadingFile}; preparationRevision=${this.pdfPreparationRevision}; mode=${this.effectivePreviewRenderMode}; disabled=${this.previewDisabled}; lspReady=${this.lspReady}.`
    });
    if (this.activeFilePath && this.activeFilePath.toLowerCase().endsWith(".typ")) {
      this.scheduleDocumentOutlineUpdate(this.activeFilePath);
    }
    if (!this.isLoadingFile) {
      this.updateActiveTabContent(rawText);
      this.typographyController.scheduleManualScaleCheck();
      if (this.activeFilePath && isMarkdownDocumentPath(this.activeFilePath)) {
        this.markdownPreviewFrame.schedule(this.activeFilePath, rawText);
      }
    }

    this.lspSyncController.queueContentMutation(rawText);
    if (
      !this.isLoadingFile
      && this.activeFilePath
      && this.activeFilePath.toLowerCase().endsWith(".typ")
      && canRenderPreview
      && this.effectivePreviewRenderMode === "on-type"
      && !this.previewDisabled
    ) {
      const remainingPreviewDebounceMs = Math.max(
        0,
        this.settingsController.value.preview.syncDebounceMs - previewDebounceElapsedMs
      );
      if (remainingPreviewDebounceMs === 0) {
        void this.renderPdfPreview(rawText);
      } else {
        this.schedulePdfPreview(rawText, remainingPreviewDebounceMs);
      }
    }
  }

  private invalidatePreviewWork(reason: string): void {
    this.pdfPreviewRenderController.invalidate(reason);
  }

  private flushPendingLspSync(): Promise<void> {
    return this.lspSyncController.flushPending();
  }

  private restoreActiveDocumentAfterTinymistRestart(
    forcePreview = true
  ): Promise<void> {
    return this.lspSyncController.restoreActiveDocumentAfterRestart(forcePreview);
  }

  private clearPendingLspSync(): void {
    this.lspSyncController.clearPending();
  }

  private handleInverseSync(
    uri: string | undefined,
    position: LspSourcePosition
  ): Promise<LspInverseSyncResult> {
    return this.previewSourceNavigationController.handleInverseSync(uri, position);
  }

  private revealCursorInPreviewManually(): void {
    this.previewSourceNavigationController.revealCursorInPreviewManually();
  }

  private cancelManualForwardSync(): void {
    this.previewSourceNavigationController.cancelManualForwardSync();
  }

  private updateManualForwardSyncAction(): void {
    this.previewSourceNavigationController.updateManualForwardSyncAction();
  }

  private renderManualForwardSyncAction(busy: boolean, available: boolean): void {
    this.previewSourceNavigationController.renderManualForwardSyncAction(busy, available);
  }

  private forwardSyncTarget(
    path: string,
    cursor: number
  ): Promise<{ filepath: string; line: number; character: number } | null> {
    return this.previewSourceNavigationController.forwardSyncTarget(path, cursor);
  }

  private handlePdfPreviewClick(point: PreviewClickPoint): Promise<void> {
    return this.previewSourceNavigationController.handlePdfPreviewClick(point);
  }

  private updatePreviewZoomLabel(zoomPercent?: number): void {
    this.previewUiController.updateZoomLabel(zoomPercent);
  }

  private schedulePdfSourceMapWarmup(generation: number): void {
    this.previewSyncController.scheduleWarmup(generation);
  }

  private initializePreviewPageControls(): void {
    this.previewUiController.initializePageControls();
  }

  private updatePreviewPageStatus(status: PreviewPageStatus): void {
    this.previewUiController.updatePageStatus(status);
  }

  private updatePreviewActionsToolbar(path: string | null): void {
    this.previewUiController.updateActionsToolbar(path);
  }

  private zoomIn(): void {
    this.previewUiController.zoomIn();
  }

  private zoomOut(): void {
    this.previewUiController.zoomOut();
  }

  private zoomToFit(): void {
    this.previewUiController.zoomToFit();
  }

  private async finishStartupInitialization(): Promise<void> {
    const startedAt = performance.now();
    try {
      const providers = await this.performanceController.timeStartup("finish native startup initialization", () =>
        invoke<unknown>("finish_startup_initialization")
      );
      this.handleLanguageProvidersChanged(providers);
      this.performanceController.recordFirst({
        name: "startup.deferred-initialization",
        milliseconds: performance.now() - startedAt,
        detail: { providerCount: this.spellcheckController.getAllProviders().length }
      });
    } catch (error) {
      console.warn("Deferred startup initialization failed:", error);
    } finally {
      void this.performanceController.logNativeStartupTimings();
      void this.settingsController.refreshSystemFonts();
    }
  }

  private reportPreviewInteractionStatus(status: PreviewInteractionStatus): void {
    this.previewUiController.reportInteractionStatus(status);
  }

  private setLspStatus(status: LspStatus) {
    this.lspStatus.dataset.state = status.kind;
    this.lspStatusDot.setAttribute("aria-label", status.message);
    this.lspStatusText.textContent = status.message;

    if (status.kind === "stopped" || status.kind === "error") {
      this.lspReady = false;
    }
    this.updateManualForwardSyncAction();
  }

  private handleLspDiagnostics(uri: string, diagnostics: LspDiagnostic[], version?: number): Promise<void> {
    return this.diagnosticsController.handleLspDiagnostics(uri, diagnostics, version);
  }

  private recoverPreviewAfterAcceptedDiagnostics(diagnostics: readonly LspDiagnostic[]): void {
    this.previewDiagnosticsRecoveryController.recoverAfterAcceptedDiagnostics(diagnostics);
  }

  private appendLspLog(entry: LspLogEntry): void {
    this.developerLogController.appendLsp(entry);
  }

  private appendDeveloperLog(entry: LspLogEntry): void {
    this.developerLogController.appendDeveloper(entry);
  }

  private appendSpellcheckDebug(event: SpellcheckDebugEvent): void {
    this.developerLogController.appendSpellcheckDebug(event);
  }

  private isDeveloperLogEnabled(category: DeveloperLogCategory): boolean {
    return this.developerLogController.isEnabled(category);
  }

  private updateSpellcheckLog(issues: readonly SpellingIssue[]): void {
    this.diagnosticsController.updateSpellcheckLog(issues);
  }
  private syncSelectedSpellingLocation(): void {
    this.diagnosticsController.syncSelectedSpellingLocation();
  }
  private clearDiagnostics(): void {
    this.diagnosticsController.clear();
  }

  private clearEditorDiagnostics(): void {
    this.diagnosticsController.clearEditorDiagnostics();
  }

  private restoreCachedEditorDiagnostics(path: string): void {
    this.diagnosticsController.restoreCachedEditorDiagnostics(path);
  }

  private editorPositionFromLspPosition(position: LspSourcePosition): number | null {
    return this.diagnosticsController.editorPositionFromLspPosition(position);
  }
  private navigateToLogEntry(entry: LogConsoleEntryInput): Promise<void> {
    return this.diagnosticsController.navigateToLogEntry(entry);
  }
  private navigateToLspLocation(uri: string, line: number, character: number): Promise<void> {
    return this.sourceLocationController.navigateToLspLocation(uri, line, character);
  }

  private navigateToOutlineHeading(heading: DocumentHeading): Promise<void> {
    return this.outlineNavigationController.navigate(heading);
  }

  private switchViewLayoutMode() {
    if (!this.wysiwymPane) return;
    if (this.activeMode === "CODE") {
      this.activeMode = "WYSIWYM";
      this.mapMarkupToWysiwym(this.editorInstance.state.doc.toString());
      this.codePane.classList.add("hidden");
      this.wysiwymPane.classList.remove("hidden");
      this.editorVisualToolbar.classList.add("wysiwym-active");
    } else {
      this.activeMode = "CODE";
      const markup = this.mapWysiwymToMarkup();
      this.editorInstance.dispatch({
        changes: { from: 0, to: this.editorInstance.state.doc.length, insert: markup }
      });
      this.wysiwymPane.classList.add("hidden");
      this.codePane.classList.remove("hidden");
      this.editorVisualToolbar.classList.remove("wysiwym-active");
    }
  }

  private saveWorkspaceState(): Promise<void> {
    return this.workspaceController.saveState();
  }


  private handleWorkspaceChange(change: WorkspaceChange): Promise<void> {
    return this.externalWorkspaceController.handleChange(change);
  }
  private async retirePdfSourceMapSession(reason: string): Promise<void> {
    this.cancelManualForwardSync();
    this.previewSyncController.reset();
    const taskId = this.sourceMapSessionController.registeredTaskId;
    await this.sourceMapSessionController.retire(this.lspClient).catch(error => {
      this.appendDeveloperLog({
        kind: "warning",
        source: "workspace",
        message: `Could not stop stale source-map task ${taskId ?? "unknown"}: ${String(error)}`
      });
    });
    this.appendDeveloperLog({
      kind: "info",
      source: "workspace",
      message: `Retired PDF source-map session after ${reason}.`
    });
  }

  private async waitForExternalPreviewRefresh(timeoutMs = 60000): Promise<void> {
    const startedAt = performance.now();
    let stableFrames = 0;
    let observedGeneration = this.pdfPreviewGeneration;
    while (performance.now() - startedAt < timeoutMs) {
      await new Promise<void>(resolve => window.setTimeout(resolve, 16));
      const generationChanged = observedGeneration !== this.pdfPreviewGeneration;
      observedGeneration = this.pdfPreviewGeneration;
      if (
        generationChanged
        || this.pdfPreviewRunning
        || this.pdfPreviewRenderController.queued
      ) {
        stableFrames = 0;
        continue;
      }
      stableFrames += 1;
      if (stableFrames >= 3) return;
    }
    this.appendDeveloperLog({
      kind: "warning",
      source: "workspace",
      message: "External preview refresh did not settle within 60000ms; cursor synchronization remains available for the last presented PDF."
    });
  }

  private reloadOpenFilesFromDisk(refreshPreview = true): Promise<boolean> {
    return this.externalFileReloadController.reloadOpenFiles(refreshPreview);
  }


  private noMainFileMessage(): string {
    return this.previewContentController.noMainFileMessage();
  }

  private disabledPreviewMessage(): string {
    return this.previewContentController.disabledPreviewMessage();
  }

  private renderNonTextEditorPlaceholder(path: string, unsupported: boolean): void {
    this.editorFileGuardController.renderNonTextPlaceholder(path, unsupported);
  }

  private showLargeFileConfirmation(tab: EditorTab, notice: LargeFileOpeningNotice): void {
    this.editorFileGuardController.showLargeFileConfirmation(tab, notice);
  }

  private clearGuardrailAlignment(): void {
    this.editorFileGuardController.clearAlignment();
  }

  private openFileExternally(path: string, button?: HTMLButtonElement): Promise<void> {
    return this.editorFileGuardController.openFileExternally(path, button);
  }

  private renderImageToolPreview(source: string | null, imagePath?: string): void {
    this.previewContentController.renderImageToolPreview(source, imagePath);
  }

  private renderInteractiveImageViewer(
    src: string,
    previewPath = this.activeFilePath ?? "preview.png",
  ): void {
    this.previewContentController.renderInteractiveImageViewer(src, previewPath);
  }

  private refreshActivePreviewRoot(forceRender = false): Promise<void> {
    return this.previewContentController.refreshActivePreviewRoot(forceRender);
  }

  private reportWorkspaceWatchError(error: unknown): void {
    console.error("Workspace watcher failed:", error);
    this.appendLspLog({ kind: "error", source: "workspace", message: `Workspace watcher failed: ${String(error)}` });
  }

  private openWorkspace(selected: string): Promise<void> {
    return this.workspaceLifecycleController.open(selected);
  }


  private startWorkspaceServices(selected: string): Promise<void> {
    return this.workspaceLifecycleController.startServices(selected);
  }



  private importTypsastraProject(archivePath?: string): Promise<void> {
    return this.projectImportController.importProject(archivePath);
  }

  private completeProjectImport(
    imported: ImportedTypsastraProject,
    projectName: string,
  ): Promise<boolean> {
    return this.workspaceLifecycleController.completeImport(imported, projectName);
  }

  private closeOtherTabs(pathToKeep: string): Promise<void> {
    return this.workspaceLifecycleController.closeOtherTabs(pathToKeep);
  }


  private restartWorkspace(): Promise<void> {
    return this.workspaceLifecycleController.restart();
  }


  private openExamplesWorkspace(): Promise<void> {
    return this.workspaceLifecycleController.openExamples();
  }


  private isPinnedMainFile(path: string): boolean {
    return this.pinnedMainFileController.isPinned(path);
  }

  private preparePinnedMainTypography(path: string): Promise<DocumentTypography | null | false> {
    return this.pinnedMainTypographyController.prepare(path);
  }

  private setPinnedMainFile(path: string | null): Promise<void> {
    return this.pinnedMainFileController.set(path);
  }

  private closeProject(options: { confirmUnsaved?: boolean } = {}): Promise<boolean> {
    return this.workspaceLifecycleController.close(options);
  }


  private bindGlobalEvents(): void {
    bindAppEvents({
      previewWindowUpdate: () => {
        if (!this.lastPdfPath) return null;
        return {
          path: this.lastPdfPath,
          identity: this.lastPdfIdentity || this.pdfPreviewSourceMapRootPath || this.previewRootPath || "preview",
          sessionKey: this.lastPdfSessionKey || this.previewSessionKey || this.lastPdfIdentity || "preview",
          surface: this.lastPdfSurface,
          contentMode: this.draftPreviewController.presentedMode,
          draftAssets: this.draftPreviewController.presentedMode === "draft"
            ? [...this.draftPreviewController.assets.values()]
            : [],
          draftAssetRootPath: this.draftPreviewController.presentedMode === "draft"
            ? this.draftPreviewController.assetRootPath ?? undefined
            : undefined,
          draftThumbnailGeneration: this.draftPreviewController.presentedMode === "draft"
            ? this.draftPreviewController.thumbnailGeneration
            : undefined,
        };
      },
      changePreviewContentMode: mode => this.draftPreviewController.changeMode(mode),
      changePreviewColorMode: mode => this.settingsController.update(settings => {
        settings.preview.colorMode = mode;
      }),
      previewContentMode: () => this.draftPreviewController.mode,
      openLastPreviewExternally: () => this.lastPdfPath ? this.openFileExternally(this.lastPdfPath) : undefined,
      handlePdfPreviewClick: point => this.handlePdfPreviewClick(point),
      drainPendingProjectImports: () => this.drainPendingProjectImports(),
      navigateToImageTool: imagePath => this.navigateToImageTool(imagePath),
      beforeUnload: () => {
        this.systemResumeMonitor.stop();
        if (this.sourceMapSessionController.registeredTaskId && this.lspClient) {
          void this.lspClient.stopPreview(this.sourceMapSessionController.registeredTaskId).catch(() => {});
        }
        this.workspaceController.stopWatching();
        void this.saveWorkspaceState();
        this.settingsController.flush();
      },
      dismissSpellcheckTyping: () => this.spellcheckController.dismissActiveTyping(),
      revealCursorInPreview: () => this.revealCursorInPreviewManually(),
      formatActiveDocument: () => this.formatActiveDocument(),
      saveActiveFileAs: () => this.saveActiveFileAs(),
      saveActiveFile: () => this.saveActiveFile(),
      openRecentProject: index => this.recentProjectsController.openAt(index),
      openWorkspace: path => this.openWorkspace(path),
      importProject: () => this.importTypsastraProject(),
      restartWorkspace: () => this.restartWorkspace(),
      closeProject: () => this.closeProject(),
      workspaceRootPath: () => this.workspaceRootPath,
      onNewFileCreated: async path => {
        if (this.workspaceRootPath) await this.explorer.loadWorkspace(this.workspaceRootPath);
        await this.loadFile(path);
      },
      zoomOut: () => this.zoomOut(),
      zoomIn: () => this.zoomIn(),
      zoomToFit: () => this.zoomToFit(),
      recompilePreview: () => this.recompilePreviewManually(),
      showImageHeavyDetails: () => this.draftPreviewController.showImageHeavyDetails(),
      editorHasFocus: () => this.editorInstance.hasFocus,
      initializePreviewPageControls: () => this.initializePreviewPageControls(),
      updatePreviewZoomLabel: () => this.updatePreviewZoomLabel(),
      updateManualForwardSyncAction: () => this.updateManualForwardSyncAction(),
      exportPdf: () => this.projectExportController.exportPdf(),
      exportProject: () => this.projectExportController.exportProjectArchive(),
      exportSourceZip: () => this.projectExportController.exportSourceZip(),
      undo: () => { undo({ state: this.editorInstance.state, dispatch: this.editorInstance.dispatch }); },
      redo: () => { redo({ state: this.editorInstance.state, dispatch: this.editorInstance.dispatch }); },
      foldCurrentFile: () => this.foldCurrentFile(),
      unfoldCurrentFile: () => this.unfoldCurrentFile(),
      toggleSidebar: () => this.sidebarController.toggle(),
      setSidebarTool: tool => this.sidebarController.setTool(tool),
      restoreDefaultLayout: () => this.restoreDefaultLayout(),
      toggleEditorToolbar: () => this.toggleEditorToolbar(),
      toggleLogConsole: () => this.logConsoleController.toggle(),
      clearLogs: () => this.logConsoleController.clearLogs(),
      restartLsp: async () => {
        this.tinymistPreviewRecoveryController.resetAttempts();
        this.logConsoleController.clearAllLogs();
        this.previewFrame.clear();
        try {
          await this.restartTinymistSession("Restarting LSP...");
        } catch (error) {
          this.lspReady = false;
          this.setLspStatus({ kind: "error", message: `LSP restart failed: ${String(error)}` });
          return;
        }
        await this.restoreActiveDocumentAfterTinymistRestart();
      },
      openExamplesWorkspace: () => this.openExamplesWorkspace(),
      startWindowStateMonitor: () => this.windowStateController.start(),
      hasUnsavedChanges: () => this.openTabs.some(tab => tab.isDirty),
      prepareForClose: () => this.appUpdateController.prepareForClose(),
      persistWorkspaceState: () => this.saveWorkspaceState(),
      persistWindowState: () => this.windowStateController.persistNow(),
      wysiwymContainer: this.wysiwymContainer,
      isWysiwymMode: () => this.activeMode === "WYSIWYM",
      handleWysiwymInput: () => this.handleContentMutation(this.mapWysiwymToMarkup()),
      previewPane: this.previewPane,
      handlePreviewSourceLocation: (line, column) => {
        const cursor = this.editorPositionFromSourceLocation(line, column);
        if (this.activeMode === "WYSIWYM") this.switchViewLayoutMode();
        this.previewSyncController.suppressOnce();
        this.editorInstance.dispatch({ selection: { anchor: cursor }, scrollIntoView: true });
        this.editorInstance.focus();
        void this.previewSyncController.renderAtCursor(cursor);
      },
    });
  }

  private async drainPendingProjectImports(): Promise<void> {
    const paths = await invoke<string[]>("take_pending_project_imports").catch(error => {
      console.error("Failed to read pending Typsastra project imports:", error);
      return [];
    });
    for (const path of paths) {
      this.projectImportQueue = this.projectImportQueue
        .then(() => this.importTypsastraProject(path))
        .catch(error => console.error("Queued Typsastra project import failed:", error));
    }
    await this.projectImportQueue;
  }

  private mapMarkupToWysiwym(markup: string) {
    this.wysiwymAdapter.render(markup);
  }

  private editorPositionFromSourceLocation(lineNumber: number, columnNumber: number): number {
    return this.sourceLocationController.editorPositionFromSourceLocation(lineNumber, columnNumber);
  }

  private utf8ByteOffsetToStringOffset(text: string, byteOffset: number): number {
    return this.sourceLocationController.utf8ByteOffsetToStringOffset(text, byteOffset);
  }

  private mapWysiwymToMarkup(): string {
    return this.wysiwymAdapter.serialize();
  }



  private getCacheRootPath(): string | null {
    return this.sourceLocationController.cacheRootPath();
  }

  private mapToOriginalPath(cachePath: string): string {
    return this.sourceLocationController.mapToOriginalPath(cachePath);
  }

  private isRenderCachePath(path: string): boolean {
    return this.sourceLocationController.isRenderCachePath(path);
  }

  private async pdfGeneratedPreviewText(originalPath: string): Promise<string> {
    return this.pdfPreviewPreparationController.generatedPreviewText(originalPath);
  }

  private async getLspUriAndContent(path: string, originalContent: string): Promise<{ uri: string; content: string } | null> {
    return this.sourceLocationController.resolveLspDocument(path, originalContent);
  }

  private getActiveLspUri(): string {
    return this.sourceLocationController.activeLspUri();
  }

  private mapCacheLspPositionToOriginalEditorOffset(
    cacheRelPath: string,
    position: LspSourcePosition,
    cacheContent: string
  ): Promise<number | null> {
    return this.sourceLocationController.mapCacheLspPositionToOriginalEditorOffset(cacheRelPath, position, cacheContent);
  }

  private prepareRenderProjectIfNeeded(): Promise<void> {
    return this.pdfPreviewPreparationController.prepareProjectIfNeeded();
  }

}
