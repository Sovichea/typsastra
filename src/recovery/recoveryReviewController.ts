import { fileNameFromPath, filePathKey } from "../platform/paths";
import type {
  RecoveryController,
  RecoveryCorruptRecord,
  RecoveryRecord,
  RecoveryRecordSummary,
} from "./recoveryController";
import { sha256Hex, untitledIdFromRecoveryDocumentId } from "./recoveryIdentity";
import {
  createUnifiedTextDiff,
  splitDiffHunk,
  type TextDiffSide,
} from "./textDiff";
import { t } from "../i18n";

type RecoveryReviewStatus = "unchanged" | "changed" | "missing" | "untitled" | "error";

type RecoveryReviewRow = {
  documentId: string;
  revision: number;
  path: string | null;
  untitled: boolean;
  title: string;
  timestampMs: number;
  bytes: number;
  status: RecoveryReviewStatus;
  message: string;
  record: RecoveryRecord | null;
  diskText: string | null;
};

type CorruptRow = RecoveryCorruptRecord;

type RecoveryReviewDependencies = {
  recovery(): RecoveryController;
  pathExists(path: string): Promise<boolean>;
  readText(path: string): Promise<string>;
  restoreRecord(record: RecoveryRecord): Promise<boolean>;
  logWarning(message: string): void;
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function formatTimestamp(timestampMs: number): string {
  return new Date(timestampMs).toLocaleString();
}

/** Owns the recovery list, unified diff view, and restore/discard actions. */
export class RecoveryReviewController {
  private readonly overlay = document.getElementById("recovery-overlay")!;
  private readonly list = document.getElementById("recovery-list")!;
  private readonly empty = document.getElementById("recovery-empty")!;
  private readonly usage = document.getElementById("recovery-usage")!;
  private readonly review = document.getElementById("recovery-review")!;
  private readonly reviewTitle = document.getElementById("recovery-review-title")!;
  private readonly reviewStatus = document.getElementById("recovery-review-status")!;
  private readonly diff = document.getElementById("recovery-diff")!;
  private readonly diffNote = document.getElementById("recovery-diff-note")!;
  private rows: RecoveryReviewRow[] = [];
  private corruptRows: CorruptRow[] = [];
  private selectedRow: RecoveryReviewRow | null = null;
  private showing = false;

  constructor(private readonly deps: RecoveryReviewDependencies) {}

  public initialize(): void {
    document.getElementById("recovery-close")?.addEventListener("click", () => this.hide());
    document.getElementById("recovery-dismiss")?.addEventListener("click", () => this.hide());
    document.getElementById("recovery-review-back")?.addEventListener("click", () => this.closeReview());
    document.getElementById("recovery-review-discard")?.addEventListener("click", () => {
      if (this.selectedRow) void this.discardRow(this.selectedRow);
    });
    document.getElementById("recovery-review-restore")?.addEventListener("click", () => {
      if (this.selectedRow) void this.restoreRow(this.selectedRow);
    });
    this.overlay.addEventListener("click", event => {
      if (event.target === this.overlay) this.hide();
    });
    document.addEventListener("keydown", event => {
      if (event.key !== "Escape" || this.overlay.classList.contains("hidden")) return;
      if (!this.review.classList.contains("hidden")) this.closeReview();
      else this.hide();
    });
  }

  public async showIfNeeded(options: { workspaceRoot?: string | null } = {}): Promise<boolean> {
    if (this.showing) return false;
    this.showing = true;
    try {
      const listing = await this.deps.recovery().refreshListing();
      const workspaceScoped = Object.prototype.hasOwnProperty.call(options, "workspaceRoot");
      const records = workspaceScoped
        ? listing.records.filter(record => options.workspaceRoot === null
          ? record.workspaceRoot === null
          : !!record.workspaceRoot
            && !!options.workspaceRoot
            && filePathKey(record.workspaceRoot) === filePathKey(options.workspaceRoot))
        : listing.records;
      if (records.length === 0 && (workspaceScoped || listing.corrupt.length === 0)) return false;
      await this.scanRecords(records);
      const refreshed = await this.deps.recovery().refreshListing();
      this.corruptRows = workspaceScoped ? [] : refreshed.corrupt;
      if (this.rows.length === 0 && this.corruptRows.length === 0) {
        this.hide();
        return false;
      }
      this.overlay.classList.remove("hidden");
      this.review.classList.add("hidden");
      this.render();
      this.list.querySelector<HTMLButtonElement>("button")?.focus();
      return true;
    } catch (error) {
      this.deps.logWarning(`Could not review recovery snapshots: ${String(error)}`);
      return false;
    } finally {
      this.showing = false;
    }
  }

  private async scanRecords(summaries: readonly RecoveryRecordSummary[]): Promise<void> {
    const rows: RecoveryReviewRow[] = [];
    for (const summary of summaries) {
      let record: RecoveryRecord | null = null;
      try {
        record = await this.deps.recovery().readRecord(summary.documentId);
      } catch (error) {
        rows.push({
          documentId: summary.documentId,
          revision: summary.revision,
          path: summary.path,
          untitled: untitledIdFromRecoveryDocumentId(summary.documentId) !== null,
          title: summary.title?.trim()
            || (summary.path ? fileNameFromPath(summary.path) : "Recovery record"),
          timestampMs: summary.timestampMs,
          bytes: summary.bytes,
          status: "error",
          message: `Could not read this snapshot: ${String(error)}`,
          record: null,
          diskText: null,
        });
        continue;
      }
      if (!record) continue;
      const path = record.path;
      if (!path) {
        if (untitledIdFromRecoveryDocumentId(record.documentId)) {
          rows.push(this.rowFrom(
            record,
            summary.bytes,
            "untitled",
            "Untitled buffer with unsaved text. Restore it as an unsaved tab and use Save As.",
            null,
          ));
        } else {
          rows.push(this.rowFrom(record, summary.bytes, "missing", "This snapshot has no file path.", null));
        }
        continue;
      }
      if (!await this.deps.pathExists(path).catch(() => false)) {
        rows.push(this.rowFrom(
          record,
          summary.bytes,
          "missing",
          "The file no longer exists. Restore it as an unsaved buffer and use Save As.",
          null,
        ));
        continue;
      }
      let text = "";
      try {
        text = await this.deps.readText(path);
      } catch (error) {
        rows.push(this.rowFrom(record, summary.bytes, "error", `Could not read the file on disk: ${String(error)}`, null));
        continue;
      }
      if (text === record.text) {
        try {
          const result = await this.deps.recovery().discardRecord(record.documentId, record.revision);
          if (result.deleted || result.reason === "missing") continue;
          rows.push(this.rowFrom(
            record,
            summary.bytes,
            "error",
            `The disk file already matches this snapshot, but a newer recovery revision was kept.`,
            text,
          ));
          continue;
        } catch (error) {
          rows.push(this.rowFrom(
            record,
            summary.bytes,
            "error",
            `The disk file already matches this snapshot, but the record could not be cleared: ${String(error)}`,
            text,
          ));
          continue;
        }
      }
      const changed = await sha256Hex(text) !== record.savedTextHash;
      rows.push(this.rowFrom(
        record,
        summary.bytes,
        changed ? "changed" : "unchanged",
        changed
          ? "The file changed on disk since it was saved. Review the differences before restoring."
          : "The file on disk still matches its saved baseline.",
        text,
      ));
    }
    this.rows = rows;
  }

  private rowFrom(
    record: RecoveryRecord,
    bytes: number,
    status: RecoveryReviewStatus,
    message: string,
    diskText: string | null,
  ): RecoveryReviewRow {
    const untitled = untitledIdFromRecoveryDocumentId(record.documentId) !== null;
    return {
      documentId: record.documentId,
      revision: record.revision,
      path: record.path,
      untitled,
      title: record.title?.trim()
        || (record.path ? fileNameFromPath(record.path) : untitled ? "Untitled" : "Recovery record"),
      timestampMs: record.timestampMs,
      bytes,
      status,
      message,
      record,
      diskText,
    };
  }

  private render(): void {
    const listing = this.deps.recovery().currentListing();
    this.usage.textContent = t`${formatBytes(listing.totalBytes)} of ${formatBytes(listing.limitBytes)} recovery storage used.`;
    this.usage.classList.toggle("warning", listing.totalBytes > listing.limitBytes * 0.8);
    this.list.replaceChildren(
      ...this.rows.map(row => this.renderRow(row)),
      ...this.corruptRows.map(row => this.renderCorruptRow(row)),
    );
    this.empty.classList.toggle("hidden", this.rows.length + this.corruptRows.length > 0);
  }

  private renderRow(row: RecoveryReviewRow): HTMLElement {
    const element = document.createElement("div");
    element.className = "recovery-row";
    element.dataset.recoveryId = row.documentId;
    const main = document.createElement("div");
    main.className = "recovery-row-main";
    const title = document.createElement("div");
    title.className = "recovery-row-title";
    title.textContent = row.title;
    const badge = document.createElement("span");
    badge.className = `recovery-status recovery-status-${row.status}`;
    badge.textContent = row.status === "unchanged" ? t("unchanged on disk")
      : row.status === "changed" ? t("disk changed")
      : row.status === "missing" ? t("file missing")
      : row.status === "untitled" ? t("untitled buffer")
      : t("needs attention");
    title.appendChild(badge);
    const meta = document.createElement("div");
    meta.className = "recovery-row-meta";
    meta.textContent = t`${row.untitled ? t("Untitled buffer") : row.path ?? t("No path")} · ${formatTimestamp(row.timestampMs)} · ${formatBytes(row.bytes)}`;
    const status = document.createElement("div");
    status.className = "recovery-row-status";
    status.textContent = row.message;
    main.append(title, meta, status);

    const actions = document.createElement("div");
    actions.className = "recovery-row-actions";
    const review = this.actionButton("Review", () => void this.openReview(row));
    const restore = this.actionButton("Restore", () => {
      if (row.status === "changed") void this.openReview(row);
      else void this.restoreRow(row);
    }, "settings-primary");
    restore.disabled = row.record === null || (!row.path && !row.untitled);
    const discard = this.actionButton("Discard", () => void this.discardRow(row), "settings-danger-button");
    actions.append(review, restore, discard);
    element.append(main, actions);
    return element;
  }

  private renderCorruptRow(row: CorruptRow): HTMLElement {
    const element = document.createElement("div");
    element.className = "recovery-row recovery-row-corrupt";
    const main = document.createElement("div");
    main.className = "recovery-row-main";
    const title = document.createElement("div");
    title.className = "recovery-row-title";
    title.textContent = row.fileName;
    const badge = document.createElement("span");
    badge.className = "recovery-status recovery-status-error";
    badge.textContent = t("corrupt record");
    title.appendChild(badge);
    const status = document.createElement("div");
    status.className = "recovery-row-status";
    status.textContent = t`${row.error} · ${formatBytes(row.bytes)}`;
    main.append(title, status);
    const actions = document.createElement("div");
    actions.className = "recovery-row-actions";
    actions.append(this.actionButton("Discard", () => void this.discardCorrupt(row), "settings-danger-button"));
    element.append(main, actions);
    return element;
  }

  private actionButton(label: string, action: () => void, className = ""): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `settings-secondary-button ${className}`.trim();
    button.textContent = t(label);
    button.addEventListener("click", action);
    return button;
  }

  private async openReview(row: RecoveryReviewRow): Promise<void> {
    if (!row.record) return;
    this.selectedRow = row;
    this.reviewTitle.textContent = row.title;
    this.reviewStatus.textContent = row.message;
    this.renderDiff(row, row.record.text);
    this.list.classList.add("hidden");
    this.empty.classList.add("hidden");
    this.review.classList.remove("hidden");
    const restore = document.getElementById("recovery-review-restore") as HTMLButtonElement | null;
    if (restore) restore.disabled = !row.path && !row.untitled;
    document.getElementById("recovery-review-back")?.focus();
  }

  private renderDiff(row: RecoveryReviewRow, recoveredText: string): void {
    this.diff.replaceChildren();
    this.diffNote.classList.add("hidden");
    this.diffNote.textContent = "";
    if (row.untitled) {
      this.setDiffNote(
        "Untitled buffers have no disk revision. Restore the complete unsaved text, then use Save As to choose a file path.",
      );
      return;
    }
    if (row.diskText === null) {
      this.setDiffNote(
        "The file no longer exists, so there is no disk revision to compare. Restore to recover the full unsaved text.",
      );
      return;
    }
    const diff = createUnifiedTextDiff(row.diskText, recoveredText, {
      context: 3,
      maxLines: 3_000,
    });
    if (diff.hunks.length === 0) {
      this.setDiffNote(diff.lineEndingOnly
        ? "The recovered text differs only in line endings."
        : "No textual differences were found.");
      return;
    }
    const fragment = document.createDocumentFragment();
    for (const hunk of diff.hunks) {
      const header = document.createElement("div");
      header.className = "recovery-diff-hunk";
      header.textContent = hunk.header;
      fragment.appendChild(header);
      for (const row of splitDiffHunk(hunk)) {
        const element = document.createElement("div");
        element.className = "recovery-diff-row";
        element.append(
          this.renderDiffSide(row.old, "old", row.type),
          this.renderDiffSide(row.new, "new", row.type),
        );
        fragment.appendChild(element);
      }
    }
    this.diff.appendChild(fragment);
    if (diff.truncated) {
      this.setDiffNote(
        `Diff truncated to ${diff.shownLines} of ${diff.totalLines} changed/context lines. Restore still applies the complete recovered text.`,
      );
    }
  }

  private renderDiffSide(
    side: TextDiffSide,
    kind: "old" | "new",
    rowType: "context" | "change",
  ): HTMLElement {
    const cell = document.createElement("div");
    const state = rowType === "context"
      ? "context"
      : !side.line
        ? "empty"
        : kind === "old" ? "removed" : "added";
    cell.className = `recovery-diff-side recovery-diff-side-${kind} recovery-diff-${state}`;
    const number = document.createElement("span");
    number.className = "recovery-diff-line-number";
    number.textContent = side.line === null ? "" : String(side.line);
    number.setAttribute("aria-hidden", "true");
    const sign = document.createElement("span");
    sign.className = "recovery-diff-sign";
    sign.textContent = rowType === "context" || !side.line ? " " : kind === "old" ? "-" : "+";
    sign.setAttribute("aria-hidden", "true");
    const content = document.createElement("span");
    content.className = "recovery-diff-content";
    if (side.segments.length === 0) {
      content.textContent = " ";
    } else {
      for (const segment of side.segments) {
        const span = document.createElement("span");
        if (segment.changed) span.className = "recovery-diff-word-changed";
        span.textContent = segment.text;
        content.appendChild(span);
      }
    }
    cell.append(number, sign, content);
    return cell;
  }

  private setDiffNote(message: string): void {
    this.diffNote.textContent = message;
    this.diffNote.classList.remove("hidden");
  }

  private closeReview(): void {
    this.selectedRow = null;
    this.review.classList.add("hidden");
    this.list.classList.remove("hidden");
    this.empty.classList.toggle("hidden", this.rows.length + this.corruptRows.length > 0);
  }

  private async restoreRow(row: RecoveryReviewRow): Promise<void> {
    if (!row.record) return;
    const restored = await this.deps.restoreRecord(row.record);
    if (!restored) return;
    this.rows = this.rows.filter(candidate => candidate.documentId !== row.documentId);
    this.closeReview();
    this.render();
    if (this.rows.length === 0 && this.corruptRows.length === 0) this.hide();
  }

  private async discardRow(row: RecoveryReviewRow): Promise<void> {
    try {
      const result = await this.deps.recovery().discardRecord(row.documentId, row.revision);
      if (!result.deleted && result.reason === "newer-revision") {
        this.deps.logWarning(
          `${row.title} has a newer recovery snapshot. Reopen recovery review to see the latest revision.`,
        );
        await this.showIfNeeded();
        return;
      }
      this.rows = this.rows.filter(candidate => candidate.documentId !== row.documentId);
      const listing = await this.deps.recovery().refreshListing();
      this.corruptRows = listing.corrupt;
      if (this.selectedRow?.documentId === row.documentId) this.closeReview();
      this.render();
      if (this.rows.length === 0 && this.corruptRows.length === 0) this.hide();
    } catch (error) {
      this.deps.logWarning(`Could not discard ${row.title} from recovery storage: ${String(error)}`);
    }
  }

  private async discardCorrupt(row: CorruptRow): Promise<void> {
    try {
      await this.deps.recovery().deleteCorruptRecord(row.fileName);
      this.corruptRows = this.corruptRows.filter(candidate => candidate.fileName !== row.fileName);
      this.render();
      if (this.rows.length === 0 && this.corruptRows.length === 0) this.hide();
    } catch (error) {
      this.deps.logWarning(`Could not discard corrupt recovery record ${row.fileName}: ${String(error)}`);
    }
  }

  private hide(): void {
    this.overlay.classList.add("hidden");
    this.review.classList.add("hidden");
    this.list.classList.remove("hidden");
    this.selectedRow = null;
  }
}
