import type { PreviewDocumentPosition } from "../compiler/lsp";
import type { EditorView } from "@codemirror/view";
import {
  LowMemorySyncIndexRuntime,
  type IndexedSourceLocation,
  type LowMemorySyncIndex,
  validateLowMemorySyncIndex,
} from "./lowMemorySyncIndex";

export interface LowMemorySyncIndexControllerDependencies {
  revealDocumentPosition(position: PreviewDocumentPosition, options?: { ripple?: boolean }): Promise<boolean> | boolean;
  log(kind: "info" | "warning", source: string, message: string): void;
  recordPerformance?(name: "low-memory-sync.forward.lookup" | "low-memory-sync.inverse.lookup", milliseconds: number, detail?: Record<string, string | number | boolean>): void;
}

/**
 * Owns only persistent, local PDF/source lookup. It deliberately has no LSP
 * dependency: low-memory mode must remain functional after Tinymist exits.
 */
export class LowMemorySyncIndexController {
  private runtime: LowMemorySyncIndexRuntime | null = null;
  private lastForwardAnchor = "";

  public constructor(private readonly deps: LowMemorySyncIndexControllerDependencies) {}

  public clear(): void {
    this.runtime = null;
    this.lastForwardAnchor = "";
  }

  public install(value: unknown, expected?: Pick<LowMemorySyncIndex, "generationId" | "pdfHash">): boolean {
    if (!validateLowMemorySyncIndex(value)) {
      this.deps.log("warning", "forward sync", "Rejected an invalid low-memory sync index.");
      return false;
    }
    if (value.anchors.length === 0) {
      // An empty index cannot provide either sync direction. Treat it as a
      // failed cache entry so the next PDF generation retries indexing rather
      // than permanently reusing an earlier decoder/query failure.
      this.deps.log("warning", "forward sync", "Rejected a low-memory sync index with no source locations.");
      return false;
    }
    if (expected && (value.generationId !== expected.generationId || value.pdfHash !== expected.pdfHash)) {
      this.deps.log("warning", "forward sync", "Rejected a stale low-memory sync index for the current PDF generation.");
      return false;
    }
    this.runtime = new LowMemorySyncIndexRuntime(value);
    this.lastForwardAnchor = "";
    this.deps.log("info", "forward sync", `Low-memory index loaded: ${value.anchors.length} source location(s) across ${value.files.length} file(s).`);
    return true;
  }

  public isReady(): boolean {
    return this.runtime !== null;
  }

  public followEditor(path: string, editor: EditorView, cursor: number, manual = false): boolean {
    const startedAt = performance.now();
    const line = editor.state.doc.lineAt(Math.max(0, Math.min(cursor, editor.state.doc.length))).number - 1;
    const anchor = this.runtime?.findSource(path, line) ?? null;
    this.deps.recordPerformance?.("low-memory-sync.forward.lookup", performance.now() - startedAt, {
      line,
      found: Boolean(anchor),
    });
    if (!anchor) return false;
    const key = `${anchor.fileId}:${anchor.line}:${anchor.pageNo}:${anchor.y}`;
    if (!manual && key === this.lastForwardAnchor) return true;
    this.lastForwardAnchor = key;
    // Indexed sync is approximate, so always expose the resolved PDF anchor.
    // This makes automatic following as debuggable as the explicit Alt+Enter
    // command and lets the user immediately verify the paragraph-level match.
    this.deps.log("info", "forward sync", `Indexed forward sync: ${anchor.path}:${anchor.line + 1} → page ${anchor.pageNo}.`);
    void Promise.resolve(
      this.deps.revealDocumentPosition(
        { page_no: anchor.pageNo, x: anchor.x, y: anchor.y },
        { ripple: true },
      ),
    ).then(rendered => {
      this.deps.log(
        rendered ? "info" : "warning",
        "forward sync",
        rendered
          ? `Indexed forward sync marker shown on page ${anchor.pageNo}.`
          : `Indexed forward sync resolved page ${anchor.pageNo}, but the PDF marker could not be displayed.`,
      );
    }).catch(error => {
      this.deps.log("warning", "forward sync", `Indexed forward sync marker failed: ${String(error)}.`);
    });
    return true;
  }

  public findInverse(position: PreviewDocumentPosition): IndexedSourceLocation | null {
    const startedAt = performance.now();
    const anchor = this.runtime?.findPreview(position) ?? null;
    this.deps.recordPerformance?.("low-memory-sync.inverse.lookup", performance.now() - startedAt, {
      pageNo: position.page_no,
      found: Boolean(anchor),
    });
    return anchor;
  }
}
