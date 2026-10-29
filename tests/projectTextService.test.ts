import { describe, expect, test } from "bun:test";
import type { EditorTab } from "../src/editor/editorTab";
import type { ProjectTextNativePort } from "../src/workspace/projectTextService";
import {
  bufferRevision,
  ProjectTextRequestCancelled,
  ProjectTextService,
  textRevisionToken,
} from "../src/workspace/projectTextService";

const root = String.raw`C:\project`;
const mainPath = String.raw`C:\project\main.typ`;

function tab(overrides: Partial<EditorTab> = {}): EditorTab {
  return {
    path: mainPath,
    content: "#let value = (",
    savedContent: "#let value = (",
    contentLoaded: true,
    isDirty: true,
    version: 7,
    ...overrides,
  } as EditorTab;
}

function file(path: string, relativePath: string, sizeBytes = 12) {
  return {
    path,
    relativePath,
    sizeBytes,
    modifiedMs: 1,
  };
}

function nativeInventory(
  args: { workspaceRootPath: string; includeIgnored: boolean },
  files = [
    {
      ...file(mainPath, "main.typ"),
    },
    {
      ...file(String.raw`C:\project\notes.txt`, "notes.txt", 5),
    },
  ],
) {
  return {
    workspaceRootPath: args.workspaceRootPath,
    includeIgnored: args.includeIgnored,
    files,
    skipped: [{
      path: String.raw`C:\project\large.txt`,
      relativePath: "large.txt",
      sizeBytes: 11 * 1024 * 1024,
      reason: "tooLarge" as const,
      message: "Skipped because it is larger than 10 MiB.",
    }],
    binaryFileCount: 2,
    tooLargeFileCount: 1,
    unreadableFileCount: 0,
    cancelled: false,
  };
}

function nativeRead(path: string, text = "disk text", revision = "disk-revision") {
  return {
    path,
    relativePath: path.split(/[\\/]/).pop() ?? path,
    sizeBytes: text.length,
    modifiedMs: 1,
    revision,
    text,
    hasBom: false,
    lineEnding: "lf" as const,
    skipReason: null,
    message: null,
  };
}

function service(
  openTabs: readonly EditorTab[],
  native: ProjectTextNativePort,
  marked: string[] = [],
) {
  return new ProjectTextService({
    workspaceRootPath: () => root,
    openTabs: () => openTabs,
    markPlainTextPath: path => marked.push(path),
    native,
  });
}

describe("project text service", () => {
  test("prefers an open editor buffer over disk", async () => {
    let diskReads = 0;
    const controller = service([tab()], {
      inventory: async args => nativeInventory(args),
      read: async args => {
        diskReads += 1;
        return nativeRead(args.path);
      },
      revision: async args => ({
        ...file(args.path, "main.typ"),
        revision: "disk-revision",
        skipReason: null,
        message: null,
      }),
      relatedFiles: async () => [],
      cancel: async () => {},
    });

    const outcome = await controller.snapshot(mainPath);
    expect(outcome.kind).toBe("snapshot");
    if (outcome.kind !== "snapshot") return;
    expect(outcome.snapshot.source).toBe("buffer");
    expect(outcome.snapshot.text).toBe("#let value = (");
    expect(outcome.snapshot.dirty).toBe(true);
    expect(outcome.snapshot.revision).toBe(bufferRevision(tab()));
    expect(diskReads).toBe(0);
  });

  test("limits native reads to four concurrent files", async () => {
    let active = 0;
    let peak = 0;
    const native: ProjectTextNativePort = {
      inventory: async args => nativeInventory(args),
      read: async args => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise(resolve => setTimeout(resolve, 2));
        active -= 1;
        return nativeRead(args.path, args.path);
      },
      revision: async args => ({
        ...file(args.path, "file.txt"),
        revision: "revision",
        skipReason: null,
        message: null,
      }),
      relatedFiles: async () => [],
      cancel: async () => {},
    };
    const controller = service([], native);
    const files = Array.from({ length: 12 }, (_, index) =>
      controller.fileInfo(String.raw`C:\project\file-${index}.txt`, 4)
    );

    const result = await controller.readFiles(files);
    expect(result.snapshots).toHaveLength(12);
    expect(peak).toBe(4);
  });

  test("reports one unreadable file without aborting the batch", async () => {
    const controller = service([], {
      inventory: async args => nativeInventory(args),
      read: async () => {
        throw new Error("permission denied");
      },
      revision: async args => ({
        ...file(args.path, "main.typ"),
        revision: "revision",
        skipReason: null,
        message: null,
      }),
      relatedFiles: async () => [],
      cancel: async () => {},
    });
    const result = await controller.readFiles([
      controller.fileInfo(mainPath),
      controller.fileInfo(String.raw`C:\project\notes.txt`),
    ]);
    expect(result.snapshots).toHaveLength(0);
    expect(result.skipped).toHaveLength(2);
    expect(result.skipped.every(entry => entry.reason === "unreadable")).toBe(true);
    expect(result.skipped[0].message).toContain("permission denied");
  });

  test("maps inventory skips, caches it, and refreshes after invalidation", async () => {
    let calls = 0;
    const marked: string[] = [];
    const controller = service([], {
      inventory: async args => {
        calls += 1;
        return nativeInventory(args);
      },
      read: async args => nativeRead(args.path),
      revision: async args => ({
        ...file(args.path, "main.typ"),
        revision: "revision",
        skipReason: null,
        message: null,
      }),
      relatedFiles: async () => [],
      cancel: async () => {},
    }, marked);

    const first = await controller.inventory();
    expect(first.files.map(entry => entry.relativePath)).toEqual(["main.typ", "notes.txt"]);
    expect(first.files[0].identity).toBe("c:/project/main.typ");
    expect(first.skipped[0].reason).toBe("tooLarge");
    expect(first.binaryFileCount).toBe(2);
    expect(marked).toEqual([mainPath, String.raw`C:\project\notes.txt`]);
    expect(calls).toBe(1);

    await controller.inventory();
    expect(calls).toBe(1);

    controller.invalidate();
    await controller.inventory();
    expect(calls).toBe(2);
  });

  test("discards a superseded inventory request", async () => {
    let firstStarted!: () => void;
    const started = new Promise<void>(resolve => {
      firstStarted = resolve;
    });
    let firstResolve!: () => void;
    let calls = 0;
    const controller = service([], {
      inventory: args => {
        calls += 1;
        if (calls === 1) {
          firstStarted();
          return new Promise(resolve => {
            firstResolve = () => resolve(nativeInventory(args));
          });
        }
        return Promise.resolve(nativeInventory(args));
      },
      read: async args => nativeRead(args.path),
      revision: async args => ({
        ...file(args.path, "main.typ"),
        revision: "revision",
        skipReason: null,
        message: null,
      }),
      relatedFiles: async () => [],
      cancel: async () => {},
    });

    const stale = controller.inventory();
    await started;
    const current = await controller.inventory({ refresh: true });
    firstResolve();
    await expect(stale).rejects.toBeInstanceOf(ProjectTextRequestCancelled);
    expect(current.files).toHaveLength(2);
  });

  test("validates disk revisions against the native revision token", async () => {
    const controller = service([], {
      inventory: async args => nativeInventory(args),
      read: async args => nativeRead(args.path),
      revision: async args => ({
        ...file(args.path, "main.typ"),
        revision: "disk-revision",
        skipReason: null,
        message: null,
      }),
      relatedFiles: async () => [],
      cancel: async () => {},
    });

    const outcome = await controller.snapshot(mainPath);
    expect(outcome.kind).toBe("snapshot");
    if (outcome.kind !== "snapshot") return;
    expect(await controller.isCurrent(outcome.snapshot)).toBe(true);
    expect(await controller.currentRevision(mainPath)).toBe("disk-revision");
  });

  test("delegates main-document related files to the native port", async () => {
    let request: { workspaceRootPath: string; mainFilePath: string } | null = null;
    const controller = service([], {
      inventory: async args => nativeInventory(args),
      read: async args => nativeRead(args.path),
      revision: async args => ({
        ...file(args.path, "main.typ"),
        revision: "disk-revision",
        skipReason: null,
        message: null,
      }),
      relatedFiles: async args => {
        request = args;
        return [mainPath, String.raw`C:\project\chapter.typ`];
      },
      cancel: async () => {},
    });

    expect(await controller.relatedFiles(mainPath)).toEqual([
      mainPath,
      String.raw`C:\project\chapter.typ`,
    ]);
    expect(request).toEqual({ workspaceRootPath: root, mainFilePath: mainPath });
  });

  test("exposes stable text revision tokens", () => {
    expect(textRevisionToken("same")).toBe(textRevisionToken("same"));
    expect(textRevisionToken("same")).not.toBe(textRevisionToken("different"));
  });
});
