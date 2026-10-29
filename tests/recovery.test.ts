import { describe, expect, test } from "bun:test";
import type { EditorTab } from "../src/editor/editorTab";
import { createUntitledTab } from "../src/editor/untitledDocument";
import {
  canRecoverTab,
  recoveryDocumentId,
  recoveryDocumentIdForTab,
  sha256Hex,
  untitledIdFromRecoveryDocumentId,
} from "../src/recovery/recoveryIdentity";

function tab(path: string, overrides: Partial<EditorTab> = {}): EditorTab {
  return {
    path,
    content: "",
    savedContent: "",
    contentLoaded: true,
    isDirty: true,
    previewRootPath: null,
    previewMainPath: null,
    previewTaskId: null,
    previewSessionKey: null,
    previewImported: false,
    previewStandalone: true,
    previewDisabled: false,
    version: 1,
    latestVersion: 1,
    selectionAnchor: 0,
    selectionHead: 0,
    foldRanges: [],
    foldStateExplicit: false,
    ...overrides,
  };
}

describe("recovery snapshots", () => {
  test("uses a stable workspace and path identity", () => {
    expect(recoveryDocumentId("C:\\Project", "C:\\Project\\Main.typ"))
      .toBe(recoveryDocumentId("c:/project", "c:/project/main.typ"));
    expect(recoveryDocumentId("C:/project", "C:/project/main.typ"))
      .not.toBe(recoveryDocumentId("C:/other", "C:/other/main.typ"));
    expect(recoveryDocumentId(null, "C:/standalone/file.typ"))
      .toContain("standalone");
  });

  test("protects supported text documents but not images, PDFs, or unloaded tabs", () => {
    expect(canRecoverTab(tab("C:/project/main.typ"))).toBe(true);
    expect(canRecoverTab(tab("C:/project/notes.md"))).toBe(true);
    expect(canRecoverTab(tab("C:/project/photo.png"))).toBe(false);
    expect(canRecoverTab(tab("C:/project/export.pdf"))).toBe(false);
    expect(canRecoverTab(tab("C:/project/main.typ", { contentLoaded: false }))).toBe(false);
    expect(canRecoverTab(tab(""))).toBe(false);
  });

  test("recovers pathless untitled buffers with a stable identity", () => {
    const untitled = createUntitledTab({ id: "draft-1", title: "Untitled 1" });
    expect(canRecoverTab(untitled)).toBe(true);
    expect(recoveryDocumentIdForTab("C:/project", untitled)).toBe("untitled:draft-1");
    expect(untitledIdFromRecoveryDocumentId("untitled:draft-1")).toBe("draft-1");
    expect(untitledIdFromRecoveryDocumentId(recoveryDocumentId("C:/project", "C:/project/main.typ")))
      .toBeNull();
  });

  test("hashes the saved baseline with SHA-256", async () => {
    expect(await sha256Hex("abc"))
      .toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  test("exposes versioned native list, read, write, and delete operations", async () => {
    const rust = await Bun.file(
      new URL("../src-tauri/src/recovery.rs", import.meta.url),
    ).text();
    const lib = await Bun.file(
      new URL("../src-tauri/src/lib.rs", import.meta.url),
    ).text();

    expect(rust).toContain("pub const RECOVERY_RECORD_VERSION");
    expect(rust).toContain("pub const RECOVERY_STORAGE_LIMIT_BYTES");
    expect(rust).toContain("NamedTempFile::new_in");
    expect(rust).toContain("stale-revision");
    expect(rust).toContain("quota-exceeded");
    expect(lib).toContain("list_recovery_records");
    expect(lib).toContain("read_recovery_record");
    expect(lib).toContain("write_recovery_record");
    expect(lib).toContain("delete_recovery_record");
    expect(lib).toContain("delete_corrupt_recovery_record");
  });

  test("wires snapshots, save resolution, and review into the application", async () => {
    const app = await Bun.file(
      new URL("../src/appController.ts", import.meta.url),
    ).text();
    const html = await Bun.file(new URL("../index.html", import.meta.url)).text();
    const review = await Bun.file(
      new URL("../src/recovery/recoveryReviewController.ts", import.meta.url),
    ).text();
    const styles = await Bun.file(new URL("../src/style.css", import.meta.url)).text();
    const persistence = await Bun.file(
      new URL("../src/editor/documentPersistenceController.ts", import.meta.url),
    ).text();

    expect(app).toContain("new RecoveryController({");
    expect(app).toContain("new RecoveryReviewController({");
    expect(app).toContain("this.recoveryController.noteActiveDocumentChanged()");
    expect(app).toContain("this.recoveryController.flushTab(tab)");
    expect(app).toContain("recoveryRevision: tab => this.recoveryController.recoveryRevision(tab)");
    expect(app).toContain("recoverySaved: (tab, revision) => this.recoveryController.handleTabSaved(tab, revision)");
    expect(app).toContain("discardRecoverySnapshot: tab => this.recoveryController.discardTab(tab)");
    expect(app).toContain("private async restoreRecoveryRecord(");
    expect(app).toContain("tab.recoveredUnsaved = true");
    expect(app).toContain("untitledIdFromRecoveryDocumentId(record.documentId)");
    expect(app).toContain("private async createUntitledFile(");
    expect(app).toContain("private async saveUntitledDocumentAs(");
    expect(app).toContain("this.recoveryReviewAutoShowReady = true");
    expect(app).toContain("showIfNeeded({ workspaceRoot: selected })");
    expect(app).not.toContain('"review recovery snapshots"');
    expect(review).toContain("workspaceScoped");
    expect(persistence).toContain("!tab.recoveredUnsaved");
    expect(persistence).toContain("recoveryRevision = this.deps.recoveryRevision(tab)");

    expect(html).toContain('id="recovery-overlay"');
    expect(html).toContain('id="recovery-list"');
    expect(html).toContain('id="recovery-review"');
    expect(html).not.toContain('id="action-recovery-review"');
    expect(review).toContain("if (text === record.text)");
    expect(review).toContain('changed ? "changed" : "unchanged"');
    expect(review).toContain("untitledIdFromRecoveryDocumentId");
    expect(review).toContain("Untitled buffer with unsaved text");
    expect(review).toContain("createUnifiedTextDiff");
    expect(review).toContain("private renderDiff(");
    expect(html).toContain("Restore Unsaved Copy");
    expect(html).toContain('id="recovery-diff"');
    expect(html).not.toContain('id="recovery-recovered-text"');
    expect(styles).toContain(".recovery-dialog");
    expect(styles).toContain(".recovery-diff-added");
    expect(styles).toContain(".recovery-diff-removed");
    expect(styles).toContain(".recovery-diff-word-changed");
  });
});
