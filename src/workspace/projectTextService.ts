import { invoke } from "@tauri-apps/api/core";
import type { EditorTab } from "../editor/editorTab";
import { filePathKey, relativeFilePath } from "../platform/paths";
import { LatestRequestGuard } from "./latestRequestGuard";

export const PROJECT_TEXT_MAX_BYTES = 10 * 1024 * 1024;
export const PROJECT_TEXT_MAX_CONCURRENT_READS = 4;

export type ProjectTextSkipReason =
  | "tooLarge"
  | "binary"
  | "unreadable"
  | "cancelled";

export type ProjectTextLineEnding = "none" | "lf" | "crlf" | "cr" | "mixed";

type NativeProjectTextSkipReason = Exclude<ProjectTextSkipReason, "cancelled">;

export type ProjectTextFileInfo = {
  path: string;
  relativePath: string;
  identity: string;
  sizeBytes: number;
  modifiedMs: number;
};

export type ProjectTextSkippedFile = {
  path: string;
  relativePath: string;
  sizeBytes: number;
  reason: ProjectTextSkipReason;
  message: string;
};

export type ProjectTextInventory = {
  workspaceRootPath: string;
  includeIgnored: boolean;
  files: readonly ProjectTextFileInfo[];
  skipped: readonly ProjectTextSkippedFile[];
  binaryFileCount: number;
  tooLargeFileCount: number;
  unreadableFileCount: number;
};

export type ProjectTextSnapshot = {
  file: ProjectTextFileInfo;
  text: string;
  revision: string;
  source: "buffer" | "disk";
  dirty: boolean;
  version: number | null;
  hasBom: boolean;
  lineEnding: ProjectTextLineEnding;
};

export type ProjectTextReadOutcome =
  | { kind: "snapshot"; snapshot: ProjectTextSnapshot }
  | { kind: "skipped"; skipped: ProjectTextSkippedFile };

export type ProjectTextBatchResult = {
  outcomes: readonly ProjectTextReadOutcome[];
  snapshots: readonly ProjectTextSnapshot[];
  skipped: readonly ProjectTextSkippedFile[];
};

type NativeProjectTextFile = {
  path: string;
  relativePath: string;
  sizeBytes: number;
  modifiedMs: number;
};

type NativeProjectTextSkippedFile = {
  path: string;
  relativePath: string;
  sizeBytes: number;
  reason: NativeProjectTextSkipReason;
  message: string;
};

type NativeProjectTextInventory = {
  workspaceRootPath: string;
  includeIgnored: boolean;
  files: NativeProjectTextFile[];
  skipped: NativeProjectTextSkippedFile[];
  binaryFileCount: number;
  tooLargeFileCount: number;
  unreadableFileCount: number;
  cancelled: boolean;
};

type NativeProjectTextReadResult = {
  path: string;
  relativePath: string;
  sizeBytes: number;
  modifiedMs: number;
  revision: string | null;
  text: string | null;
  hasBom: boolean;
  lineEnding: ProjectTextLineEnding;
  skipReason: NativeProjectTextSkipReason | null;
  message: string | null;
};

type NativeProjectTextRevisionInfo = {
  path: string;
  relativePath: string;
  sizeBytes: number;
  modifiedMs: number;
  revision: string | null;
  skipReason: NativeProjectTextSkipReason | null;
  message: string | null;
};

export interface ProjectTextNativePort {
  inventory(args: {
    requestId: string;
    workspaceRootPath: string;
    includeIgnored: boolean;
  }): Promise<NativeProjectTextInventory>;
  read(args: {
    workspaceRootPath: string;
    path: string;
  }): Promise<NativeProjectTextReadResult>;
  revision(args: {
    workspaceRootPath: string;
    path: string;
  }): Promise<NativeProjectTextRevisionInfo>;
  relatedFiles(args: {
    workspaceRootPath: string;
    mainFilePath: string;
  }): Promise<string[]>;
  cancel(requestId: string): Promise<void>;
}

export interface ProjectTextServiceDependencies {
  workspaceRootPath(): string | null;
  openTabs(): readonly EditorTab[];
  markPlainTextPath?(path: string): void;
  native?: ProjectTextNativePort;
}

const tauriProjectTextNative: ProjectTextNativePort = {
  inventory: args => invoke<NativeProjectTextInventory>("project_text_inventory", args),
  read: args => invoke<NativeProjectTextReadResult>("project_text_read", args),
  revision: args => invoke<NativeProjectTextRevisionInfo>("project_text_revision", args),
  relatedFiles: args => invoke<string[]>("project_search_related_files", args),
  cancel: requestId => invoke("cancel_project_text_request", { requestId }).then(() => {}),
};

export class ProjectTextRequestCancelled extends Error {
  constructor() {
    super("Project text request was superseded.");
  }
}

/**
 * Shared source-of-truth for project text snapshots. Open editor buffers always
 * take precedence over disk, and every snapshot carries an opaque revision used
 * by search/replacement to reject stale work.
 */
export class ProjectTextService {
  private readonly inventoryRequests = new LatestRequestGuard<"inventory">();
  private activeInventoryRequestId: string | null = null;
  private requestCounter = 0;
  private inventoryCache: {
    key: string;
    inventory: ProjectTextInventory;
  } | null = null;
  private readonly invalidatedPaths = new Set<string>();

  constructor(private readonly deps: ProjectTextServiceDependencies) {}

  public get native(): ProjectTextNativePort {
    return this.deps.native ?? tauriProjectTextNative;
  }

  public fileInfo(path: string, sizeBytes = 0, modifiedMs = 0): ProjectTextFileInfo {
    return projectTextFileInfo(this.deps.workspaceRootPath(), path, sizeBytes, modifiedMs);
  }

  public async inventory(options: {
    includeIgnored?: boolean;
    refresh?: boolean;
  } = {}): Promise<ProjectTextInventory> {
    const rootPath = this.deps.workspaceRootPath();
    if (!rootPath) {
      return emptyInventory("");
    }
    const includeIgnored = options.includeIgnored === true;
    const cacheKey = `${filePathKey(rootPath)}\u0000${includeIgnored ? "ignored" : "tracked"}`;
    if (!options.refresh && this.inventoryCache?.key === cacheKey) {
      return this.inventoryCache.inventory;
    }

    const request = this.inventoryRequests.begin("inventory");
    const requestId = this.nextRequestId();
    await this.cancelActiveInventoryRequest();
    this.activeInventoryRequestId = requestId;
    try {
      const native = await this.native.inventory({
        requestId,
        workspaceRootPath: rootPath,
        includeIgnored,
      });
      if (!this.inventoryRequests.isCurrent(request) || this.deps.workspaceRootPath() !== rootPath) {
        throw new ProjectTextRequestCancelled();
      }
      if (native.cancelled) throw new ProjectTextRequestCancelled();
      const inventory: ProjectTextInventory = {
        workspaceRootPath: native.workspaceRootPath,
        includeIgnored: native.includeIgnored,
        files: native.files.map(file => ({
          path: file.path,
          relativePath: file.relativePath,
          identity: filePathKey(file.path),
          sizeBytes: file.sizeBytes,
          modifiedMs: file.modifiedMs,
        })),
        skipped: native.skipped.map(skipped => ({
          path: skipped.path,
          relativePath: skipped.relativePath,
          sizeBytes: skipped.sizeBytes,
          reason: skipped.reason,
          message: skipped.message,
        })),
        binaryFileCount: native.binaryFileCount,
        tooLargeFileCount: native.tooLargeFileCount,
        unreadableFileCount: native.unreadableFileCount,
      };
      for (const file of inventory.files) this.deps.markPlainTextPath?.(file.path);
      this.inventoryCache = { key: cacheKey, inventory };
      return inventory;
    } catch (error) {
      if (error instanceof ProjectTextRequestCancelled) throw error;
      if (!this.inventoryRequests.isCurrent(request)) throw new ProjectTextRequestCancelled();
      throw error;
    } finally {
      if (this.activeInventoryRequestId === requestId) this.activeInventoryRequestId = null;
    }
  }

  public cancel(): void {
    this.inventoryRequests.invalidate("inventory");
    void this.cancelActiveInventoryRequest();
  }

  /** Drop cached inventory after creates/deletes; path-level edits mark that file. */
  public invalidate(path?: string): void {
    if (path) {
      this.invalidatedPaths.add(filePathKey(path));
      return;
    }
    this.invalidatedPaths.clear();
    this.inventoryCache = null;
    this.cancel();
  }

  public takeInvalidated(path: string): boolean {
    return this.invalidatedPaths.delete(filePathKey(path));
  }

  public async snapshot(path: string): Promise<ProjectTextReadOutcome> {
    const buffer = this.bufferSnapshot(path);
    if (buffer) return { kind: "snapshot", snapshot: buffer };
    return this.readDisk(this.fileInfo(path));
  }

  public async readFiles(
    files: readonly ProjectTextFileInfo[],
    options: {
      concurrency?: number;
      signal?: AbortSignal;
    } = {},
  ): Promise<ProjectTextBatchResult> {
    const outcomes = new Array<ProjectTextReadOutcome | undefined>(files.length);
    const concurrency = Math.max(
      1,
      Math.min(options.concurrency ?? PROJECT_TEXT_MAX_CONCURRENT_READS, files.length || 1),
    );
    let cursor = 0;
    const worker = async () => {
      while (true) {
        if (options.signal?.aborted) return;
        const index = cursor++;
        if (index >= files.length) return;
        outcomes[index] = await this.readFile(files[index]);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, files.length) }, worker));
    const resolved = outcomes.filter((outcome): outcome is ProjectTextReadOutcome => !!outcome);
    return {
      outcomes: resolved,
      snapshots: resolved.flatMap(outcome => outcome.kind === "snapshot" ? [outcome.snapshot] : []),
      skipped: resolved.flatMap(outcome => outcome.kind === "skipped" ? [outcome.skipped] : []),
    };
  }

  public async relatedFiles(mainFilePath: string): Promise<string[]> {
    const rootPath = this.deps.workspaceRootPath();
    if (!rootPath) return [];
    return this.native.relatedFiles({ workspaceRootPath: rootPath, mainFilePath });
  }

  public async currentRevision(path: string): Promise<string | null> {
    const buffer = this.bufferSnapshot(path);
    if (buffer) return buffer.revision;
    const rootPath = this.deps.workspaceRootPath();
    if (!rootPath) return null;
    const result = await this.native.revision({ workspaceRootPath: rootPath, path });
    return result.revision;
  }

  public async isCurrent(snapshot: ProjectTextSnapshot): Promise<boolean> {
    if (snapshot.source === "buffer") {
      const tab = this.findTab(snapshot.file.path);
      return !!tab?.contentLoaded && tab.content === snapshot.text;
    }
    return await this.currentRevision(snapshot.file.path) === snapshot.revision;
  }

  private async readFile(file: ProjectTextFileInfo): Promise<ProjectTextReadOutcome> {
    const buffer = this.bufferSnapshot(file.path);
    if (buffer) return { kind: "snapshot", snapshot: buffer };
    return this.readDisk(file);
  }

  private async readDisk(file: ProjectTextFileInfo): Promise<ProjectTextReadOutcome> {
    const rootPath = this.deps.workspaceRootPath();
    if (!rootPath) return { kind: "skipped", skipped: cancelledSkip(file) };
    let result: NativeProjectTextReadResult;
    try {
      result = await this.native.read({ workspaceRootPath: rootPath, path: file.path });
    } catch (error) {
      return {
        kind: "skipped",
        skipped: {
          path: file.path,
          relativePath: file.relativePath,
          sizeBytes: file.sizeBytes,
          reason: "unreadable",
          message: `Could not read the file: ${String(error)}`,
        },
      };
    }
    if (result.text === null || result.revision === null) {
      return {
        kind: "skipped",
        skipped: {
          path: result.path,
          relativePath: result.relativePath,
          sizeBytes: result.sizeBytes,
          reason: result.skipReason ?? "unreadable",
          message: result.message ?? "The file could not be read as project text.",
        },
      };
    }
    this.deps.markPlainTextPath?.(result.path);
    return {
      kind: "snapshot",
      snapshot: {
        file: {
          path: result.path,
          relativePath: result.relativePath,
          identity: filePathKey(result.path),
          sizeBytes: result.sizeBytes,
          modifiedMs: result.modifiedMs,
        },
        text: result.text,
        revision: result.revision,
        source: "disk",
        dirty: false,
        version: null,
        hasBom: result.hasBom,
        lineEnding: result.lineEnding,
      },
    };
  }

  private bufferSnapshot(path: string): ProjectTextSnapshot | null {
    const tab = this.findTab(path);
    if (!tab?.contentLoaded) return null;
    return {
      file: this.fileInfo(tab.path, new TextEncoder().encode(tab.content).length),
      text: tab.content,
      revision: bufferRevision(tab),
      source: "buffer",
      dirty: tab.isDirty,
      version: tab.version,
      hasBom: tab.content.startsWith("\uFEFF"),
      lineEnding: textLineEnding(tab.content),
    };
  }

  private findTab(path: string): EditorTab | undefined {
    const key = filePathKey(path);
    return this.deps.openTabs().find(tab => filePathKey(tab.path) === key);
  }

  private nextRequestId(): string {
    this.requestCounter += 1;
    return `${Date.now().toString(36)}-${this.requestCounter.toString(36)}`;
  }

  private async cancelActiveInventoryRequest(): Promise<void> {
    const requestId = this.activeInventoryRequestId;
    this.activeInventoryRequestId = null;
    if (requestId) await this.native.cancel(requestId).catch(() => {});
  }
}

export function projectTextFileInfo(
  workspaceRootPath: string | null,
  path: string,
  sizeBytes = 0,
  modifiedMs = 0,
): ProjectTextFileInfo {
  return {
    path,
    relativePath: workspaceRootPath ? relativeFilePath(workspaceRootPath, path)?.replace(/\\/g, "/") ?? path : path,
    identity: filePathKey(path),
    sizeBytes,
    modifiedMs,
  };
}

export function bufferRevision(tab: Pick<EditorTab, "content" | "isDirty" | "version">): string {
  return `buffer:${tab.version}:${tab.isDirty ? "dirty" : "saved"}:${stableTextHash(tab.content)}`;
}

export function textRevisionToken(text: string): string {
  return `text:${text.length}:${stableTextHash(text)}`;
}

function stableTextHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function textLineEnding(text: string): ProjectTextLineEnding {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/\n/g) ?? []).length - crlf;
  const cr = (text.match(/\r/g) ?? []).length - crlf;
  const kinds = Number(lf > 0) + Number(crlf > 0) + Number(cr > 0);
  if (kinds === 0) return "none";
  if (kinds > 1) return "mixed";
  return crlf > 0 ? "crlf" : cr > 0 ? "cr" : "lf";
}

function emptyInventory(workspaceRootPath: string): ProjectTextInventory {
  return {
    workspaceRootPath,
    includeIgnored: false,
    files: [],
    skipped: [],
    binaryFileCount: 0,
    tooLargeFileCount: 0,
    unreadableFileCount: 0,
  };
}

function cancelledSkip(file: ProjectTextFileInfo): ProjectTextSkippedFile {
  return {
    path: file.path,
    relativePath: file.relativePath,
    sizeBytes: file.sizeBytes,
    reason: "cancelled",
    message: "The workspace closed before the file could be read.",
  };
}
