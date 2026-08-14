import type { PreviewDocumentPosition } from "../compiler/lsp";
import { filePathKey } from "../platform/paths";

/** A deliberately coarse, persistent source-to-PDF anchor for low-memory mode. */
export interface LowMemorySyncAnchor {
  fileId: number;
  /** Zero-based source line. */
  line: number;
  /** One-based PDF page. */
  pageNo: number;
  x: number;
  y: number;
}

export interface LowMemorySyncIndex {
  version: 1;
  rootFile: string;
  generationId: string;
  pdfHash: string;
  tinymistVersion?: string;
  files: string[];
  anchors: LowMemorySyncAnchor[];
}

export type IndexedSourceLocation = LowMemorySyncAnchor & { path: string };

function validAnchor(anchor: LowMemorySyncAnchor, files: readonly string[]): boolean {
  return Number.isInteger(anchor.fileId)
    && anchor.fileId >= 0
    && anchor.fileId < files.length
    && Number.isInteger(anchor.line)
    && anchor.line >= 0
    && Number.isInteger(anchor.pageNo)
    && anchor.pageNo > 0
    && Number.isFinite(anchor.x)
    && Number.isFinite(anchor.y);
}

export function validateLowMemorySyncIndex(value: unknown): value is LowMemorySyncIndex {
  if (!value || typeof value !== "object") return false;
  const index = value as Partial<LowMemorySyncIndex>;
  return index.version === 1
    && typeof index.rootFile === "string"
    && typeof index.generationId === "string"
    && typeof index.pdfHash === "string"
    && Array.isArray(index.files)
    && index.files.every(path => typeof path === "string")
    && Array.isArray(index.anchors)
    && index.anchors.every(anchor => validAnchor(anchor, index.files!));
}

function nearestByLine(anchors: readonly LowMemorySyncAnchor[], line: number): LowMemorySyncAnchor | null {
  if (!anchors.length) return null;
  let low = 0;
  let high = anchors.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (anchors[middle].line <= line) low = middle + 1;
    else high = middle;
  }
  const previous = anchors[Math.max(0, low - 1)];
  const next = anchors[Math.min(anchors.length - 1, low)];
  return Math.abs(previous.line - line) <= Math.abs(next.line - line) ? previous : next;
}

function nearestByY(anchors: readonly LowMemorySyncAnchor[], y: number): LowMemorySyncAnchor | null {
  if (!anchors.length) return null;
  let low = 0;
  let high = anchors.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (anchors[middle].y <= y) low = middle + 1;
    else high = middle;
  }
  const previous = anchors[Math.max(0, low - 1)];
  const next = anchors[Math.min(anchors.length - 1, low)];
  return Math.abs(previous.y - y) <= Math.abs(next.y - y) ? previous : next;
}

/**
 * Runtime lookup views. The persisted representation intentionally remains JSON
 * so a corrupt/stale cache can be rejected without a binary decoder.
 */
export class LowMemorySyncIndexRuntime {
  private readonly byFile = new Map<string, LowMemorySyncAnchor[]>();
  private readonly byPage = new Map<number, LowMemorySyncAnchor[]>();

  public constructor(public readonly index: LowMemorySyncIndex) {
    for (const anchor of index.anchors) {
      const path = index.files[anchor.fileId];
      const fileKey = filePathKey(path);
      const fileAnchors = this.byFile.get(fileKey) ?? [];
      fileAnchors.push(anchor);
      this.byFile.set(fileKey, fileAnchors);
      const pageAnchors = this.byPage.get(anchor.pageNo) ?? [];
      pageAnchors.push(anchor);
      this.byPage.set(anchor.pageNo, pageAnchors);
    }
    for (const anchors of this.byFile.values()) anchors.sort((left, right) => left.line - right.line);
    for (const anchors of this.byPage.values()) anchors.sort((left, right) => left.y - right.y);
  }

  public findSource(path: string, line: number): IndexedSourceLocation | null {
    const anchor = nearestByLine(this.byFile.get(filePathKey(path)) ?? [], line);
    return anchor ? { ...anchor, path: this.index.files[anchor.fileId] } : null;
  }

  public findPreview(position: Pick<PreviewDocumentPosition, "page_no" | "y">): IndexedSourceLocation | null {
    for (let distance = 0; distance <= 2; distance += 1) {
      const pages = distance === 0
        ? [position.page_no]
        : [position.page_no - distance, position.page_no + distance];
      for (const page of pages) {
        const anchor = nearestByY(this.byPage.get(page) ?? [], position.y);
        if (anchor) return { ...anchor, path: this.index.files[anchor.fileId] };
      }
    }
    return null;
  }
}
