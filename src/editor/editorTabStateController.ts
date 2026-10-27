import type { EditorView } from "@codemirror/view";
import { isBinaryImagePath, fileExtension } from "../platform/fileTypes";
import { filePathKey } from "../platform/paths";
import type { EditorFoldRange } from "./folding";
import type { EditorController } from "./editorController";
import type { EditorTab } from "./editorTab";
import { captureEditorUndoHistory } from "./tabHistory";

export interface EditorTabStateDependencies {
  editor(): EditorView;
  editorController(): EditorController;
  activeTab(): EditorTab | null;
  activeFilePath(): string | null;
  workspaceLoading(): boolean;
  activeMode(): "CODE" | "WYSIWYM";
  currentVersion(): number;
  latestDocumentVersion(): number;
  isInternallySupportedPath(path: string): boolean;
  flushEditorContentMutation(): void;
  wysiwymMarkup(): string;
  renderTabs(): void;
  saveWorkspaceState(): void | Promise<void>;
  logSyntax(message: string): void;
}

/** Owns persisted editor-tab state, viewport restoration, folds, and dirty promotion. */
export class EditorTabStateController {
  constructor(private readonly deps: EditorTabStateDependencies) {}

  async promoteToPermanent(tab: EditorTab): Promise<void> {
    if (!tab.temporary) return;
    tab.temporary = false;
    this.deps.renderTabs();
    await this.deps.saveWorkspaceState();
  }

  persistActive(): void {
    if (this.deps.workspaceLoading()) return;
    this.deps.flushEditorContentMutation();
    const tab = this.deps.activeTab();
    if (!tab || !tab.contentLoaded) return;
    if (!this.deps.isInternallySupportedPath(tab.path) || isBinaryImagePath(tab.path) || fileExtension(tab.path) === "pdf") return;

    const editor = this.deps.editor();
    const content = this.deps.activeMode() === "WYSIWYM"
      ? this.deps.wysiwymMarkup()
      : editor.state.doc.toString();
    const selection = editor.state.selection.main;
    tab.content = content;
    tab.isDirty = tab.externalContent !== undefined || tab.content !== tab.savedContent;
    tab.version = this.deps.currentVersion();
    tab.latestVersion = this.deps.latestDocumentVersion();
    tab.selectionAnchor = selection.anchor;
    tab.selectionHead = selection.head;
    tab.scrollTop = editor.scrollDOM.scrollTop;
    tab.scrollLeft = editor.scrollDOM.scrollLeft;
    tab.scrollSnapshot = editor.scrollSnapshot();
    tab.foldRanges = tab.foldStateExplicit ? this.collectCurrentFoldRanges() : [];
    tab.undoHistory = captureEditorUndoHistory(editor.state);
    if (this.deps.activeMode() === "CODE") tab.editorState = editor.state;
  }

  collectCurrentFoldRanges(): EditorFoldRange[] {
    return this.deps.editorController().collectFoldRanges();
  }

  async restoreViewport(tab: EditorTab, path: string): Promise<void> {
    const editor = this.deps.editor();
    const snapshot = () => {
      const ranges = editor.visibleRanges.map(range => `${range.from}:${range.to}`).join(",") || "none";
      return `actualScroll=${editor.scrollDOM.scrollTop.toFixed(1)}:${editor.scrollDOM.scrollLeft.toFixed(1)}; ` +
        `viewport=${ranges}; scrollClient=${editor.scrollDOM.clientWidth}x${editor.scrollDOM.clientHeight}; ` +
        `editorRect=${editor.dom.clientWidth}x${editor.dom.clientHeight}`;
    };
    this.deps.logSyntax(
      `Tab viewport restoration started: path=${path}; contentLoaded=${tab.contentLoaded}; ` +
      `savedScroll=${(tab.scrollTop ?? 0).toFixed(1)}:${(tab.scrollLeft ?? 0).toFixed(1)}; ` +
      `hasScrollSnapshot=${Boolean(tab.scrollSnapshot)}; ${snapshot()}.`,
    );
    if (tab.scrollSnapshot) {
      editor.dispatch({ effects: tab.scrollSnapshot });
      await this.waitForViewportMeasure(editor);
      this.deps.logSyntax(`Tab viewport restored from snapshot: path=${path}; ${snapshot()}.`);
      return;
    }
    // CodeMirror reuses its scroll element across documents. Without an
    // explicit reset, a new tab inherits the outgoing tab's offset, clamped
    // to the bottom when the new document is shorter.
    const targetScrollTop = tab.scrollTop ?? 0;
    const targetScrollLeft = tab.scrollLeft ?? 0;
    const restoreKey = { restoredPath: path };
    const scheduleRestore = (pass: number): Promise<void> => new Promise(resolve => {
      editor.requestMeasure({
        key: restoreKey,
        read: () => null,
        write: () => {
          const activeFilePath = this.deps.activeFilePath();
          if (activeFilePath && filePathKey(activeFilePath) === filePathKey(path)) {
            editor.scrollDOM.scrollTop = targetScrollTop;
            editor.scrollDOM.scrollLeft = targetScrollLeft;
          }
          this.deps.logSyntax(
            `Tab viewport restoration pass ${pass} written: path=${path}; ` +
            `active=${activeFilePath ?? "none"}; ${snapshot()}.`,
          );
          resolve();
        },
      });
    });
    await scheduleRestore(1);
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    await scheduleRestore(2);
    this.deps.logSyntax(`Tab viewport restoration completed: path=${path}; ${snapshot()}.`);
  }

  private waitForViewportMeasure(editor: EditorView): Promise<void> {
    return new Promise(resolve => {
      editor.requestMeasure({ read: () => null, write: () => resolve() });
    });
  }

  restoreFoldState(tab: EditorTab): void {
    tab.foldRanges = this.deps.editorController().restoreFoldState(
      tab.foldStateExplicit,
      tab.foldRanges,
    );
  }

  updateActiveContent(content: string): void {
    const tab = this.deps.activeTab();
    if (!tab) return;
    const wasDirty = tab.isDirty;
    tab.content = content;
    tab.isDirty = tab.externalContent !== undefined || tab.content !== tab.savedContent;
    if (tab.isDirty && tab.temporary) {
      void this.promoteToPermanent(tab);
    } else if (wasDirty !== tab.isDirty) {
      this.deps.renderTabs();
    }
  }

  markActiveDirty(): void {
    const tab = this.deps.activeTab();
    if (!tab) return;
    const wasDirty = tab.isDirty;
    tab.isDirty = true;
    if (tab.temporary) {
      void this.promoteToPermanent(tab);
    } else if (!wasDirty) {
      this.deps.renderTabs();
    }
  }
}
