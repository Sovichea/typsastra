import type { ChangeSet, Text } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { fileNameFromPath, filePathKey, remapFilePath } from "../platform/paths";

const MAX_HISTORY_ENTRIES = 100;
const CONTEXT_BEFORE_LENGTH = 48;
const CONTEXT_AFTER_LENGTH = 96;

export type NavigationHistoryEntry = {
  path: string;
  anchor: number;
  head: number;
  scrollTop: number;
  scrollLeft: number;
  /** Short source-context anchor used to find the location after edits. */
  contextBefore: string;
  contextAfter: string;
};

export type NavigationHistoryLoadOptions = {
  skipPreviewActivation: true;
  preservePreviewViewport: true;
  focusEditor?: boolean;
};

export interface NavigationHistoryDependencies {
  activeFilePath(): string | null;
  activeTabContentLoaded(): boolean;
  editor(): EditorView;
  loadFile(path: string, options: NavigationHistoryLoadOptions): Promise<void>;
  pathExists(path: string): Promise<boolean>;
  showNotice(message: string): void;
  onChanged?(): void;
}

export interface NavigationHistoryPort {
  run(action: () => Promise<void> | void): Promise<void>;
}

export interface NavigationHistoryEditPort {
  documentChanged(path: string, changes: ChangeSet, doc: Text): void;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(value, maximum));
}

function sourceContext(doc: Text, anchor: number): { before: string; after: string } {
  const contextStart = Math.max(0, anchor - CONTEXT_BEFORE_LENGTH);
  const contextEnd = Math.min(doc.length, anchor + CONTEXT_AFTER_LENGTH);
  return {
    before: doc.sliceString(contextStart, anchor),
    after: doc.sliceString(anchor, contextEnd),
  };
}

function closestOccurrence(text: string, needle: string, expectedStart: number): number {
  if (!needle) return -1;
  let best = -1;
  let bestDistance = Number.POSITIVE_INFINITY;
  let index = text.indexOf(needle);
  while (index !== -1) {
    const distance = Math.abs(index - expectedStart);
    if (distance < bestDistance) {
      best = index;
      bestDistance = distance;
    }
    index = text.indexOf(needle, index + 1);
  }
  return best;
}

/**
 * Resolve a recorded location against the current source.
 *
 * Exact offsets are only a fallback: edits before or inside the recorded
 * context could make them point at unrelated text. The stored context is
 * resolved first so an insertion before a heading or search match keeps the
 * history entry on the same source location.
 */
export function resolveNavigationHistorySelection(
  entry: Pick<NavigationHistoryEntry, "anchor" | "head" | "contextBefore" | "contextAfter">,
  text: string,
): { anchor: number; head: number } {
  const fallbackAnchor = clamp(entry.anchor, 0, text.length);
  let anchor = fallbackAnchor;
  const combined = entry.contextBefore + entry.contextAfter;
  const combinedMatch = closestOccurrence(
    text,
    combined,
    entry.anchor - entry.contextBefore.length,
  );
  if (combinedMatch !== -1) {
    anchor = combinedMatch + entry.contextBefore.length;
  } else {
    const beforeMatch = closestOccurrence(
      text,
      entry.contextBefore,
      entry.anchor - entry.contextBefore.length,
    );
    if (beforeMatch !== -1) {
      anchor = beforeMatch + entry.contextBefore.length;
    } else {
      const afterMatch = closestOccurrence(text, entry.contextAfter, entry.anchor);
      if (afterMatch !== -1) anchor = afterMatch;
    }
  }
  anchor = clamp(anchor, 0, text.length);
  const head = clamp(anchor + (entry.head - entry.anchor), 0, text.length);
  return { anchor, head };
}

/** Owns session-only Back/Forward source navigation. */
export class NavigationHistoryController implements NavigationHistoryPort {
  private entries: NavigationHistoryEntry[] = [];
  private index = -1;
  private epoch = 0;
  private operationToken = 0;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly deps: NavigationHistoryDependencies) {}

  public canGoBack(): boolean {
    return this.index > 0;
  }

  public canGoForward(): boolean {
    return this.index >= 0 && this.index < this.entries.length - 1;
  }

  public run(action: () => Promise<void> | void): Promise<void> {
    // Explicit jumps share the replay queue. A newer request invalidates queued
    // work so overlapping loads cannot leave the active tab and stack disagreeing.
    const epoch = this.epoch;
    const token = ++this.operationToken;
    const task = this.queue.then(async () => {
      if (token !== this.operationToken || epoch !== this.epoch) return;
      const departure = this.captureCurrent();
      if (departure) this.syncCurrent(departure);

      await action();
      if (token !== this.operationToken || epoch !== this.epoch) return;

      const destination = this.captureCurrent();
      if (!destination) return;
      if (departure && sameLocation(departure, destination)) {
        this.notify();
        return;
      }
      this.entries.push(destination);
      this.index = this.entries.length - 1;
      this.trim();
      this.notify();
    });
    this.queue = task.catch(() => undefined);
    return task;
  }

  public back(): Promise<void> {
    return this.enqueueReplay("back");
  }

  public forward(): Promise<void> {
    return this.enqueueReplay("forward");
  }

  /** Keep recorded offsets attached to their source text while a file is edited. */
  public documentChanged(path: string, changes: ChangeSet, doc: Text): void {
    const key = filePathKey(path);
    for (const entry of this.entries) {
      if (filePathKey(entry.path) !== key) continue;
      const collapsed = entry.anchor === entry.head;
      entry.anchor = clamp(changes.mapPos(entry.anchor, -1), 0, doc.length);
      entry.head = clamp(changes.mapPos(entry.head, collapsed ? -1 : 1), 0, doc.length);
      const context = sourceContext(doc, entry.anchor);
      entry.contextBefore = context.before;
      entry.contextAfter = context.after;
    }
  }

  public rename(oldPath: string, newPath: string): void {
    let changed = false;
    for (const entry of this.entries) {
      const renamed = remapFilePath(entry.path, oldPath, newPath);
      if (renamed === entry.path) continue;
      entry.path = renamed;
      changed = true;
    }
    if (changed) this.notify();
  }

  public clear(): void {
    this.epoch += 1;
    this.operationToken += 1;
    this.entries = [];
    this.index = -1;
    this.notify();
  }

  private enqueueReplay(direction: "back" | "forward"): Promise<void> {
    const epoch = this.epoch;
    const token = ++this.operationToken;
    const task = this.queue.then(() => this.replay(direction, token, epoch));
    this.queue = task.catch(() => undefined);
    return task;
  }

  private async replay(
    direction: "back" | "forward",
    token: number,
    epoch: number,
  ): Promise<void> {
    if (token !== this.operationToken || epoch !== this.epoch) return;

    // Back/Forward are jumps too. Keep the departure location on the entry we
    // are leaving so Forward returns to where the user actually was.
    const departure = this.captureCurrent();
    if (departure && this.index >= 0 && this.index < this.entries.length) {
      this.entries[this.index] = departure;
    }

    const step = direction === "back" ? -1 : 1;
    let target = this.index + step;
    while (target >= 0 && target < this.entries.length) {
      if (token !== this.operationToken || epoch !== this.epoch) return;
      const entry = this.entries[target];
      const exists = await this.deps.pathExists(entry.path).catch(() => false);
      if (token !== this.operationToken || epoch !== this.epoch) return;
      if (exists) break;

      this.deps.showNotice(
        `Cannot go ${direction}: ${fileNameFromPath(entry.path)} no longer exists.`,
      );
      this.entries.splice(target, 1);
      if (this.index > target) this.index -= 1;
      // Back moves toward older entries, which shift into the removed slot.
      // Forward moves toward newer entries, which slide into the same index.
      if (direction === "back") target -= 1;
      this.notify();
    }
    if (target < 0 || target >= this.entries.length) return;

    const entry = this.entries[target];
    const activePath = this.deps.activeFilePath();
    if (!activePath || filePathKey(activePath) !== filePathKey(entry.path)) {
      await this.deps.loadFile(entry.path, {
        skipPreviewActivation: true,
        preservePreviewViewport: true,
        focusEditor: false,
      });
      if (token !== this.operationToken || epoch !== this.epoch) return;
    }
    if (
      !this.deps.activeTabContentLoaded()
      || filePathKey(this.deps.activeFilePath() ?? "") !== filePathKey(entry.path)
    ) {
      this.deps.showNotice(
        `Cannot go ${direction}: ${fileNameFromPath(entry.path)} could not be opened.`,
      );
      return;
    }

    this.apply(entry);
    this.index = target;
    this.notify();
  }

  private captureCurrent(): NavigationHistoryEntry | null {
    const path = this.deps.activeFilePath();
    if (!path || !this.deps.activeTabContentLoaded()) return null;
    const editor = this.deps.editor();
    if (!editor) return null;
    const doc = editor.state.doc;
    const selection = editor.state.selection.main;
    const anchor = clamp(selection.anchor, 0, doc.length);
    const head = clamp(selection.head, 0, doc.length);
    const context = sourceContext(doc, anchor);
    return {
      path,
      anchor,
      head,
      scrollTop: editor.scrollDOM?.scrollTop ?? 0,
      scrollLeft: editor.scrollDOM?.scrollLeft ?? 0,
      contextBefore: context.before,
      contextAfter: context.after,
    };
  }

  private apply(entry: NavigationHistoryEntry): void {
    const editor = this.deps.editor();
    const selection = resolveNavigationHistorySelection(entry, editor.state.doc.toString());
    editor.dispatch({ selection });
    editor.focus();

    const restoreViewport = () => {
      if (filePathKey(this.deps.activeFilePath() ?? "") !== filePathKey(entry.path)) return;
      editor.scrollDOM.scrollTop = entry.scrollTop;
      editor.scrollDOM.scrollLeft = entry.scrollLeft;
    };
    // Restore the recorded viewport after CodeMirror has measured the newly
    // selected document position. Selection and viewport are separate: the
    // user may deliberately have scrolled away from the caret before jumping.
    restoreViewport();
    editor.requestMeasure({
      key: this,
      read: () => null,
      write: restoreViewport,
    });
  }

  private syncCurrent(location: NavigationHistoryEntry): void {
    if (this.entries.length === 0) {
      this.entries.push(location);
      this.index = 0;
    } else {
      this.entries.length = Math.min(this.entries.length, this.index + 1);
      if (this.index >= 0 && this.index < this.entries.length) {
        this.entries[this.index] = location;
      } else {
        this.entries.push(location);
        this.index = this.entries.length - 1;
      }
    }
    this.notify();
  }

  private trim(): void {
    const excess = this.entries.length - MAX_HISTORY_ENTRIES;
    if (excess <= 0) return;
    this.entries.splice(0, excess);
    this.index = Math.max(0, this.index - excess);
  }

  private notify(): void {
    this.deps.onChanged?.();
  }
}

function sameLocation(
  first: Pick<NavigationHistoryEntry, "path" | "anchor" | "head">,
  second: Pick<NavigationHistoryEntry, "path" | "anchor" | "head">,
): boolean {
  return filePathKey(first.path) === filePathKey(second.path)
    && first.anchor === second.anchor
    && first.head === second.head;
}
