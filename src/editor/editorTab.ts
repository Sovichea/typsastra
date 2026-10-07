import type { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { EditorFoldRange } from "./folding";
import type { EditorUndoHistory } from "./tabHistory";

export type EditorTab = {
  path: string;
  content: string;
  savedContent: string;
  contentLoaded: boolean;
  isDirty: boolean;
  previewRootPath: string | null;
  previewMainPath: string | null;
  previewTaskId: string | null;
  previewSessionKey: string | null;
  previewImported: boolean;
  previewStandalone: boolean;
  previewDisabled: boolean;
  version: number;
  latestVersion: number;
  selectionAnchor: number;
  selectionHead: number;
  scrollTop?: number;
  scrollLeft?: number;
  /** Last vertical position of the preview while this tab was active. */
  previewScrollTop?: number;
  scrollSnapshot?: ReturnType<EditorView["scrollSnapshot"]>;
  foldRanges: EditorFoldRange[] | null;
  foldStateExplicit: boolean;
  sizeBytes?: number;
  lineCount?: number;
  temporary?: boolean;
  /**
   * True when the file is open beside a project without belonging to it. The
   * tab is marked, has no explorer entry, and hides project gutter tools.
   */
  offProject?: boolean;
  undoHistory?: EditorUndoHistory;
  /**
   * Runtime-only CodeMirror state retained while the tab is inactive.
   *
   * Keeping the immutable state preserves CodeMirror's syntax tree, so a
   * previously visited tab can be painted with highlighting immediately.
   * Workspace persistence deliberately ignores this field.
   */
  editorState?: EditorState;
  /** File-language extension used when the retained editor state was built. */
  editorStateLanguage?: string;
};

export type PreviewSessionState = Pick<
  EditorTab,
  "previewRootPath" | "previewMainPath" | "previewTaskId" | "previewSessionKey" | "previewImported" | "previewStandalone" | "previewDisabled"
>;
