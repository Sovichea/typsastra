import { describe, expect, test } from "bun:test";
import {
  acceptedExternalChangePaths,
  excludeManagedWorkspacePaths,
  shouldSuppressWorkspaceSelfSave,
  workspaceChangeKind
} from "../src/workspace/workspaceWatcher";

describe("workspace watcher", () => {
  test("classifies structural and content changes", () => {
    expect(workspaceChangeKind({ create: { kind: "file" } })).toBe("create");
    expect(workspaceChangeKind({ remove: { kind: "folder" } })).toBe("remove");
    expect(workspaceChangeKind({ modify: { kind: "data", mode: "content" } })).toBe("modify");
    expect(workspaceChangeKind({ modify: { kind: "rename", mode: "both" } })).toBe("rename");
  });

  test("ignores access and unspecified events", () => {
    expect(workspaceChangeKind({ access: { kind: "open", mode: "read" } })).toBeNull();
    expect(workspaceChangeKind("other")).toBeNull();
    expect(workspaceChangeKind("any")).toBeNull();
  });

  test("suppresses only matching self-save notifications", () => {
    const openPaths = new Set(["c:/project/main.typ"]);
    expect(shouldSuppressWorkspaceSelfSave(
      false,
      ["c:/project/main.typ"],
      openPaths
    )).toBeTrue();
    expect(shouldSuppressWorkspaceSelfSave(
      true,
      ["c:/project/main.typ"],
      openPaths
    )).toBeFalse();
    expect(shouldSuppressWorkspaceSelfSave(
      false,
      ["c:/project/image.png"],
      openPaths
    )).toBeFalse();
  });

  test("keeps conflicted dirty files out of external preview propagation", () => {
    const paths = ["C:\\Project\\main.typ", "C:\\Project\\image.png"];
    const key = (path: string) => path.replace(/\\/g, "/").toLowerCase();
    const conflicts = new Set([key(paths[0])]);
    expect(acceptedExternalChangePaths(paths, key, conflicts)).toEqual([
      "C:\\Project\\image.png"
    ]);
  });

  test("excludes application-managed preview outputs from workspace changes", () => {
    const paths = [
      "C:\\Project\\main.pdf",
      "C:\\Project\\figure.png",
      "C:\\Project\\chapter.typ"
    ];
    const key = (path: string) => path.replace(/\\/g, "/").toLowerCase();
    const managed = new Set([key(paths[0])]);
    expect(excludeManagedWorkspacePaths(paths, key, managed)).toEqual([
      "C:\\Project\\figure.png",
      "C:\\Project\\chapter.typ"
    ]);
  });
});
