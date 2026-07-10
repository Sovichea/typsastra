import { EditorView } from "@codemirror/view";
import type { TinymistLspClient } from "../compiler/lsp";
import type { PreviewClickPoint } from "./previewFrame";

export type PreviewSyncDependencies = {
  getEditor: () => EditorView | undefined;
  getClient: () => TinymistLspClient | undefined;
  getActiveFilePath: () => string | null;
  getPreviewRootPath: () => string | null;
  getPreviewTaskId: () => string | null;
  isReady: () => boolean;
  isEnabled: () => boolean;
  handleForwardPosition?: (path: string, cursor: number) => Promise<boolean>;
  mapForwardPosition?: (path: string, cursor: number) => Promise<{ filepath: string; line: number; character: number } | null>;
};

export class PreviewSyncController {
  private forwardTimer: number | null = null;
  private forwardGeneration = 0;
  private forwardSuppressedUntil = 0;
  private lastForwardTarget: { key: string; timestamp: number } | null = null;
  private pendingPreviewClick: (PreviewClickPoint & { timestamp: number }) | null = null;

  constructor(
    private readonly dependencies: PreviewSyncDependencies
  ) {}

  public recordPreviewClick(point: PreviewClickPoint): void {
    this.pendingPreviewClick = { ...point, timestamp: Date.now() };
  }

  public hasRecentPreviewClick(maxAgeMs = 1500): boolean {
    return this.pendingPreviewClick !== null && Date.now() - this.pendingPreviewClick.timestamp <= maxAgeMs;
  }

  public schedule(delayMs: number): void {
    if (!this.canSync() || this.isForwardSuppressed()) return;
    this.clearForward();
    const generation = ++this.forwardGeneration;
    this.forwardTimer = window.setTimeout(() => {
      this.forwardTimer = null;
      if (generation !== this.forwardGeneration || this.isForwardSuppressed()) return;
      const cursor = this.dependencies.getEditor()?.state.selection.main.head;
      if (cursor !== undefined) void this.renderAtCursor(cursor);
    }, delayMs);
  }

  public async renderAtCursor(cursor: number): Promise<void> {
    const editor = this.dependencies.getEditor();
    const path = this.dependencies.getActiveFilePath();
    if (!editor || !path || !this.dependencies.isReady() || !this.dependencies.isEnabled() || this.isForwardSuppressed()) return;

    this.clearForward();
    await this.navigateToCursor(cursor, ++this.forwardGeneration);
  }

  public async navigateToCursor(cursor: number, generation = ++this.forwardGeneration): Promise<void> {
    const editor = this.dependencies.getEditor();
    const path = this.dependencies.getActiveFilePath();
    if (!editor || !path || !this.dependencies.isReady() || !this.dependencies.isEnabled() || this.isForwardSuppressed()) return;

    if (this.dependencies.handleForwardPosition) {
      const handled = await this.dependencies.handleForwardPosition(path, cursor);
      if (generation !== this.forwardGeneration) return;
      if (handled) return;
    }

    const client = this.dependencies.getClient();
    const taskId = this.dependencies.getPreviewTaskId();
    if (!client || !this.dependencies.getPreviewRootPath() || !taskId) return;

    if (this.dependencies.mapForwardPosition) {
      const mapped = await this.dependencies.mapForwardPosition(path, cursor);
      if (generation !== this.forwardGeneration) return;
      if (mapped) {
        if (this.isDuplicateForwardTarget(taskId, mapped.filepath, mapped.line, mapped.character)) return;
        await client.scrollPreview(taskId, {
          event: "panelScrollTo",
          filepath: mapped.filepath,
          line: mapped.line,
          character: mapped.character
        });
        return;
      }
    }

    const position = Math.max(0, Math.min(cursor, editor.state.doc.length));
    const line = editor.state.doc.lineAt(position);
    const character = client.lspCharacterFromStringOffset(line.text, position - line.from);
    if (generation !== this.forwardGeneration) return;
    if (this.isDuplicateForwardTarget(taskId, path, line.number - 1, character)) return;
    await client.scrollPreview(taskId, {
      event: "panelScrollTo",
      filepath: path,
      line: line.number - 1,
      character
    });
  }

  public suppressOnce(): void {
    this.clearForward();
    this.forwardGeneration++;
  }

  public clearForward(): void {
    if (this.forwardTimer) window.clearTimeout(this.forwardTimer);
    this.forwardTimer = null;
  }

  public suppressForwardFor(durationMs: number): void {
    this.forwardSuppressedUntil = Math.max(this.forwardSuppressedUntil, Date.now() + durationMs);
    this.clearForward();
    this.forwardGeneration++;
  }

  public reset(): void {
    this.clearForward();
    this.forwardGeneration++;
    this.forwardSuppressedUntil = 0;
    this.lastForwardTarget = null;
    this.pendingPreviewClick = null;
  }

  private isForwardSuppressed(): boolean {
    return Date.now() < this.forwardSuppressedUntil;
  }

  private canSync(): boolean {
    return this.dependencies.isEnabled()
      && !!this.dependencies.getActiveFilePath()
      && !!this.dependencies.getPreviewRootPath()
      && this.dependencies.isReady()
      && (!!this.dependencies.handleForwardPosition
        || (!!this.dependencies.getPreviewTaskId() && !!this.dependencies.getClient()));
  }

  private isDuplicateForwardTarget(taskId: string, filepath: string, line: number, character: number): boolean {
    const now = Date.now();
    const key = `${taskId}\u0000${filepath}\u0000${line}\u0000${character}`;
    if (this.lastForwardTarget?.key === key && now - this.lastForwardTarget.timestamp < 500) {
      return true;
    }
    this.lastForwardTarget = { key, timestamp: now };
    return false;
  }

}
