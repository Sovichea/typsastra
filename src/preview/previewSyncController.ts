import { EditorView } from "@codemirror/view";
import type { LspStatus, PreviewDocumentPosition, TinymistLspClient } from "../compiler/lsp";
import { nativeFilePath } from "../platform/paths";
import type { PreviewClickPoint } from "./previewFrame";
import type { PreviewRefreshStyle } from "./previewPolicy";
import type { SourceMapSessionController, SourceMapLogSource } from "./sourceMapSessionController";

export type PdfSyncContext = {
  rootPath: string | null;
  taskId: string | null;
  previewUrl: string;
  previewGeneration: number;
  refreshStyle: PreviewRefreshStyle;
  timeoutMs: number;
  externalRefreshPending: boolean;
  previewRunning: boolean;
  previewDisabled: boolean;
  interactionBlocked: boolean;
};

type ForwardSyncTarget = {
  filepath: string;
  line: number;
  character: number;
};

export type PreviewSyncDependencies = {
  getEditor: () => EditorView | undefined;
  getClient: () => TinymistLspClient | undefined;
  getActiveFilePath: () => string | null;
  getPreviewRootPath: () => string | null;
  getPreviewTaskId: () => string | null;
  isReady: () => boolean;
  isEnabled: () => boolean;
  isLowMemoryMode: () => boolean;
  handleForwardPosition?: (path: string, cursor: number) => Promise<boolean>;
  mapForwardPosition?: (path: string, cursor: number) => Promise<{ filepath: string; line: number; character: number } | null>;
  sourceMap?: SourceMapSessionController;
  getPdfContext?: () => PdfSyncContext;
  isForwardPositionEligible?: (path: string, cursor: number) => boolean;
  mapPdfForwardTarget?: (path: string, cursor: number) => Promise<ForwardSyncTarget | null>;
  setStatus?: (status: LspStatus) => void;
  updateManualAction?: (busy: boolean, available: boolean) => void;
  log?: (source: SourceMapLogSource, kind: "info" | "warning", message: string) => void;
  revealDocumentPosition?: (position: PreviewDocumentPosition) => void | Promise<void>;
  emitForwardPosition?: (position: PreviewDocumentPosition) => void;
};

const PDF_SOURCE_MAP_READY_TIMEOUT_MS = 60_000;

export class PreviewSyncController {
  private forwardTimer: number | null = null;
  private forwardGeneration = 0;
  private forwardSuppressedUntil = 0;
  private lastForwardTarget: { key: string; timestamp: number } | null = null;
  private pendingPreviewClick: (PreviewClickPoint & { timestamp: number }) | null = null;
  private pdfForwardGeneration = 0;
  private pendingPdfForward: {
    generation: number;
    requestedAt: number;
    expiresAt: number;
  } | null = null;
  private manualForwardGeneration: number | null = null;
  private queuedManualForward: { path: string; cursor: number } | null = null;
  private warmupTimer: number | null = null;

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
    this.cancelManual();
    this.clearWarmup();
  }

  public applyLowMemoryMode(enabled: boolean): void {
    if (enabled) this.clearWarmup();
  }

  public requestManual(path: string, cursor: number): void {
    const request = { path, cursor };
    if (this.manualForwardGeneration !== null) {
      this.queuedManualForward = request;
      this.dependencies.setStatus?.({ kind: "sync-pending", message: "Latest preview reveal queued" });
      return;
    }
    if (!this.canRevealManually()) {
      this.dependencies.setStatus?.({
        kind: "preview-ready",
        message: "Wait for the compiled preview before revealing the cursor",
      });
      return;
    }
    void this.runManual(request);
  }

  public canRevealManually(): boolean {
    const context = this.dependencies.getPdfContext?.();
    return Boolean(
      this.dependencies.getActiveFilePath()?.toLowerCase().endsWith(".typ")
      && this.dependencies.isReady()
      && context?.previewUrl
      && !context.previewRunning
      && !context.externalRefreshPending
      && !context.previewDisabled
    );
  }

  public refreshManualAction(): void {
    this.dependencies.updateManualAction?.(
      this.manualForwardGeneration !== null,
      this.canRevealManually(),
    );
  }

  public cancelManual(): void {
    if (
      this.manualForwardGeneration === null
      && this.pendingPdfForward === null
      && this.queuedManualForward === null
    ) return;
    ++this.pdfForwardGeneration;
    this.pendingPdfForward = null;
    this.manualForwardGeneration = null;
    this.queuedManualForward = null;
    this.refreshManualAction();
  }

  public async handlePdfForward(path: string, cursor: number, requestedGeneration?: number): Promise<boolean> {
    const context = this.dependencies.getPdfContext?.();
    const sourceMap = this.dependencies.sourceMap;
    const client = this.dependencies.getClient();
    if (!context || !sourceMap || !this.dependencies.mapPdfForwardTarget) return false;

    const startedAt = performance.now();
    const deadline = startedAt + context.timeoutMs;
    const generation = requestedGeneration ?? ++this.pdfForwardGeneration;
    if (
      context.externalRefreshPending
      || !client
      || !context.rootPath
      || !context.taskId
      || !this.dependencies.isReady()
      || !context.previewUrl
    ) {
      this.log("forward sync", "info", `Skipped forward sync: externalRefresh=${context.externalRefreshPending}, client=${!!client}, root=${context.rootPath ?? "n/a"}, task=${context.taskId ?? "n/a"}, lspReady=${this.dependencies.isReady()}, preview=${context.previewUrl || "n/a"}.`);
      return false;
    }
    if (!this.isEligible(path, cursor)) {
      this.log("forward sync", "info", `Skipped forward sync: source offset ${cursor} is not textual Typst content.`);
      return false;
    }

    const target = await this.dependencies.mapPdfForwardTarget(path, cursor);
    const localMappingMs = performance.now() - startedAt;
    if (generation !== this.pdfForwardGeneration) return false;
    if (!target) {
      this.log("forward sync", "warning", `Skipped forward sync: could not map editor cursor ${cursor} for ${path}.`);
      return false;
    }

    const sessionStartedAt = performance.now();
    const startup = sourceMap.ensureSession(
      client,
      nativeFilePath(context.rootPath),
      context.taskId,
      context.refreshStyle,
      "forward sync",
    );
    let startupTimer: number | null = null;
    const session = await Promise.race([
      startup,
      new Promise<null>(resolve => {
        startupTimer = window.setTimeout(() => resolve(null), Math.max(1, deadline - performance.now()));
      }),
    ]);
    if (startupTimer !== null) window.clearTimeout(startupTimer);
    const sessionReadyMs = performance.now() - sessionStartedAt;
    if (generation !== this.pdfForwardGeneration) return false;
    if (!session) {
      this.log("forward sync", "warning", `Skipped PDF forward sync: source-map socket unavailable within ${context.timeoutMs}ms.`);
      return false;
    }

    const documentReadyStartedAt = performance.now();
    const documentReady = await sourceMap.waitForDocument(
      session.socket,
      Math.max(1, deadline - performance.now()),
    );
    const documentReadyMs = performance.now() - documentReadyStartedAt;
    if (generation !== this.pdfForwardGeneration) return false;
    if (!documentReady) {
      this.log("forward sync", "warning", `Skipped PDF forward sync: source-map document did not become ready within ${context.timeoutMs}ms.`);
      return false;
    }

    const positionBudget = Math.max(1, deadline - performance.now());
    const requestedAt = Date.now();
    this.pendingPdfForward = { generation, requestedAt, expiresAt: requestedAt + positionBudget };
    window.setTimeout(() => {
      if (this.pendingPdfForward?.generation !== generation) return;
      this.pendingPdfForward = null;
      this.log("forward sync", "warning", "Forward sync timed out waiting for Tinymist source-map position.");
      this.finishManual(generation, "Reveal in preview timed out");
    }, positionBudget);

    void client.scrollPreview(session.taskId, {
      event: "panelScrollTo",
      filepath: nativeFilePath(target.filepath),
      line: target.line,
      character: target.character,
    });
    this.log("forward sync", "info", `Requested one compiler preview position: ${target.filepath}:${target.line + 1}:${target.character}; localMappingMs=${localMappingMs.toFixed(1)}; sessionReadyMs=${sessionReadyMs.toFixed(1)}; documentReadyMs=${documentReadyMs.toFixed(1)}.`);
    return true;
  }

  public handlePositionPayload(text: string): void {
    const positions = parseTinymistPreviewPositions(text);
    if (positions.length === 0) {
      if (this.pendingPdfForward) {
        this.log("forward sync", "info", `Ignored source-map payload without PDF position: ${sanitizeLogText(text).slice(0, 120)}`);
      }
      return;
    }
    const pending = this.pendingPdfForward;
    if (!pending || Date.now() > pending.expiresAt) return;
    const lookupMs = Date.now() - pending.requestedAt;
    this.pendingPdfForward = null;
    const position = positions[0];
    this.log("forward sync", "info", `Compiler document position: candidates=${positions.length}, page=${position.page_no}, x=${position.x.toFixed(2)}, y=${position.y.toFixed(2)}, lookupMs=${lookupMs}.`);
    void this.dependencies.revealDocumentPosition?.(position);
    this.finishManual(pending.generation, "Cursor revealed in preview");
    this.dependencies.emitForwardPosition?.(position);
  }

  public async sendInverse(point: PreviewClickPoint): Promise<boolean> {
    const position = point.documentPosition;
    const context = this.dependencies.getPdfContext?.();
    const sourceMap = this.dependencies.sourceMap;
    const client = this.dependencies.getClient();
    if (!context || !sourceMap) return false;
    if (context.externalRefreshPending) {
      this.log("inverse sync", "info", "Skipped inverse sync while an externally changed preview revision is being prepared.");
      return false;
    }
    if (!position || !client || !context.rootPath || !context.taskId || !this.dependencies.isReady()) {
      this.log("inverse sync", "warning", `Skipped PDF inverse sync: position=${!!position}, client=${!!client}, root=${context.rootPath ?? "n/a"}, task=${context.taskId ?? "n/a"}, lspReady=${this.dependencies.isReady()}.`);
      return false;
    }
    const session = await sourceMap.ensureSession(
      client,
      nativeFilePath(context.rootPath),
      context.taskId,
      context.refreshStyle,
      "inverse sync",
    );
    if (!session) {
      this.log("inverse sync", "warning", "Skipped PDF inverse sync: source-map socket unavailable.");
      return false;
    }
    if (!await sourceMap.waitForDocument(session.socket, PDF_SOURCE_MAP_READY_TIMEOUT_MS)) {
      this.log("inverse sync", "warning", "Skipped PDF inverse sync: source-map document did not become ready.");
      return false;
    }
    this.recordPreviewClick(point);
    this.log("inverse sync", "info", `Sending compiler inverse position: page=${position.page_no}, x=${position.x.toFixed(2)}, y=${position.y.toFixed(2)}, root=${context.rootPath}.`);
    session.socket.send(`src-point ${JSON.stringify(position)}`);
    return true;
  }

  public scheduleWarmup(generation: number): void {
    this.clearWarmup();
    if (this.dependencies.isLowMemoryMode()) return;
    const startedAt = performance.now();
    const attempt = () => {
      this.warmupTimer = null;
      const context = this.dependencies.getPdfContext?.();
      if (!context || generation !== context.previewGeneration) return;
      const ready = this.dependencies.isReady()
        && !!this.dependencies.getClient()
        && !!context.rootPath
        && !!context.taskId;
      if (context.interactionBlocked || context.previewRunning || !ready) {
        if (performance.now() - startedAt >= PDF_SOURCE_MAP_READY_TIMEOUT_MS) {
          this.log("forward sync", "warning", "Source-map warm-up was not scheduled because project reload prerequisites did not become ready.");
          return;
        }
        this.warmupTimer = window.setTimeout(attempt, 250);
        return;
      }
      void this.warm(generation);
    };
    this.warmupTimer = window.setTimeout(attempt, 250);
  }

  public clearWarmup(): void {
    if (this.warmupTimer !== null) window.clearTimeout(this.warmupTimer);
    this.warmupTimer = null;
  }

  private async runManual(request: { path: string; cursor: number }): Promise<void> {
    if (!this.isEligible(request.path, request.cursor)) {
      this.log("forward sync", "info", `Reveal skipped: source offset ${request.cursor} is not textual Typst content.`);
      this.dependencies.setStatus?.({ kind: "preview-ready", message: "This source position does not produce preview text" });
      return;
    }
    const generation = ++this.pdfForwardGeneration;
    this.manualForwardGeneration = generation;
    this.pendingPdfForward = null;
    this.refreshManualAction();
    this.dependencies.setStatus?.({ kind: "sync-pending", message: "Locating cursor in preview..." });
    try {
      const requested = await this.handlePdfForward(request.path, request.cursor, generation);
      if (!requested && generation === this.manualForwardGeneration) {
        this.finishManual(generation, "Could not locate cursor in preview");
      }
    } catch (error) {
      this.log("forward sync", "warning", `Manual forward sync failed: ${String(error)}`);
      this.finishManual(generation, "Could not locate cursor in preview");
    }
  }

  private finishManual(generation: number, statusMessage: string): void {
    if (this.manualForwardGeneration !== generation) return;
    this.manualForwardGeneration = null;
    this.dependencies.setStatus?.({ kind: "preview-ready", message: statusMessage });
    this.refreshManualAction();
    const queued = this.queuedManualForward;
    this.queuedManualForward = null;
    if (queued) void this.runManual(queued);
  }

  private isEligible(path: string, cursor: number): boolean {
    return this.dependencies.isForwardPositionEligible?.(path, cursor) ?? true;
  }

  private async warm(generation: number): Promise<void> {
    const context = this.dependencies.getPdfContext?.();
    const sourceMap = this.dependencies.sourceMap;
    const client = this.dependencies.getClient();
    const activePath = this.dependencies.getActiveFilePath();
    const cursor = this.dependencies.getEditor()?.state.selection.main.head ?? 0;
    if (!context || !sourceMap || !client || !context.rootPath || !context.taskId || !activePath || !this.dependencies.mapPdfForwardTarget) return;
    if (!this.dependencies.isReady() || generation !== context.previewGeneration) return;
    const startedAt = performance.now();
    const session = await sourceMap.ensureSession(client, nativeFilePath(context.rootPath), context.taskId, context.refreshStyle, "forward sync", true);
    if (!session || generation !== this.dependencies.getPdfContext?.().previewGeneration) return;
    const target = activePath.toLowerCase().endsWith(".typ")
      ? await this.dependencies.mapPdfForwardTarget(activePath, cursor)
      : null;
    if (!target || generation !== this.dependencies.getPdfContext?.().previewGeneration) return;
    const ready = await sourceMap.ensureWarm(
      session.socket,
      () => client.scrollPreview(session.taskId, {
        event: "panelScrollTo",
        filepath: nativeFilePath(target.filepath),
        line: target.line,
        character: target.character,
      }),
      PDF_SOURCE_MAP_READY_TIMEOUT_MS,
    );
    if (generation !== this.dependencies.getPdfContext?.().previewGeneration) return;
    this.log("forward sync", ready ? "info" : "warning", ready
      ? `Source-map session warmed after PDF presentation in ${(performance.now() - startedAt).toFixed(1)}ms.`
      : `Source-map session did not become ready within ${PDF_SOURCE_MAP_READY_TIMEOUT_MS}ms.`);
  }

  private log(source: SourceMapLogSource, kind: "info" | "warning", message: string): void {
    this.dependencies.log?.(source, kind, message);
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

function sanitizeLogText(str: string): string {
  return str.replace(/[\x00-\x1F\x7F-\x9F\uFFFD]/g, ".");
}

function parseTinymistPreviewPositions(data: string): PreviewDocumentPosition[] {
  const positions: PreviewDocumentPosition[] = [];
  const match = data.trim().match(/^jump,\s*(\d+)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)/u);
  if (match) {
    const pageNo = Number(match[1]);
    const x = Number(match[2]);
    const y = Number(match[3]);
    if (Number.isFinite(pageNo) && Number.isFinite(x) && Number.isFinite(y)) {
      positions.push({ page_no: pageNo, x, y });
    }
  }
  const trimmed = data.trim();
  const candidates = [trimmed];
  const comma = trimmed.indexOf(",");
  if (comma >= 0) candidates.push(trimmed.slice(comma + 1).trim());
  const firstObject = trimmed.indexOf("{");
  if (firstObject >= 0) candidates.push(trimmed.slice(firstObject));
  const firstArray = trimmed.indexOf("[");
  if (firstArray >= 0) candidates.push(trimmed.slice(firstArray));
  for (const candidate of new Set(candidates.filter(Boolean))) {
    try {
      collectPreviewPositions(JSON.parse(candidate), positions);
    } catch {
      // Try the remaining payload shapes.
    }
  }
  return positions;
}

function collectPreviewPositions(value: unknown, output: PreviewDocumentPosition[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectPreviewPositions(item, output);
    return;
  }
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  const pageNo = typeof record.page_no === "number"
    ? record.page_no
    : typeof record.page === "number"
      ? record.page
      : undefined;
  if (typeof pageNo === "number" && typeof record.x === "number" && typeof record.y === "number") {
    output.push({ page_no: pageNo, x: record.x, y: record.y });
  }
  for (const item of Object.values(record)) collectPreviewPositions(item, output);
}
