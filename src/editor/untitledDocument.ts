import { untitledDocumentPath } from "../platform/paths";
import type { EditorTab } from "./editorTab";

export const UNTITLED_DOCUMENT_DEFAULT_CONTENT = "= New Document\n";

export function nextUntitledTitle(tabs: readonly EditorTab[]): string {
  const used = new Set(
    tabs
      .filter(tab => tab.untitled)
      .map(tab => tab.title ?? "")
      .filter(Boolean),
  );
  let index = 1;
  while (used.has(`Untitled ${index}`)) index += 1;
  return `Untitled ${index}`;
}

export function createUntitledTab(options: {
  id: string;
  title: string;
  content?: string;
  savedContent?: string;
  dirty?: boolean;
  recoveredUnsaved?: boolean;
  selectionAnchor?: number;
  selectionHead?: number;
  scrollTop?: number;
  scrollLeft?: number;
}): EditorTab {
  const content = options.content ?? UNTITLED_DOCUMENT_DEFAULT_CONTENT;
  const savedContent = options.savedContent ?? "";
  return {
    path: untitledDocumentPath(options.id),
    untitled: true,
    untitledId: options.id,
    title: options.title,
    content,
    savedContent,
    contentLoaded: true,
    isDirty: options.dirty ?? content !== savedContent,
    recoveredUnsaved: options.recoveredUnsaved,
    previewRootPath: null,
    previewMainPath: null,
    previewTaskId: null,
    previewSessionKey: null,
    previewImported: false,
    previewStandalone: true,
    previewDisabled: true,
    version: 1,
    latestVersion: 1,
    selectionAnchor: options.selectionAnchor ?? 0,
    selectionHead: options.selectionHead ?? 0,
    scrollTop: options.scrollTop ?? 0,
    scrollLeft: options.scrollLeft ?? 0,
    foldRanges: [],
    foldStateExplicit: false,
    temporary: false,
  };
}
