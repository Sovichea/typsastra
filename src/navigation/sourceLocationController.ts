import { invoke } from "@tauri-apps/api/core";
import { EditorView } from "@codemirror/view";
import type { TinymistLspClient, LspSourcePosition } from "../compiler/lsp";
import { isTypstDocumentPath } from "../platform/fileTypes";
import { filePathFromUri, filePathKey, filePathToUri, nativeFilePath, relativeFilePath } from "../platform/paths";
import { decodeRustUnicodeEscapes } from "../compiler/previewError";

export interface SourceLocationDependencies {
  workspaceRootPath(): string | null;
  cacheRootPath(): string | null;
  activeFilePath(): string | null;
  editor(): EditorView;
  lspClient(): TinymistLspClient | undefined;
  loadFile(path: string): Promise<void>;
  activeTabContentLoaded(): boolean;
  generatedPreviewText(originalPath: string): Promise<string>;
  resolveOpenTabPath?(path: string): string | null;
}

/** Owns workspace/cache source mapping and editor navigation for LSP locations. */
export class SourceLocationController {
  constructor(private readonly deps: SourceLocationDependencies) {}

  editorPositionFromSourceLocation(lineNumber: number, columnNumber: number): number {
    const doc = this.deps.editor().state.doc;
    const line = doc.line(Math.max(1, Math.min(lineNumber, doc.lines)));
    const character = this.utf8ByteOffsetToStringOffset(line.text, Math.max(0, columnNumber - 1));
    return line.from + character;
  }

  cacheRootPath(): string | null {
    return this.deps.cacheRootPath()?.replace(/\\/g, "/") ?? null;
  }

  mapToOriginalPath(cachePath: string): string {
    const workspaceRootPath = this.deps.workspaceRootPath();
    if (!workspaceRootPath) return cachePath;
    const cacheRootPath = this.cacheRootPath();
    if (!cacheRootPath) return cachePath;
    const prefix = `${normalizePathForComparison(cacheRootPath)}/render/`;
    const decodedCachePath = decodeRustUnicodeEscapes(cachePath);
    const displayCachePath = decodedCachePath.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
    const cleanCache = displayCachePath.toLowerCase();
    if (cleanCache.startsWith(prefix)) {
      const relPath = displayCachePath.substring(prefix.length);
      return `${workspaceRootPath.replace(/[\\/]+$/, "")}/${relPath}`;
    }
    return decodedCachePath;
  }

  isRenderCachePath(path: string): boolean {
    const cacheRootPath = this.cacheRootPath();
    if (!cacheRootPath) return false;
    const prefix = `${normalizePathForComparison(cacheRootPath)}/render/`;
    return normalizePathForComparison(decodeRustUnicodeEscapes(path)).startsWith(prefix);
  }

  activeLspUri(): string {
    const activeFilePath = this.deps.activeFilePath();
    if (!activeFilePath || !isTypstDocumentPath(activeFilePath)) return "";
    return filePathToUri(activeFilePath);
  }

  resolveLspDocument(path: string, originalContent: string): { uri: string; content: string } | null {
    if (!isTypstDocumentPath(path)) return null;
    return { uri: filePathToUri(path), content: originalContent };
  }

  async navigateToLspLocation(uri: string, line: number, character: number): Promise<void> {
    const rawPath = filePathFromUri(uri);
    const mappedPath = this.mapToOriginalPath(rawPath);
    // LSP URIs are always forward-slash and may carry different drive-letter
    // casing. Prefer an open tab's native path so a Ctrl+click-opened include
    // shares the workspace path identity used by preview forward sync.
    const filePath = this.deps.resolveOpenTabPath?.(mappedPath) ?? nativeFilePath(mappedPath);
    if (filePathKey(filePath) !== filePathKey(this.deps.activeFilePath() ?? "")) {
      await this.deps.loadFile(filePath);
    }
    if (!this.deps.activeTabContentLoaded()) return;

    const client = this.deps.lspClient();
    let cursor = 0;
    if (this.isRenderCachePath(rawPath) && client) {
      const workspaceRootPath = this.deps.workspaceRootPath();
      const relative = workspaceRootPath ? relativeFilePath(workspaceRootPath, filePath) : null;
      const relPath = relative === null || relative === "" ? filePath : relative;
      const cacheContent = await this.deps.generatedPreviewText(filePath);
      cursor = await this.mapCacheLspPositionToOriginalEditorOffset(
        relPath,
        { line, character },
        cacheContent,
      ) ?? 0;
    } else if (client) {
      cursor = client.editorPositionFromLspPosition({ line, character });
    } else {
      const doc = this.deps.editor().state.doc;
      const lineInfo = doc.line(Math.max(1, Math.min(line + 1, doc.lines)));
      cursor = Math.max(lineInfo.from, Math.min(lineInfo.from + character, lineInfo.to));
    }

    const editor = this.deps.editor();
    editor.dispatch({
      selection: { anchor: cursor },
      effects: EditorView.scrollIntoView(cursor, { y: "center" }),
    });
    editor.focus();
  }

  async mapCacheLspPositionToOriginalEditorOffset(
    cacheRelPath: string,
    position: LspSourcePosition,
    cacheContent: string,
  ): Promise<number | null> {
    if (!this.deps.lspClient()) return null;
    const lines = cacheContent.split(/\r?\n/);
    let utf16Offset = 0;
    for (let i = 0; i < Math.min(position.line, lines.length); i++) {
      utf16Offset += lines[i].length + 1;
    }
    if (position.line < lines.length) {
      utf16Offset += Math.min(position.character ?? 0, lines[position.line].length);
    }
    const byteOffset = new TextEncoder().encode(cacheContent.substring(0, utf16Offset)).length;
    const cacheRoot = this.cacheRootPath();
    if (!cacheRoot) return null;

    try {
      const originalByteOffset = await invoke<number | null>("map_generated_to_source", {
        cacheRoot,
        relativePath: cacheRelPath,
        generatedOffset: byteOffset,
      });
      if (originalByteOffset === null || originalByteOffset === undefined) return null;
      const originalContent = this.deps.editor().state.doc.toString();
      const originalBytes = new TextEncoder().encode(originalContent);
      const originalSubStr = new TextDecoder().decode(originalBytes.slice(0, originalByteOffset));
      return Math.max(0, Math.min(originalSubStr.length, originalContent.length));
    } catch (error) {
      console.error("Error mapping offset:", error);
      return null;
    }
  }

  utf8ByteOffsetToStringOffset(text: string, byteOffset: number): number {
    const target = Math.max(0, byteOffset);
    let bytes = 0;
    let offset = 0;
    for (const char of text) {
      const size = new TextEncoder().encode(char).length;
      if (bytes + size > target) break;
      bytes += size;
      offset += char.length;
    }
    return offset;
  }
}

function normalizePathForComparison(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/\/$/, "").toLowerCase();
}
