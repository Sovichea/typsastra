import { invoke } from "@tauri-apps/api/core";
import type { EditorView } from "@codemirror/view";
import type { EditorTab } from "../editor/editorTab";
import { fileNameFromPath, filePathKey, remapFilePath } from "../platform/paths";
import { t } from "../i18n";
import {
  canRecoverTab,
  recoveryDocumentId,
  recoveryDocumentIdForTab,
  recoveryTabName,
  sha256Hex,
} from "./recoveryIdentity";

const SNAPSHOT_IDLE_MS = 1_000;
const SNAPSHOT_MAX_MS = 5_000;

export type RecoveryRecord = {
  version: number;
  documentId: string;
  workspaceRoot: string | null;
  path: string | null;
  /** Display title for pathless untitled buffers. */
  title: string | null;
  text: string;
  savedTextHash: string;
  revision: number;
  timestampMs: number;
  selectionAnchor: number;
  selectionHead: number;
  scrollTop: number;
  scrollLeft: number;
};

export type RecoveryRecordSummary = {
  version: number;
  documentId: string;
  workspaceRoot: string | null;
  path: string | null;
  title: string | null;
  revision: number;
  timestampMs: number;
  bytes: number;
};

export type RecoveryCorruptRecord = {
  fileName: string;
  bytes: number;
  error: string;
};

export type RecoveryListing = {
  records: RecoveryRecordSummary[];
  corrupt: RecoveryCorruptRecord[];
  totalBytes: number;
  limitBytes: number;
};

export type RecoveryWriteResult = {
  written: boolean;
  reason: string | null;
  revision: number;
  currentRevision: number | null;
  bytes: number;
  totalBytes: number;
  limitBytes: number;
};

export type RecoveryDeleteResult = {
  deleted: boolean;
  reason: string | null;
  currentRevision: number | null;
};

export interface RecoveryControllerDependencies {
  activeTab(): EditorTab | null;
  openTabs(): readonly EditorTab[];
  activeFilePath(): string | null;
  workspaceRootPath(): string | null;
  editor(): EditorView | undefined;
  logWarning(message: string, persistent?: boolean): void;
  onListingChanged?(listing: RecoveryListing): void;
}

type DocumentState = {
  revision: number;
  lastWriteAt: number;
  timer: number | null;
  chain: Promise<void>;
};

/** Owns debounced, serialized unsaved-text snapshots in native recovery storage. */
export class RecoveryController {
  private readonly documentStates = new Map<string, DocumentState>();
  private listing: RecoveryListing = {
    records: [],
    corrupt: [],
    totalBytes: 0,
    limitBytes: 100 * 1024 * 1024,
  };

  constructor(private readonly deps: RecoveryControllerDependencies) {}

  public async initialize(): Promise<RecoveryListing> {
    await this.refreshListing();
    return this.listing;
  }

  public currentListing(): RecoveryListing {
    return this.listing;
  }

  public async refreshListing(): Promise<RecoveryListing> {
    const listing = await invoke<RecoveryListing>("list_recovery_records");
    this.listing = listing;
    for (const record of listing.records) {
      this.stateFor(record.documentId, record.revision);
    }
    this.deps.onListingChanged?.(listing);
    return listing;
  }

  public noteActiveDocumentChanged(): void {
    const tab = this.deps.activeTab();
    if (!tab?.isDirty || !canRecoverTab(tab)) return;
    const documentId = this.documentIdFor(tab);
    const state = this.stateFor(documentId);
    if (state.timer !== null) window.clearTimeout(state.timer);
    const untilMaximum = state.lastWriteAt + SNAPSHOT_MAX_MS - Date.now();
    if (untilMaximum <= 0) {
      state.timer = null;
      void this.writeTabSnapshot(tab, true);
      return;
    }
    state.timer = window.setTimeout(() => {
      state.timer = null;
      void this.writeTabSnapshot(tab, true);
    }, Math.min(SNAPSHOT_IDLE_MS, untilMaximum));
  }

  public async flushTab(tab: EditorTab, live = false): Promise<RecoveryWriteResult | null> {
    const documentId = this.documentIdFor(tab);
    const state = this.stateFor(documentId);
    if (state.timer !== null) {
      window.clearTimeout(state.timer);
      state.timer = null;
    }
    return this.writeTabSnapshot(tab, live);
  }

  public async flushDirtyTabs(): Promise<void> {
    const activePath = this.deps.activeFilePath();
    await Promise.all(this.deps.openTabs()
      .filter(tab => tab.isDirty && tab.contentLoaded && canRecoverTab(tab))
      .map(tab => this.writeTabSnapshot(
        tab,
        !!activePath && filePathKey(tab.path) === filePathKey(activePath),
      )));
  }

  public recoveryRevision(tab: EditorTab): number {
    return this.stateFor(this.documentIdFor(tab)).revision;
  }

  public async handleTabSaved(tab: EditorTab, revision?: number): Promise<void> {
    try {
      const documentId = this.documentIdFor(tab);
      const state = this.documentStates.get(documentId);
      if (!state) return;
      if (state.timer !== null) {
        window.clearTimeout(state.timer);
        state.timer = null;
      }
      const expectedRevision = revision ?? state.revision;
      await state.chain;
      await this.deleteRecord(documentId, expectedRevision);
    } catch (error) {
      this.deps.logWarning(
        `Could not clear the recovery snapshot for ${recoveryTabName(tab)} after saving: ${String(error)}`,
        true,
      );
    }
  }

  public async discardTab(tab: EditorTab): Promise<void> {
    try {
      const documentId = this.documentIdFor(tab);
      const state = this.documentStates.get(documentId);
      if (state?.timer !== null && state?.timer !== undefined) {
        window.clearTimeout(state.timer);
        state.timer = null;
      }
      await state?.chain;
      const result = await this.deleteRecord(documentId);
      if (result.deleted || result.reason === "missing") {
        this.documentStates.delete(documentId);
      } else {
        this.stateFor(documentId, result.currentRevision ?? state?.revision ?? 0);
      }
    } catch (error) {
      this.deps.logWarning(
        `Could not discard the recovery snapshot for ${recoveryTabName(tab)}: ${String(error)}`,
        true,
      );
    }
  }

  public async discardAllTabs(tabs: readonly EditorTab[]): Promise<void> {
    await Promise.all(tabs.filter(canRecoverTab).map(tab => this.discardTab(tab)));
  }

  public async rename(oldPath: string, newPath: string): Promise<void> {
    const workspaceRoot = this.deps.workspaceRootPath();
    const oldIds = new Set([recoveryDocumentId(workspaceRoot, oldPath)]);
    for (const record of this.listing.records) {
      if (!record.path) continue;
      const renamed = remapFilePath(record.path, oldPath, newPath);
      if (renamed !== record.path) {
        oldIds.add(recoveryDocumentId(workspaceRoot, record.path));
      }
    }
    for (const oldId of oldIds) {
      const newId = recoveryDocumentId(workspaceRoot, newPath);
      if (oldId === newId) continue;
      try {
        const state = this.documentStates.get(oldId);
        if (state?.timer !== null && state?.timer !== undefined) {
          window.clearTimeout(state.timer);
          state.timer = null;
        }
        await state?.chain;
        const result = await this.deleteRecord(oldId);
        if (result.deleted || result.reason === "missing") {
          this.documentStates.delete(oldId);
        } else {
          this.stateFor(oldId, result.currentRevision ?? state?.revision ?? 0);
        }
      } catch (error) {
        this.deps.logWarning(
          `Could not move the recovery snapshot after renaming ${fileNameFromPath(oldPath)}: ${String(error)}`,
          true,
        );
      }
    }
  }

  public async readRecord(documentId: string): Promise<RecoveryRecord | null> {
    return invoke<RecoveryRecord | null>("read_recovery_record", { documentId });
  }

  public async discardRecord(documentId: string, revision?: number): Promise<RecoveryDeleteResult> {
    const state = this.documentStates.get(documentId);
    if (state?.timer !== null && state?.timer !== undefined) {
      window.clearTimeout(state.timer);
      state.timer = null;
    }
    await state?.chain;
    const result = await this.deleteRecord(documentId, revision);
    if (result.deleted) this.documentStates.delete(documentId);
    else this.stateFor(documentId, result.currentRevision ?? revision ?? 0);
    return result;
  }

  public async deleteCorruptRecord(fileName: string): Promise<void> {
    await invoke("delete_corrupt_recovery_record", { fileName });
    await this.refreshListing();
  }

  private documentIdFor(tab: EditorTab): string {
    return recoveryDocumentIdForTab(this.deps.workspaceRootPath(), tab);
  }

  private stateFor(documentId: string, existingRevision = 0): DocumentState {
    let state = this.documentStates.get(documentId);
    if (!state) {
      state = {
        revision: existingRevision,
        lastWriteAt: Date.now(),
        timer: null,
        chain: Promise.resolve(),
      };
      this.documentStates.set(documentId, state);
    } else if (existingRevision > state.revision) {
      state.revision = existingRevision;
    }
    return state;
  }

  private writeTabSnapshot(
    tab: EditorTab,
    live: boolean,
  ): Promise<RecoveryWriteResult | null> {
    if (!tab.isDirty || !canRecoverTab(tab)) return Promise.resolve(null);
    const documentId = this.documentIdFor(tab);
    const state = this.stateFor(documentId);
    const revision = ++state.revision;
    const snapshot = this.captureSnapshot(tab, documentId, revision, live);
    const savedContent = tab.savedContent;
    let result: RecoveryWriteResult | null = null;
    const operation = state.chain.then(async () => {
      try {
        const savedTextHash = await sha256Hex(savedContent);
        result = await invoke<RecoveryWriteResult>("write_recovery_record", {
          record: { ...snapshot, savedTextHash },
        });
        state.lastWriteAt = Date.now();
        if (!result.written && result.reason !== "stale-revision") {
          this.reportWriteFailure(tab, result.reason ?? "unknown error", result);
        }
      } catch (error) {
        state.lastWriteAt = Date.now();
        this.reportWriteFailure(tab, String(error));
      }
    });
    state.chain = operation.catch(() => undefined);
    return operation.then(() => result);
  }

  private captureSnapshot(
    tab: EditorTab,
    documentId: string,
    revision: number,
    live: boolean,
  ): Omit<RecoveryRecord, "savedTextHash"> {
    const activeTab = this.deps.activeTab();
    const editor = this.deps.editor();
    const useLiveEditor = live
      && !!editor
      && !!activeTab
      && filePathKey(activeTab.path) === filePathKey(tab.path);
    const selection = useLiveEditor ? editor!.state.selection.main : null;
    return {
      version: 1,
      documentId,
      workspaceRoot: this.deps.workspaceRootPath(),
      path: tab.untitled ? null : tab.path,
      title: tab.untitled ? (tab.title ?? t("Untitled")) : null,
      text: useLiveEditor ? editor!.state.doc.toString() : tab.content,
      revision,
      timestampMs: Date.now(),
      selectionAnchor: selection?.anchor ?? tab.selectionAnchor,
      selectionHead: selection?.head ?? tab.selectionHead,
      scrollTop: useLiveEditor ? editor!.scrollDOM.scrollTop : (tab.scrollTop ?? 0),
      scrollLeft: useLiveEditor ? editor!.scrollDOM.scrollLeft : (tab.scrollLeft ?? 0),
    };
  }

  private async deleteRecord(documentId: string, expectedRevision?: number): Promise<RecoveryDeleteResult> {
    return invoke<RecoveryDeleteResult>("delete_recovery_record", {
      documentId,
      expectedRevision: expectedRevision ?? null,
    });
  }

  private reportWriteFailure(
    tab: EditorTab,
    reason: string,
    result?: RecoveryWriteResult,
  ): void {
    const detail = result?.reason === "quota-exceeded"
      ? `the ${Math.round(result.totalBytes / (1024 * 1024))} MiB recovery limit is full`
      : reason;
    this.deps.logWarning(
      `Recovery snapshot for ${recoveryTabName(tab)} could not be written: ${detail}. The previous valid snapshot was kept and will be offered when its project is opened.`,
      true,
    );
  }
}
