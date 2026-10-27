import { invoke } from "@tauri-apps/api/core";
import { fileExtension, isBinaryImagePath, isSupportedInAppPath } from "../platform/fileTypes";
import { filePathKey } from "../platform/paths";
import type { EditorTab } from "./editorTab";
import type { EditorFoldRange } from "./folding";
import { LatestRequestGuard } from "../workspace/latestRequestGuard";

export interface EditorFileContentDependencies {
  normalizeFoldRanges(value: unknown, docLength: number): EditorFoldRange[];
}

/** Owns lazy editor-file classification and content loading. */
export class EditorFileContentController {
  private readonly detectedPlainTextPaths = new Set<string>();
  private readonly classifiedUnknownPaths = new Set<string>();
  private readonly pendingLoads = new WeakMap<EditorTab, Promise<void>>();
  private readonly loadRequests = new LatestRequestGuard<string>();

  constructor(private readonly deps: EditorFileContentDependencies) {}

  isInternallySupportedPath(path: string): boolean {
    return isSupportedInAppPath(path) || this.detectedPlainTextPaths.has(filePathKey(path));
  }

  async classifyUnknownTextPath(path: string): Promise<boolean> {
    if (isSupportedInAppPath(path)) return true;
    const key = filePathKey(path);
    if (this.classifiedUnknownPaths.has(key)) {
      return this.detectedPlainTextPaths.has(key);
    }
    const isPlainText = await invoke<boolean>("is_probably_plain_text_file", { path })
      .catch(() => false);
    this.classifiedUnknownPaths.add(key);
    if (isPlainText) this.detectedPlainTextPaths.add(key);
    return isPlainText;
  }

  invalidateLoad(path: string): void {
    this.loadRequests.invalidate(filePathKey(path));
  }

  loadTabContent(tab: EditorTab): Promise<void> {
    const pending = this.pendingLoads.get(tab);
    if (pending) return pending;
    const operation = this.readTabContent(tab).finally(() => {
      if (this.pendingLoads.get(tab) === operation) this.pendingLoads.delete(tab);
    });
    this.pendingLoads.set(tab, operation);
    return operation;
  }

  private async readTabContent(tab: EditorTab): Promise<void> {
    const path = tab.path;
    const pathKey = filePathKey(path);
    while (!tab.contentLoaded && filePathKey(tab.path) === pathKey) {
      const request = this.loadRequests.begin(pathKey);
      const prefetched = tab.prefetchedContent;
      tab.prefetchedContent = undefined;
      const contents = prefetched !== undefined
        ? normalizeEditorText(prefetched)
        : fileExtension(path) === "pdf"
        ? ""
        : isBinaryImagePath(path)
          ? await invoke<string>("read_workspace_file_as_base64", { path })
          : normalizeEditorText(await invoke<string>("read_workspace_file", { path }));
      if (!this.loadRequests.isCurrent(request)) continue;
      tab.content = contents;
      tab.savedContent = contents;
      tab.contentLoaded = true;
      tab.undoHistory = undefined;
      tab.foldRanges = this.deps.normalizeFoldRanges(tab.foldRanges, contents.length);
    }
  }
}

function normalizeEditorText(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}
