export type PreviewClickPoint = {
  pageNo?: number;
  documentPosition?: { page_no: number; x: number; y: number };
  draftImageId?: string;
};

export type PreviewInteractionStatus = {
  kind: "installed" | "blocked" | "debug";
  url: string;
  reason?: string;
};

export type PreviewPageStatus = {
  currentPage: number;
  pageCount: number;
};

export type PreviewOutlineItem = {
  title: string;
  position?: { page_no: number; x: number; y: number };
  bookmarkIndex?: number;
  children: PreviewOutlineItem[];
};

export type PreviewSurface = "live" | "pdf";

export type DraftPreviewImage = {
  status: "ready";
  bytes: Uint8Array;
  mimeType: string;
  filename: string;
  width: number;
  height: number;
  sourceBytes: number;
};

export type DraftPreviewImageResult = DraftPreviewImage | {
  status: "pending" | "generating" | "failed";
  message?: string;
};

export type PreviewMemorySnapshot = {
  pdfGeneration: number;
  pdfBytes: number;
  pdfBytesRead: number;
  pdfRangeRequests: number;
  pdfTransport: "none" | "full-buffer" | "range";
  pdfPages: number;
  residentCanvases: number;
  residentFinalCanvases: number;
  canvasPixels: number;
  fontFaces: number;
  activeRenders: number;
  loading: boolean;
};

import { invoke } from "@tauri-apps/api/core";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { open as openUrl } from "@tauri-apps/plugin-shell";
import { parsePreviewCompilerDiagnostic, type TypstSourceLocation } from "../compiler/previewError";
import { PERFORMANCE_BUDGETS, type PerformanceMetric } from "../performance/diagnostics";
import { formatFileSize } from "../workspace/largeFileOpening";
import type { PreviewColorMode } from "../settings";
import {
  previewLinkModifierAfterKeyboardEvent,
  previewLinkModifierPressed,
  previewLinkTarget,
  type PreviewLinkTarget,
} from "./previewLinks";
import { pageDimensionsChanged, pagesToEvict, visiblePageIndexes } from "./virtualization";
import { PreviewMotionController } from "./previewMotion";
import { applyDarkPreviewPixels } from "./darkPreview";
import {
  capturePreviewViewportAnchor,
  previewViewportAnchorDelta,
  type PreviewViewportAnchor,
} from "./previewViewportAnchor";
import {
  PreviewRenderScheduler,
  type PreviewRenderReason,
  type PreviewRenderRequest
} from "./previewRenderScheduler";
import {
  PreviewPageRenderOwnership,
  type CleanablePdfPage
} from "./previewPageRenderOwnership";
import {
  TYPSASTRA_GREEN,
  TYPSASTRA_GREEN_RIPPLE_FILL,
  TYPSASTRA_GREEN_RIPPLE_SHADOW
} from "../ui/brandColors";

type PdfJsModule = typeof import("pdfjs-dist");

type PreviewPdfSource =
  | { kind: "bytes"; source: Uint8Array | ArrayBuffer | Promise<Uint8Array | ArrayBuffer> }
  | { kind: "range"; path: string; deleteOnClose: boolean };

type PdfRangeSourceInfo = {
  sourceId: number;
  length: number;
};

type PdfTransportStats = {
  transport: "full-buffer" | "range";
  bytesRead: number;
  rangeRequests: number;
};

type PdfLoadingHandle = {
  destroy(): Promise<void>;
};

type PageDimensions = {
  width: number;
  height: number;
};

type ActivePageRender = {
  generation: number;
  renderKey: string;
  task: { cancel(): void } | null;
  page: CleanablePdfPage | null;
  canvas: HTMLCanvasElement | null;
  canvasCommitted: boolean;
};

const ZOOM_LEVELS = [25, 33, 50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200, 250, 300, 400, 500];
const FALLBACK_ZOOM_PERCENT = 90;
const MAX_OUTPUT_SCALE = 2;
// Local PDFs do not have network latency, but every range still crosses the
// Tauri IPC boundary. One MiB keeps each allocation bounded while avoiding the
// several round trips a typical image-heavy page required with 256 KiB chunks.
const LOCAL_PDF_RANGE_CHUNK_SIZE = 1024 * 1024;
// The viewer has 20px padding on each side. Keep an additional gutter for the
// vertical scrollbar and fractional layout rounding so fit mode never overflows.
const FIT_PADDING_PX = 56;

export class PreviewFrame {
  private iframe: HTMLIFrameElement | null = null;
  private messageHost: HTMLDivElement | null = null;
  private errorOverlay: HTMLDivElement | null = null;
  private mountedUrl = "";
  private mountedSessionKey = "";
  private previewZoomPercent = FALLBACK_ZOOM_PERCENT;
  private isFitToWidth = true;
  private resizeObserver: ResizeObserver | null = null;
  private resizeLayoutSuspended = false;
  private resizeLayoutPending = false;
  private resizeScrollAnchor: PreviewViewportAnchor | null = null;
  private pdfCleanupQueue: Promise<void> = Promise.resolve();
  private lastInteractionStatusKey = "";
  private pdfJsPromise: Promise<PdfJsModule> | null = null;
  private pdfWorker: { destroyed?: boolean; destroy(): void } | null = null;
  private pdfLoadingTask: PdfLoadingHandle | null = null;
  private pendingPdfLoadingTask: PdfLoadingHandle | null = null;
  private pdfDoc: any = null;
  private observer: IntersectionObserver | null = null;
  private pageDimensions = new Map<number, PageDimensions>();
  private pageSlots: HTMLElement[] = [];
  private activeRenders = new Map<number, ActivePageRender>();
  private readonly pageRenderOwnership = new PreviewPageRenderOwnership<CleanablePdfPage>();
  private readonly renderScheduler = new PreviewRenderScheduler();
  private readonly motion = new PreviewMotionController();
  private renderDispatching = false;
  private activeRenderLanes = 0;
  private motionFrame: number | null = null;
  private motionDestinationPage = 1;
  private motionStartedAt: number | null = null;
  private finalDecisionAt: number | null = null;
  private pdfGeneration = 0;
  private currentPdfBytes = 0;
  private currentPdfBytesRead = 0;
  private currentPdfRangeRequests = 0;
  private currentPdfTransport: PreviewMemorySnapshot["pdfTransport"] = "none";
  private firstRenderedGeneration = 0;
  private forwardRippleGeneration = 0;
  private zoomStartedAt: number | null = null;
  private lastPageStatusKey = "";
  private instantScrollTargetPage: number | null = null;
  private readonly annotationTargets = new WeakMap<HTMLElement, PreviewLinkTarget>();
  private draftPopover: HTMLElement | null = null;
  private draftObjectUrl: string | null = null;
  private draftHoverGeneration = 0;
  private draftHoverLink: HTMLElement | null = null;
  private draftPointerPosition: { x: number; y: number } | null = null;
  private draftHoverRetargetTimer: number | null = null;
  private pendingRestoredScrollTop: number | null = null;
  private previewPointerInside = false;
  private previewLinkModifierHeld = false;
  private previewColorMode: PreviewColorMode = "document";
  private readonly pageImageCoordinates = new WeakMap<HTMLCanvasElement, readonly number[]>();
  private pdfOutlineDestinations: unknown[] = [];

  constructor(
    private readonly pane: HTMLElement,
    private readonly onPreviewClick: (point: PreviewClickPoint) => void,
    private readonly onInteractionStatus?: (status: PreviewInteractionStatus) => void,
    private readonly onZoomChanged?: (zoomPercent: number) => void,
    private readonly onPerformance?: (metric: Omit<PerformanceMetric, "recordedAt">) => void,
    private readonly onPageChanged?: (status: PreviewPageStatus) => void,
    private readonly onDraftImageRequest?: (id: string) => Promise<DraftPreviewImageResult | null>,
    private readonly onScrollPositionChanged?: (scrollTop: number) => void,
    private readonly onDebug?: (message: string) => void,
    private readonly onDocumentOutline?: (items: PreviewOutlineItem[]) => void,
    private readonly onLoadStage?: (
      stage: string,
      detail: Record<string, number | string | boolean>
    ) => void | Promise<void>
  ) {
    this.pane.addEventListener("wheel", event => {
      if (event.ctrlKey) {
        event.preventDefault();
        if (event.deltaY < 0) {
          this.zoomIn();
        } else {
          this.zoomOut();
        }
      }
    }, { passive: false });
    window.addEventListener("keydown", event => {
      this.previewLinkModifierHeld = previewLinkModifierAfterKeyboardEvent(event, "keydown");
      const doc = this.iframe?.contentDocument;
      if (doc) this.setPreviewLinkModifier(doc, this.previewPointerInside && this.previewLinkModifierHeld);
    });
    window.addEventListener("keyup", event => {
      this.previewLinkModifierHeld = previewLinkModifierAfterKeyboardEvent(event, "keyup");
      const doc = this.iframe?.contentDocument;
      if (doc) this.setPreviewLinkModifier(doc, this.previewPointerInside && this.previewLinkModifierHeld);
    });
    window.addEventListener("blur", () => {
      this.previewLinkModifierHeld = false;
      const doc = this.iframe?.contentDocument;
      if (doc) this.setPreviewLinkModifier(doc, false);
    });

    this.resizeObserver = new ResizeObserver(() => {
      if (this.resizeLayoutSuspended) {
        this.resizeLayoutPending = true;
        return;
      }
      if (!this.isFitToWidth || !this.pdfDoc) return;
      this.applyFitToWidth();
    });
    this.resizeObserver.observe(this.pane);
  }

  public get element(): HTMLIFrameElement | null {
    return this.iframe;
  }

  public get currentUrl(): string {
    return this.mountedUrl;
  }

  public get currentSessionKey(): string {
    return this.mountedSessionKey;
  }

  public get currentZoomPercent(): number {
    return this.previewZoomPercent;
  }

  public get isFitMode(): boolean {
    return this.isFitToWidth;
  }

  public restoreWorkspaceScrollPosition(scrollTop: number): void {
    this.pendingRestoredScrollTop = Number.isFinite(scrollTop)
      ? Math.max(0, scrollTop)
      : 0;
  }

  public queueTabScrollPosition(scrollTop?: number): void {
    this.pendingRestoredScrollTop = typeof scrollTop === "number" && Number.isFinite(scrollTop)
      ? Math.max(0, scrollTop)
      : null;
    this.onDebug?.(`Preview tab scroll queued: requested=${this.pendingRestoredScrollTop ?? "none"}; session=${this.mountedSessionKey || "none"}; url=${this.mountedUrl ? "mounted" : "none"}.`);
  }

  public syncTheme(): void {
    const root = this.iframe?.contentDocument?.documentElement;
    if (!root) return;
    const hostStyle = getComputedStyle(document.documentElement);
    const copy = (source: string, target: string, fallback: string) => {
      root.style.setProperty(target, hostStyle.getPropertyValue(source).trim() || fallback);
    };
    copy("--ui-bg", "--preview-ui-bg", "#fcfcfc");
    copy("--ui-header-text", "--preview-ui-header", "#616161");
    copy("--ui-accent-color", "--preview-ui-accent", TYPSASTRA_GREEN);
    this.applyColorMode(root);
  }

  public setColorMode(mode: PreviewColorMode): void {
    this.previewColorMode = mode;
    this.syncResidentColorCanvases();
    const root = this.iframe?.contentDocument?.documentElement;
    if (root) this.applyColorMode(root);
  }

  public get colorMode(): PreviewColorMode {
    return this.previewColorMode;
  }

  private applyColorMode(root: HTMLElement): void {
    root.dataset.previewColorMode = this.previewColorMode;
  }

  private syncResidentColorCanvases(): void {
    const doc = this.iframe?.contentDocument;
    if (!doc) return;
    for (const original of doc.querySelectorAll<HTMLCanvasElement>(".pdf-page-canvas-original")) {
      const slot = original.closest<HTMLElement>(".pdf-page-container");
      if (!slot) continue;
      if (this.previewColorMode === "dark") this.installDarkCanvas(slot, original);
      else this.removeDarkCanvas(slot);
    }
  }

  private installDarkCanvas(slot: HTMLElement, original: HTMLCanvasElement): void {
    this.removeDarkCanvas(slot);
    const darkCanvas = original.ownerDocument.createElement("canvas");
    darkCanvas.className = "pdf-page-canvas pdf-page-canvas-dark";
    darkCanvas.width = original.width;
    darkCanvas.height = original.height;
    const context = darkCanvas.getContext("2d", { willReadFrequently: true });
    if (!context) {
      releaseCanvas(darkCanvas);
      return;
    }

    context.drawImage(original, 0, 0);
    const darkPixels = context.getImageData(0, 0, darkCanvas.width, darkCanvas.height);
    applyDarkPreviewPixels(darkPixels.data);
    context.putImageData(darkPixels, 0, 0);

    const coordinates = this.pageImageCoordinates.get(original) ?? [];
    for (let index = 0; index + 5 < coordinates.length; index += 6) {
      const x1 = coordinates[index] * original.width;
      const y1 = coordinates[index + 1] * original.height;
      const x2 = coordinates[index + 2] * original.width;
      const y2 = coordinates[index + 3] * original.height;
      const x3 = coordinates[index + 4] * original.width;
      const y3 = coordinates[index + 5] * original.height;
      const x4 = x2 + x3 - x1;
      const y4 = y2 + y3 - y1;
      context.save();
      context.beginPath();
      context.moveTo(x1, y1);
      context.lineTo(x2, y2);
      context.lineTo(x4, y4);
      context.lineTo(x3, y3);
      context.closePath();
      context.clip();
      context.drawImage(original, 0, 0);
      context.restore();
    }

    original.insertAdjacentElement("afterend", darkCanvas);
  }

  private removeDarkCanvas(slot: HTMLElement): void {
    for (const canvas of slot.querySelectorAll<HTMLCanvasElement>(".pdf-page-canvas-dark")) {
      releaseCanvas(canvas);
      canvas.remove();
    }
  }

  public suspendResizeLayout(): void {
    // Capture before the pane width changes. Capturing after the resize has
    // started can anchor against an already reflowed page and visibly jump.
    this.resizeScrollAnchor = this.captureScrollAnchor();
    this.resizeLayoutSuspended = true;
    this.resizeLayoutPending = false;
  }

  public resumeResizeLayout(): void {
    if (!this.resizeLayoutSuspended) return;
    this.resizeLayoutSuspended = false;
    const shouldApplyFinalFit = this.resizeLayoutPending;
    this.resizeLayoutPending = false;
    const anchor = this.resizeScrollAnchor;
    this.resizeScrollAnchor = null;
    // ResizeObserver may deliver its final notification after pointerup. Apply
    // the final fit ourselves and restore the pre-resize viewport anchor.
    if ((shouldApplyFinalFit || anchor) && this.isFitToWidth && this.pdfDoc) {
      this.applyFitToWidth(anchor);
    }
  }

  public zoomIn(): number {
    const anchor = this.captureScrollAnchor();
    this.isFitToWidth = false;
    return this.setZoom(
      ZOOM_LEVELS.find(level => level > this.previewZoomPercent) ?? this.previewZoomPercent,
      anchor,
    );
  }

  public memorySnapshot(): PreviewMemorySnapshot {
    const iframeDoc = this.iframe?.contentDocument;
    const canvases = [...(iframeDoc?.querySelectorAll<HTMLCanvasElement>("canvas") ?? [])];
    const fontFaces = iframeDoc?.fonts
      ? [...(iframeDoc.fonts as unknown as Iterable<FontFace>)].length
      : 0;
    return {
      pdfGeneration: this.pdfGeneration,
      pdfBytes: this.currentPdfBytes,
      pdfBytesRead: this.currentPdfBytesRead,
      pdfRangeRequests: this.currentPdfRangeRequests,
      pdfTransport: this.currentPdfTransport,
      pdfPages: Number(this.pdfDoc?.numPages ?? 0),
      residentCanvases: canvases.length,
      residentFinalCanvases: iframeDoc?.querySelectorAll(".pdf-page-canvas").length ?? 0,
      canvasPixels: canvases.reduce((total, canvas) => total + canvas.width * canvas.height, 0),
      fontFaces,
      activeRenders: this.activeRenders.size,
      loading: this.pendingPdfLoadingTask !== null
    };
  }

  public zoomOut(): number {
    const anchor = this.captureScrollAnchor();
    this.isFitToWidth = false;
    return this.setZoom(
      [...ZOOM_LEVELS].reverse().find(level => level < this.previewZoomPercent) ?? this.previewZoomPercent,
      anchor,
    );
  }

  public zoomToFit(): void {
    const anchor = this.captureScrollAnchor();
    this.isFitToWidth = true;
    this.updateHorizontalOverflow();
    this.applyFitToWidth(anchor);
  }

  private computeFitToWidthPercent(): number {
    const paneWidth = this.pane.clientWidth;
    if (paneWidth <= 0) return FALLBACK_ZOOM_PERCENT;
    let maxPageWidth = 0;
    for (const dims of this.pageDimensions.values()) {
      if (dims.width > maxPageWidth) maxPageWidth = dims.width;
    }
    if (maxPageWidth <= 0) return FALLBACK_ZOOM_PERCENT;
    const availableWidth = paneWidth - FIT_PADDING_PX;
    return Math.max(10, Math.floor((availableWidth / maxPageWidth) * 100));
  }

  private applyFitToWidth(anchor?: PreviewViewportAnchor | null): void {
    const percent = this.computeFitToWidthPercent();
    if (percent === this.previewZoomPercent) {
      if (anchor) this.restoreScrollAnchor(anchor, true);
      return;
    }
    this.setZoom(percent, anchor);
  }

  private setZoom(percent: number, preservedAnchor?: PreviewViewportAnchor | null): number {
    this.hideDraftImagePopover();
    if (percent === this.previewZoomPercent) return percent;
    this.zoomStartedAt = performance.now();
    const anchor = preservedAnchor ?? this.captureScrollAnchor();
    this.updateHorizontalOverflow();
    this.previewZoomPercent = percent;
    this.onZoomChanged?.(percent);
    this.cancelAllPageRenders();
    this.layoutPageSlots({ preserveExistingPages: true });
    this.restoreScrollAnchor(anchor);
    requestAnimationFrame(() => this.renderVisiblePages());
    return percent;
  }

  private updateHorizontalOverflow(): void {
    const doc = this.iframe?.contentDocument;
    if (!doc?.body) return;
    doc.body.style.overflowX = this.isFitToWidth ? "hidden" : "auto";
    doc.body.style.overscrollBehaviorX = this.isFitToWidth ? "none" : "auto";
    if (this.isFitToWidth) {
      doc.body.scrollLeft = 0;
      doc.documentElement.scrollLeft = 0;
    }
  }

  public async loadPdfBytes(
    source: Uint8Array | ArrayBuffer | Promise<Uint8Array | ArrayBuffer>,
    identity = "compiler-pdf",
    sessionKey = identity,
    surface: PreviewSurface = "live",
  ): Promise<void> {
    await this.loadPdfSource({ kind: "bytes", source }, identity, sessionKey, surface);
  }

  public async loadPdfPath(
    path: string,
    identity = path,
    sessionKey = identity,
    surface: PreviewSurface = "live",
    deleteOnClose = false,
  ): Promise<number> {
    return this.loadPdfSource({ kind: "range", path, deleteOnClose }, identity, sessionKey, surface);
  }

  private async loadPdfSource(
    source: PreviewPdfSource,
    identity: string,
    sessionKey: string,
    surface: PreviewSurface,
  ): Promise<number> {
    this.hideDraftImagePopover();
    const startedAt = performance.now();
    const generation = ++this.pdfGeneration;
    this.pdfOutlineDestinations = [];
    if (surface === "live") this.onDocumentOutline?.([]);
    const obsoleteLoadingTask = this.pendingPdfLoadingTask;
    this.pendingPdfLoadingTask = null;
    if (obsoleteLoadingTask) void obsoleteLoadingTask.destroy().catch(() => {});
    const restoringSavedPosition = this.pendingRestoredScrollTop !== null;
    const previousScrollTop = restoringSavedPosition
      ? this.pendingRestoredScrollTop!
      : this.captureScrollPosition();
    this.clearErrorOverlay();

    const iframe = await this.ensureIframe();
    if (generation !== this.pdfGeneration) return 0;
    const iframeDoc = iframe.contentDocument;
    if (!iframeDoc) throw new Error("PDF preview document is unavailable.");
    iframe.dataset.previewSurface = surface;
    iframeDoc.documentElement.dataset.previewSurface = surface;

    let nextPdfDoc: any = null;
    let nextLoadingTask: PdfLoadingHandle | null = null;
    let orphanedRangeSourceCleanup: (() => Promise<void>) | null = null;
    let pdfByteLength = 0;
    const transportStats: PdfTransportStats = {
      transport: source.kind === "range" ? "range" : "full-buffer",
      bytesRead: 0,
      rangeRequests: 0
    };
    try {
      const pdfjs = await this.pdfJs();
      if (generation !== this.pdfGeneration) return 0;
      if (!this.pdfWorker || this.pdfWorker.destroyed) {
        this.pdfWorker = pdfjs.PDFWorker.create({ name: "typsastra-preview" });
      }
      let pdfInput: { data: Uint8Array } | {
        range: InstanceType<typeof pdfjs.PDFDataRangeTransport>;
        disableStream: true;
        disableAutoFetch: false;
        rangeChunkSize: number;
      };
      let closeRangeSource: (() => Promise<void>) | null = null;
      if (source.kind === "bytes") {
        const resolved = await source.source;
        if (generation !== this.pdfGeneration) return 0;
        const bytes = resolved instanceof Uint8Array ? resolved : new Uint8Array(resolved);
        pdfByteLength = bytes.byteLength;
        transportStats.bytesRead = pdfByteLength;
        pdfInput = { data: bytes };
      } else {
        const opened = await invoke<PdfRangeSourceInfo>("open_pdf_range_source", {
          path: source.path,
          deleteOnClose: source.deleteOnClose
        });
        if (generation !== this.pdfGeneration) {
          await invoke("close_pdf_range_source", { sourceId: opened.sourceId }).catch(() => {});
          return 0;
        }
        pdfByteLength = opened.length;
        let closed = false;
        closeRangeSource = async () => {
          if (closed) return;
          closed = true;
          await invoke("close_pdf_range_source", { sourceId: opened.sourceId }).catch(() => {});
        };
        orphanedRangeSourceCleanup = closeRangeSource;
        const thisFrame = this;
        const RangeTransport = class extends pdfjs.PDFDataRangeTransport {
          private aborted = false;

          constructor() {
            super(opened.length, null, false);
          }

          public requestDataRange(begin: number, end: number): void {
            if (this.aborted) return;
            transportStats.rangeRequests += 1;
            void invoke<ArrayBuffer | Uint8Array | number[]>("read_pdf_range", {
              sourceId: opened.sourceId,
              begin,
              end
            }).then(response => {
              if (this.aborted) return;
              const bytes = response instanceof Uint8Array
                ? response
                : response instanceof ArrayBuffer
                  ? new Uint8Array(response)
                  : new Uint8Array(response);
              transportStats.bytesRead += bytes.byteLength;
              if (generation === thisFrame.pdfGeneration && thisFrame.currentPdfTransport === "range") {
                thisFrame.currentPdfBytesRead = transportStats.bytesRead;
                thisFrame.currentPdfRangeRequests = transportStats.rangeRequests;
              }
              this.onDataRange(begin, bytes);
            }).catch(error => {
              if (this.aborted) return;
              console.error("PDF range request failed:", error);
              this.onDataRange(begin, null);
              this.abort();
            });
          }

          public abort(): void {
            if (this.aborted) return;
            this.aborted = true;
            void closeRangeSource?.();
          }
        };
        pdfInput = {
          range: new RangeTransport(),
          disableStream: true,
          // Keep filling the PDF worker's bounded range cache in the
          // background. Fast scrollbar jumps can then render from worker
          // memory instead of waiting for several post-release IPC reads.
          disableAutoFetch: false,
          rangeChunkSize: LOCAL_PDF_RANGE_CHUNK_SIZE
        };
      }
      await this.onLoadStage?.("source ready", {
        transport: transportStats.transport,
        pdfBytes: pdfByteLength,
        bytesRead: transportStats.bytesRead,
        rangeRequests: transportStats.rangeRequests
      });
      const loadingTask = pdfjs.getDocument({
        ...pdfInput,
        worker: this.pdfWorker as InstanceType<typeof pdfjs.PDFWorker>,
        ownerDocument: iframeDoc,
        // Browser FontFace rendering is substantially faster than rebuilding
        // every embedded glyph from PDF path primitives. Page and document
        // disposal below bound the lifetime of these resources.
        disableFontFace: false,
        useSystemFonts: false,
        enableHWA: true,
        cMapUrl: "/cmaps/",
        cMapPacked: true,
        standardFontDataUrl: "/standard_fonts/",
        // PDF.js decodes JBIG2 and CCITT Fax image layers through the same
        // packaged decoder. Scanner-generated MRC PDFs commonly store their
        // text as a CCITT foreground mask over a low-resolution background;
        // without these assets PDF.js can display only the washed-out base.
        wasmUrl: "/pdfjs-wasm/",
        // Keep binary asset loading on the window side of the worker bridge.
        // Besides matching the previous CMap/font behavior, this avoids making
        // Tauri's custom application protocol directly fetchable by a worker.
        useWorkerFetch: false
      });
      nextLoadingTask = pdfLoadingHandle(
        loadingTask as unknown as PdfLoadingHandle,
        closeRangeSource
      );
      orphanedRangeSourceCleanup = null;
      this.pendingPdfLoadingTask = nextLoadingTask;
      const pdfDoc = await loadingTask.promise;
      nextPdfDoc = pdfDoc;
      await this.onLoadStage?.("document opened", {
        transport: transportStats.transport,
        pdfBytes: pdfByteLength,
        bytesRead: transportStats.bytesRead,
        rangeRequests: transportStats.rangeRequests,
        pageCount: pdfDoc.numPages
      });
      if (generation !== this.pdfGeneration) {
        await (pdfDoc as any).destroy();
        return 0;
      }
      const nextDimensions = await readInitialPdfPageDimensions(pdfDoc);
      await this.onLoadStage?.("initial geometry ready", {
        transport: transportStats.transport,
        pdfBytes: pdfByteLength,
        bytesRead: transportStats.bytesRead,
        rangeRequests: transportStats.rangeRequests,
        pageCount: pdfDoc.numPages
      });
      if (generation !== this.pdfGeneration) {
        await (pdfDoc as any).destroy();
        return 0;
      }

      const oldPdfDoc = this.pdfDoc;
      const oldLoadingTask = this.pdfLoadingTask;
      this.observer?.disconnect();
      this.observer = null;
      this.cancelAllPageRenders();
      nextPdfDoc = null;
      this.pdfDoc = pdfDoc;
      this.pdfLoadingTask = nextLoadingTask;
      nextLoadingTask = null;
      this.pendingPdfLoadingTask = null;
      this.pageDimensions = nextDimensions;
      // PDF.js transfers this buffer to its worker, detaching it after load.
      this.currentPdfBytes = pdfByteLength;
      this.currentPdfBytesRead = transportStats.bytesRead;
      this.currentPdfRangeRequests = transportStats.rangeRequests;
      this.currentPdfTransport = transportStats.transport;
      this.mountedUrl = identity;
      this.mountedSessionKey = sessionKey;
      if (this.isFitToWidth) this.previewZoomPercent = this.computeFitToWidthPercent();
      this.createPageSlots(iframeDoc, true);
      this.updateHorizontalOverflow();
      this.setupIframeInteractions();
      this.installPageObserver(iframe);
      this.restoreScrollPosition(previousScrollTop);
      await this.onLoadStage?.("viewer installed", {
        transport: transportStats.transport,
        pdfBytes: pdfByteLength,
        bytesRead: transportStats.bytesRead,
        rangeRequests: transportStats.rangeRequests,
        pageCount: pdfDoc.numPages
      });
      if (restoringSavedPosition) this.pendingRestoredScrollTop = null;
      this.reportPageStatus(this.visiblePageNumber());
      if (surface === "live" && this.onDocumentOutline) {
        void this.readDocumentOutline(pdfDoc, generation).then(items => {
          if (generation === this.pdfGeneration && this.pdfDoc === pdfDoc) {
            this.onDocumentOutline?.(items);
          }
        }).catch(error => {
          if (generation === this.pdfGeneration && this.pdfDoc === pdfDoc) {
            console.warn("Failed to read PDF outline destinations:", error);
          }
        });
      }
      void this.hydratePageDimensions(pdfDoc, generation).catch(error => {
        if (generation === this.pdfGeneration && this.pdfDoc === pdfDoc) {
          console.warn("Failed to finish PDF page geometry discovery:", error);
        }
      });
      this.reportInteractionStatus({ kind: "installed", url: identity });
      this.onPerformance?.({
        name: "preview.load",
        milliseconds: performance.now() - startedAt,
        detail: {
          pageCount: pdfDoc.numPages,
          pdfBytes: pdfByteLength,
          transport: transportStats.transport,
          bytesRead: transportStats.bytesRead,
          rangeRequests: transportStats.rangeRequests
        }
      });
      // The replacement is already installed. Release the previous PDF during
      // browser idle time so resource disposal and GC do not contend with a
      // pane drag or the first interaction with the new preview.
      this.schedulePdfResourceCleanup(oldPdfDoc, oldLoadingTask);
    } catch (error) {
      if (generation !== this.pdfGeneration) return 0;
      this.setError("PDF Loading Failed", String(error));
    } finally {
      if (this.pendingPdfLoadingTask === nextLoadingTask) this.pendingPdfLoadingTask = null;
      if (nextPdfDoc) {
        try { await nextPdfDoc.destroy(); } catch {}
      }
      if (nextLoadingTask) {
        try { await nextLoadingTask.destroy(); } catch {}
      } else if (orphanedRangeSourceCleanup) {
        await orphanedRangeSourceCleanup();
      }
    }
    return pdfByteLength;
  }

  private async readDocumentOutline(pdfDoc: any, generation: number): Promise<PreviewOutlineItem[]> {
    const outline = await pdfDoc.getOutline();
    if (!Array.isArray(outline) || generation !== this.pdfGeneration) return [];
    const destinations: unknown[] = [];

    const convert = async (item: any): Promise<PreviewOutlineItem> => {
      const bookmarkIndex = destinations.length;
      destinations.push(item?.dest);
      const children = Array.isArray(item?.items)
        ? await Promise.all(item.items.map((child: unknown) => convert(child)))
        : [];
      return {
        title: typeof item?.title === "string" ? item.title : "",
        bookmarkIndex,
        children,
      };
    };

    const items = await Promise.all(outline.map((item: unknown) => convert(item)));
    if (generation === this.pdfGeneration && this.pdfDoc === pdfDoc) {
      this.pdfOutlineDestinations = destinations;
    }
    return items;
  }

  private async pdfJs(): Promise<PdfJsModule> {
    if (!this.pdfJsPromise) {
      this.pdfJsPromise = Promise.all([
        import("pdfjs-dist"),
        import("pdfjs-dist/build/pdf.worker.min.mjs?url")
      ]).then(([pdfjs, worker]) => {
        pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
        return pdfjs;
      });
    }
    return this.pdfJsPromise;
  }

  private async ensureIframe(): Promise<HTMLIFrameElement> {
    if (this.iframe?.contentDocument?.getElementById("viewer-container")) return this.iframe;
    this.previewPointerInside = false;
    if (this.iframe) {
      releaseCanvasResources(this.iframe.contentDocument?.documentElement ?? null);
      this.iframe.remove();
      this.pageSlots = [];
    }
    const iframe = document.createElement("iframe");
    iframe.className = "preview-frame";
    iframe.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><style>
      :root{--preview-ui-bg:#fcfcfc;--preview-ui-header:#616161;--preview-ui-accent:${TYPSASTRA_GREEN};--preview-surface-bg:#fff;--scrollbar-track:transparent;--scrollbar-thumb:color-mix(in srgb,var(--preview-ui-header) 62%,var(--preview-ui-bg));--scrollbar-hover:color-mix(in srgb,var(--preview-ui-accent) 72%,var(--preview-ui-header))}
      :root[data-preview-surface="pdf"]{--preview-surface-bg:#b8b8b8}
      @supports not selector(::-webkit-scrollbar){html,body{scrollbar-color:var(--scrollbar-thumb) var(--scrollbar-track);scrollbar-width:auto}}
      body::-webkit-scrollbar{width:15px;height:15px}
      body::-webkit-scrollbar-track{background:transparent}
      body::-webkit-scrollbar-thumb{min-width:32px;min-height:32px;background:var(--scrollbar-thumb);background-clip:padding-box;border:1px solid transparent;border-radius:0}
      body::-webkit-scrollbar-thumb:hover,body::-webkit-scrollbar-thumb:active{background:var(--scrollbar-hover);background-clip:padding-box}
      body::-webkit-scrollbar-corner{background:transparent}
      body::-webkit-scrollbar-button{display:none;width:0;height:0}
      html,body{margin:0;width:100%;height:100%;background:var(--preview-surface-bg)}
      body{overflow:auto;font-family:sans-serif}
      #viewer-container{box-sizing:border-box;min-width:100%;width:max-content;padding:20px;display:flex;flex-direction:column;gap:20px}
      .pdf-page-container{position:relative;box-sizing:border-box;flex:none;margin:0 auto;background:#fff;box-shadow:0 2px 10px rgba(0,0,0,.25);overflow:hidden}
      .pdf-page-canvas{position:absolute;inset:0;display:block;width:100%;height:100%}
      .pdf-page-canvas-dark{display:none}
      :root[data-preview-color-mode="dark"]{--preview-surface-bg:#17191c}
      :root[data-preview-color-mode="dark"] .pdf-page-container{background:#191b1f;box-shadow:0 2px 12px rgba(0,0,0,.55)}
      :root[data-preview-color-mode="dark"] .pdf-page-canvas-original{display:none}
      :root[data-preview-color-mode="dark"] .pdf-page-canvas-dark{display:block}
      :root[data-preview-color-mode="inverted"]{--preview-surface-bg:#151515}
      :root[data-preview-color-mode="inverted"] .pdf-page-container{background:#000;box-shadow:0 2px 12px rgba(0,0,0,.6)}
      :root[data-preview-color-mode="inverted"] .pdf-page-canvas-original{filter:invert(1)}
      .forward-sync-ripple{position:fixed;z-index:2147483647;box-sizing:border-box;width:18px;height:18px;margin:-9px 0 0 -9px;border:2px solid ${TYPSASTRA_GREEN};border-radius:999px;background:${TYPSASTRA_GREEN_RIPPLE_FILL};box-shadow:0 0 0 0 ${TYPSASTRA_GREEN_RIPPLE_SHADOW};pointer-events:none;animation:typsastra-forward-ripple 900ms ease-out forwards}
      @keyframes typsastra-forward-ripple{0%{opacity:0;transform:scale(.55);box-shadow:0 0 0 0 rgba(61,180,137,.38)}12%{opacity:1}100%{opacity:0;transform:scale(3.1);box-shadow:0 0 0 14px rgba(61,180,137,0)}}
      .annotation-link{position:absolute;display:block;box-sizing:border-box;cursor:default;text-decoration:none}
      .preview-link-modifier .annotation-link.internal-reference{cursor:pointer;background:color-mix(in srgb,var(--preview-ui-accent) 15%,transparent);box-shadow:inset 3px 0 color-mix(in srgb,var(--preview-ui-accent) 88%,var(--preview-ui-header))}
      .preview-link-modifier .annotation-link.external-link{cursor:pointer;outline:2px dashed color-mix(in srgb,var(--preview-ui-accent) 78%,var(--preview-ui-header));outline-offset:-2px;background:color-mix(in srgb,var(--preview-ui-accent) 34%,transparent)}
      .preview-link-modifier .annotation-link.internal-reference:hover{outline:2px solid color-mix(in srgb,var(--preview-ui-accent) 88%,var(--preview-ui-header));outline-offset:-2px;background:color-mix(in srgb,var(--preview-ui-accent) 34%,transparent)}
      .preview-link-modifier .annotation-link.external-link:hover{background:color-mix(in srgb,var(--preview-ui-accent) 42%,transparent)}
      .annotation-link.draft-image-link{cursor:zoom-in;background:transparent}
      .annotation-link.draft-image-link:hover,.annotation-link.draft-image-link:focus-visible{outline:2px solid color-mix(in srgb,var(--preview-ui-accent) 72%,transparent);outline-offset:-2px;background:color-mix(in srgb,var(--preview-ui-accent) 7%,transparent)}
      .draft-image-popover{position:fixed;z-index:2147483646;box-sizing:border-box;max-width:min(340px,calc(100vw - 16px));max-height:min(300px,calc(100vh - 16px));padding:8px;border:1px solid var(--preview-ui-header);background:var(--preview-ui-bg);color:var(--preview-ui-header);box-shadow:0 8px 28px rgba(0,0,0,.35);pointer-events:none}
      .draft-image-popover img{display:block;max-width:min(320px,calc(100vw - 32px));max-height:min(240px,calc(100vh - 58px));object-fit:contain}
      .draft-image-popover-label{padding-top:6px;max-width:min(320px,calc(100vw - 32px));overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}
      #preview-go-first{position:fixed;right:26px;bottom:18px;z-index:2147483645;box-sizing:border-box;display:grid;place-items:center;width:38px;height:38px;padding:0;border:1px solid color-mix(in srgb,var(--preview-ui-header) 55%,transparent);border-radius:50%;background:color-mix(in srgb,var(--preview-ui-bg) 92%,transparent);color:var(--preview-ui-header);box-shadow:0 4px 14px rgba(0,0,0,.28);cursor:pointer;opacity:0;visibility:hidden;pointer-events:none;transform:translateY(5px);transition:opacity 120ms ease,transform 120ms ease,visibility 0s linear 120ms}
      #preview-go-first svg{display:block;width:22px;height:22px;overflow:visible;stroke:currentColor;stroke-width:2.4;stroke-linecap:round;stroke-linejoin:round;fill:none}
      #preview-go-first.is-visible{opacity:1;visibility:visible;pointer-events:auto;transform:translateY(0);transition-delay:0s}
      #preview-go-first:hover,#preview-go-first:focus-visible{border-color:var(--preview-ui-accent);color:var(--preview-ui-accent);outline:2px solid color-mix(in srgb,var(--preview-ui-accent) 35%,transparent);outline-offset:2px}
      @media (prefers-reduced-motion:reduce){#preview-go-first{transition:none}}
      ::selection{background:rgba(0,120,215,.35)}
    </style></head><body><div id="viewer-container"></div><button id="preview-go-first" type="button" title="Go to first page" aria-label="Go to first page" aria-hidden="true" tabindex="-1"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20V4M5.5 10.5 12 4l6.5 6.5"/></svg></button></body></html>`;
    iframe.addEventListener("load", () => this.setupIframeInteractions());
    const loaded = new Promise<void>(resolve => iframe.addEventListener("load", () => resolve(), { once: true }));
    this.pane.appendChild(iframe);
    this.iframe = iframe;
    await loaded;
    this.updateHorizontalOverflow();
    this.setupIframeInteractions();
    return iframe;
  }

  private createPageSlots(doc: Document, preserveExistingPages = false): void {
    const viewer = doc.getElementById("viewer-container");
    if (!viewer || !this.pdfDoc) return;
    if (!preserveExistingPages) {
      replaceElementChildren(viewer);
    }
    for (let pageNo = 1; pageNo <= this.pdfDoc.numPages; pageNo += 1) {
      let slot = viewer.querySelector<HTMLElement>(`:scope > .pdf-page-container[data-page-no="${pageNo}"]`);
      if (!slot) {
        slot = doc.createElement("div");
        slot.className = "pdf-page-container";
        slot.dataset.pageNo = String(pageNo);
        viewer.appendChild(slot);
      }
    }
    for (const slot of [...viewer.querySelectorAll<HTMLElement>(":scope > .pdf-page-container")]) {
      const pageNo = Number(slot.dataset.pageNo);
      if (pageNo > this.pdfDoc.numPages) {
        releaseCanvasResources(slot);
        slot.remove();
      }
    }
    this.pageSlots = [...viewer.querySelectorAll<HTMLElement>(":scope > .pdf-page-container")];
    this.layoutPageSlots({ preserveExistingPages });
  }

  private layoutPageSlots(options: { preserveExistingPages?: boolean } = {}): void {
    const doc = this.iframe?.contentDocument;
    if (!doc) return;
    const zoom = this.previewZoomPercent / 100;
    for (const slot of doc.querySelectorAll<HTMLElement>(".pdf-page-container")) {
      const pageNo = Number(slot.dataset.pageNo);
      const dimensions = this.pageDimensions.get(pageNo);
      if (!dimensions) continue;
      slot.style.width = `${dimensions.width * zoom}px`;
      slot.style.height = `${dimensions.height * zoom}px`;
      if (!options.preserveExistingPages) {
        replaceElementChildren(slot);
        delete slot.dataset.renderKey;
      }
    }
  }

  private async hydratePageDimensions(pdfDoc: any, generation: number): Promise<void> {
    const startedAt = performance.now();
    let widerPageFound = false;
    const initialMaxWidth = [...this.pageDimensions.values()]
      .reduce((maximum, dimensions) => Math.max(maximum, dimensions.width), 0);
    for (let pageNo = 2; pageNo <= pdfDoc.numPages; pageNo += 1) {
      await this.waitForScrollingToStop(pdfDoc, generation);
      if (generation !== this.pdfGeneration || this.pdfDoc !== pdfDoc) return;
      const page = await pdfDoc.getPage(pageNo);
      if (generation !== this.pdfGeneration || this.pdfDoc !== pdfDoc) {
        page.cleanup();
        return;
      }
      const viewport = page.getViewport({ scale: 1 });
      const dimensions = { width: viewport.width, height: viewport.height };
      const previous = this.pageDimensions.get(pageNo);
      if (pageDimensionsChanged(previous, dimensions)) {
        this.pageDimensions.set(pageNo, dimensions);
        this.updatePageSlotDimensions(pageNo, dimensions);
        widerPageFound ||= dimensions.width > initialMaxWidth;
      }
      if (!this.activeRenders.has(pageNo)) page.cleanup();
      if (pageNo % 8 === 0) {
        await nextTurn();
        await this.waitForScrollingToStop(pdfDoc, generation);
      }
    }
    if (generation !== this.pdfGeneration || this.pdfDoc !== pdfDoc) return;
    if (widerPageFound && this.isFitToWidth) this.applyFitToWidth();
    this.onPerformance?.({
      name: "preview.geometry",
      milliseconds: performance.now() - startedAt,
      detail: { pageCount: pdfDoc.numPages }
    });
  }

  private async waitForScrollingToStop(pdfDoc: any, generation: number): Promise<void> {
    while (this.motion.current().state !== "idle" && generation === this.pdfGeneration && this.pdfDoc === pdfDoc) {
      await delay(16);
    }
  }

  private updatePageSlotDimensions(pageNo: number, dimensions: PageDimensions): void {
    const slot = this.iframe?.contentDocument
      ?.querySelector<HTMLElement>(`.pdf-page-container[data-page-no="${pageNo}"]`);
    if (!slot) return;
    const zoom = this.previewZoomPercent / 100;
    slot.style.width = `${dimensions.width * zoom}px`;
    slot.style.height = `${dimensions.height * zoom}px`;
  }

  private installPageObserver(iframe: HTMLIFrameElement): void {
    this.observer?.disconnect();
    const doc = iframe.contentDocument;
    const Observer = (iframe.contentWindow as unknown as { IntersectionObserver: typeof IntersectionObserver }).IntersectionObserver;
    if (!doc || !Observer) return;
    this.observer = new Observer(entries => {
      for (const entry of entries) {
        const pageNo = Number((entry.target as HTMLElement).dataset.pageNo);
        if (entry.isIntersecting) this.queuePageRender(pageNo, 2, "directional-neighbor");
      }
    }, { root: null, rootMargin: "1000px 0px 1000px 0px", threshold: 0 });
    this.pageSlots.forEach(slot => this.observer?.observe(slot));
  }

  private renderVisiblePages(): void {
    const doc = this.iframe?.contentDocument;
    if (!doc) return;
    const viewportHeight = this.iframe?.clientHeight ?? 0;
    for (const slot of doc.querySelectorAll<HTMLElement>(".pdf-page-container")) {
      const rect = slot.getBoundingClientRect();
      if (rect.bottom >= -1000 && rect.top <= viewportHeight + 1000) {
        this.queuePageRender(Number(slot.dataset.pageNo), 2, "directional-neighbor");
      }
    }
  }

  private queuePageRender(
    pageNo: number,
    priority = 2,
    reason: PreviewRenderReason = "directional-neighbor"
  ): void {
    if (!Number.isFinite(pageNo) || pageNo < 1 || pageNo > Number(this.pdfDoc?.numPages ?? 0)) return;
    const slot = this.iframe?.contentDocument
      ?.querySelector<HTMLElement>(`.pdf-page-container[data-page-no="${pageNo}"]`);
    if (!slot) return;
    if (slot.dataset.renderKey === this.currentPageRenderKey(this.pdfGeneration)) return;
    if (this.activeRenders.has(pageNo) && reason !== "settled-visible") return;
    const result = this.renderScheduler.enqueue({
      generation: this.pdfGeneration,
      pageNo,
      priority,
      reason
    });
    if (result === "promoted") this.recordEvent("preview.render-promote", { pageNo });
    const motion = this.motion.current();
    if (motion.state !== "moving" || reason === "decelerating-destination") {
      void this.pumpPageRenderQueue();
    }
  }

  private pumpPageRenderQueue(): void {
    if (this.renderDispatching) return;
    this.renderDispatching = true;
    try {
      while (this.activeRenderLanes < this.renderLaneLimit() && this.renderScheduler.size > 0) {
        const motion = this.motion.current();
        const request = this.renderScheduler.take(candidate => {
          if (this.activeRenders.has(candidate.pageNo)) return false;
          if (motion.state === "moving") {
            return motion.shouldPreRender && candidate.reason === "decelerating-destination";
          }
          return motion.state !== "settling"
            || candidate.reason === "decelerating-destination"
            || candidate.reason === "settled-visible";
        });
        if (!request) break;
        this.activeRenderLanes += 1;
        void this.renderPage(request).finally(() => {
          this.activeRenderLanes = Math.max(0, this.activeRenderLanes - 1);
          void nextTurn().then(() => this.pumpPageRenderQueue());
        });
      }
    } finally {
      this.renderDispatching = false;
    }
  }

  private renderLaneLimit(): number {
    return this.motion.current().state === "moving" ? 1 : 2;
  }

  private deferPageRenderingDuringScroll(): void {
    const startedAt = performance.now();
    const view = this.iframe?.contentWindow;
    if (!view) return;
    if (this.instantScrollTargetPage !== null) {
      const pageNo = this.instantScrollTargetPage;
      this.instantScrollTargetPage = null;
      this.finishInstantPageJump(pageNo);
      return;
    }
    const wasIdle = this.motion.current().state === "idle";
    const snapshot = this.motion.noteScroll(view.scrollY, startedAt);
    if (wasIdle) {
      this.motionStartedAt = startedAt;
      this.finalDecisionAt = null;
    }
    this.renderScheduler.removeReason("decelerating-destination");
    this.renderScheduler.removeReason("settled-visible");
    this.renderScheduler.removeReason("directional-neighbor");
    const visiblePage = this.visiblePageNumber();
    this.reportPageStatus(visiblePage);
    this.motionDestinationPage = snapshot.shouldPreRender
      ? this.pageNumberAtScrollTop(snapshot.projectedScrollTop)
      : visiblePage;
    this.cancelDistantPageRenders(this.motionDestinationPage, 2);
    if (snapshot.shouldPreRender) {
      this.recordEvent("preview.deceleration-prerender", {
        visiblePage,
        projectedPage: this.motionDestinationPage,
        velocity: Math.round(snapshot.velocity * 1000) / 1000,
        acceleration: Math.round(snapshot.acceleration * 10000) / 10000,
        samples: snapshot.deceleratingSamples
      });
      this.queuePageRender(this.motionDestinationPage, 0, "decelerating-destination");
    }
    if (this.motionFrame === null) this.motionFrame = requestAnimationFrame(timestamp => this.samplePreviewMotion(timestamp));
    this.recordMetric("preview.motion-handler", performance.now() - startedAt, {
      pageNo: this.motionDestinationPage,
      velocity: Math.round(snapshot.velocity * 1000) / 1000
    });
  }

  private samplePreviewMotion(timestamp: number): void {
    this.motionFrame = null;
    const view = this.iframe?.contentWindow;
    if (!view) return;
    const snapshot = this.motion.sampleFrame(view.scrollY, timestamp);
    this.motionDestinationPage = snapshot.shouldPreRender
      ? this.pageNumberAtScrollTop(snapshot.projectedScrollTop)
      : this.visiblePageNumber();
    if (snapshot.firstStableFrame) {
      const settledAt = performance.now();
      if (this.motionStartedAt !== null) {
        this.recordMetric("preview.motion-settle", settledAt - this.motionStartedAt, {
          pageNo: this.motionDestinationPage
        });
      }
      const destinationAlreadyFinal = this.iframe?.contentDocument
        ?.querySelector<HTMLElement>(`.pdf-page-container[data-page-no="${this.motionDestinationPage}"]`)
        ?.dataset.renderKey === this.currentPageRenderKey(this.pdfGeneration);
      this.finalDecisionAt = destinationAlreadyFinal ? null : settledAt;
      this.queueViewportFinalRenders("first-stable");
      this.retargetDraftHoverAtPointer();
    }
    if (snapshot.becameIdle) {
      this.queueViewportFinalRenders("idle-confirmation");
      this.motionStartedAt = null;
      void this.pumpPageRenderQueue();
      return;
    }
    this.motionFrame = requestAnimationFrame(nextTimestamp => this.samplePreviewMotion(nextTimestamp));
  }

  private queueViewportFinalRenders(trigger: "first-stable" | "idle-confirmation"): void {
    const visiblePages = this.viewportPageNumbers();
    this.recordEvent("preview.destination-final-queue", {
      pageNo: this.motionDestinationPage,
      visiblePages: visiblePages.length,
      trigger
    });
    for (const pageNo of visiblePages) {
      this.queuePageRender(
        pageNo,
        pageNo === this.motionDestinationPage ? 0 : 1,
        "settled-visible"
      );
    }
  }

  private visiblePageNumber(): number {
    return this.pageNumberAtScrollTop(this.iframe?.contentWindow?.scrollY ?? 0);
  }

  private pageNumberAtScrollTop(scrollTop: number): number {
    if (this.pageSlots.length === 0) return 1;
    const view = this.iframe?.contentWindow;
    const target = scrollTop + (view?.innerHeight ?? this.iframe?.clientHeight ?? 0) / 2;
    let low = 0;
    let high = this.pageSlots.length - 1;
    while (low <= high) {
      const middle = (low + high) >>> 1;
      const slot = this.pageSlots[middle];
      const top = slot.offsetTop;
      const bottom = top + slot.offsetHeight;
      if (target < top) high = middle - 1;
      else if (target > bottom) low = middle + 1;
      else return Number(slot.dataset.pageNo) || middle + 1;
    }
    const candidates = [high, low]
      .filter(index => index >= 0 && index < this.pageSlots.length)
      .map(index => {
        const slot = this.pageSlots[index];
        return {
          pageNo: Number(slot.dataset.pageNo) || index + 1,
          distance: Math.abs(slot.offsetTop + slot.offsetHeight / 2 - target)
        };
      })
      .sort((left, right) => left.distance - right.distance);
    return candidates[0]?.pageNo ?? 1;
  }

  private viewportPageNumbers(): number[] {
    if (this.pageSlots.length === 0) return [];
    const view = this.iframe?.contentWindow;
    const viewportTop = view?.scrollY ?? 0;
    const viewportHeight = view?.innerHeight ?? this.iframe?.clientHeight ?? 0;
    return visiblePageIndexes(
      this.pageSlots.length,
      index => this.pageSlots[index].offsetTop,
      index => this.pageSlots[index].offsetHeight,
      viewportTop,
      viewportHeight
    ).map(index => Number(this.pageSlots[index].dataset.pageNo) || index + 1);
  }

  private async renderPage(request: PreviewRenderRequest): Promise<void> {
    const { pageNo, generation } = request;
    if (!this.pdfDoc || generation !== this.pdfGeneration || this.activeRenders.has(pageNo)) return;
    const doc = this.iframe?.contentDocument;
    const slot = doc?.querySelector<HTMLElement>(`.pdf-page-container[data-page-no="${pageNo}"]`);
    if (!doc || !slot) return;
    const renderKey = this.currentPageRenderKey(generation);
    if (slot.dataset.renderKey === renderKey) return;

    const active: ActivePageRender = {
      generation,
      renderKey,
      task: null,
      page: null,
      canvas: null,
      canvasCommitted: false
    };
    const startedAt = performance.now();
    this.activeRenders.set(pageNo, active);
    try {
      const page = await this.pdfDoc.getPage(pageNo);
      active.page = page;
      this.pageRenderOwnership.retain(page);
      if (!this.renderIsCurrent(pageNo, active, slot)) return;

      const cssScale = this.previewZoomPercent / 100;
      const cssViewport = page.getViewport({ scale: cssScale });
      const outputScale = Math.min(window.devicePixelRatio || 1, MAX_OUTPUT_SCALE);
      const renderViewport = page.getViewport({ scale: cssScale * outputScale });
      const canvas = doc.createElement("canvas");
      active.canvas = canvas;
      canvas.className = "pdf-page-canvas pdf-page-canvas-original";
      canvas.width = Math.max(1, Math.floor(renderViewport.width));
      canvas.height = Math.max(1, Math.floor(renderViewport.height));

      const task = page.render({ canvas, viewport: renderViewport, recordImages: true });
      active.task = task;
      const canvasStartedAt = performance.now();
      await task.promise;
      active.task = null;
      if (!this.renderIsCurrent(pageNo, active, slot)) return;
      const imageCoordinates = task.imageCoordinates ?? page.imageCoordinates;
      if (imageCoordinates) this.pageImageCoordinates.set(canvas, [...imageCoordinates]);
      this.onPerformance?.({
        name: "preview.canvas-render",
        milliseconds: performance.now() - canvasStartedAt,
        detail: { pageNo, zoomPercent: this.previewZoomPercent }
      });
      this.commitFinalCanvas(slot, canvas);
      active.canvasCommitted = true;
      slot.dataset.renderKey = renderKey;
      // Keep the shared loading presentation visible until PDF.js has
      // produced an actual page. Installing page slots alone would expose a
      // blank viewer while the first visible canvas is still rendering.
      this.clearLoadingHost();

      const annotationStartedAt = performance.now();
      const annotationLinks = await this.renderAnnotationLinks(page, cssViewport, doc);
      if (!this.renderIsCurrent(pageNo, active, slot)) return;
      this.onPerformance?.({
        name: "preview.annotation-layer",
        milliseconds: performance.now() - annotationStartedAt,
        detail: { pageNo, linkCount: annotationLinks.length }
      });

      this.commitFinalCanvas(slot, canvas, annotationLinks);
      if (this.previewColorMode === "dark") this.installDarkCanvas(slot, canvas);
      slot.dataset.renderKey = renderKey;
      if (this.motion.current().state !== "moving") {
        this.retargetDraftHoverAtPointer();
      }
      this.trimResidentPages(pageNo);
      if (pageNo === this.motionDestinationPage && this.finalDecisionAt !== null) {
        this.recordMetric("preview.destination-final-commit", performance.now() - this.finalDecisionAt, { pageNo });
        this.finalDecisionAt = null;
      }
      const isFirstRenderedPage = this.firstRenderedGeneration !== generation;
      if (isFirstRenderedPage) this.firstRenderedGeneration = generation;
      this.onPerformance?.({
        name: isFirstRenderedPage ? "preview.first-page" : "preview.page-render",
        milliseconds: performance.now() - startedAt,
        detail: { pageNo, zoomPercent: this.previewZoomPercent, residentPages: this.renderedPageNumbers().length }
      });
      if (this.zoomStartedAt !== null) {
        this.onPerformance?.({
          name: "preview.zoom",
          milliseconds: performance.now() - this.zoomStartedAt,
          detail: { zoomPercent: this.previewZoomPercent, pageNo }
        });
        this.zoomStartedAt = null;
      }
    } catch (error) {
      if (!(error instanceof Error && error.name === "RenderingCancelledException")) {
        console.error(`Failed to render PDF page ${pageNo}:`, error);
      }
    } finally {
      if (this.activeRenders.get(pageNo) === active) this.activeRenders.delete(pageNo);
      if (active.page) this.pageRenderOwnership.release(active.page);
      if (active.canvas && !active.canvasCommitted) releaseCanvas(active.canvas);
    }
  }

  private async renderAnnotationLinks(page: any, viewport: any, doc: Document): Promise<HTMLElement[]> {
    if (typeof page?.getAnnotations !== "function") return [];
    try {
      const annotationLinks: HTMLElement[] = [];
      for (const annotation of await page.getAnnotations()) {
        const target = previewLinkTarget(annotation);
        if (!target) continue;
        const rect = viewportRectangle(viewport, annotation.rect);
        if (!rect) continue;
        const left = Math.max(0, Math.min(rect[0], rect[2]) - 3);
        const top = Math.max(0, Math.min(rect[1], rect[3]) - 2);
        const right = Math.min(Number(viewport.width), Math.max(rect[0], rect[2]) + 3);
        const bottom = Math.min(Number(viewport.height), Math.max(rect[1], rect[3]) + 2);
        const link = doc.createElement("a");
        link.className = `annotation-link ${
          target.kind === "draft-image"
            ? "draft-image-link"
            : target.kind === "external"
              ? "external-link"
              : "internal-reference"
        }`;
        link.setAttribute("role", "link");
        link.setAttribute(
          "aria-label",
          target.kind === "external"
            ? target.url
            : target.kind === "draft-image"
              ? "Draft image placeholder. Hover or focus to view the original image; click to reveal its source."
              : "PDF document link"
        );
        if (target.kind === "draft-image") link.tabIndex = 0;
        this.annotationTargets.set(link, target);
        link.style.left = `${left}px`;
        link.style.top = `${top}px`;
        link.style.width = `${right - left}px`;
        link.style.height = `${Math.max(0, bottom - top)}px`;
        annotationLinks.push(link);
      }
      return annotationLinks;
    } catch (error) {
      console.warn("Failed to render PDF annotation links:", error);
      return [];
    }
  }

  private renderIsCurrent(pageNo: number, active: ActivePageRender, slot: HTMLElement): boolean {
    return active.generation === this.pdfGeneration
      && active.renderKey === this.currentPageRenderKey(active.generation)
      && this.activeRenders.get(pageNo) === active
      && slot.isConnected;
  }

  private currentPageRenderKey(generation: number): string {
    const outputScale = Math.min(window.devicePixelRatio || 1, MAX_OUTPUT_SCALE);
    return `${generation}:${this.previewZoomPercent}:${outputScale}`;
  }

  private commitFinalCanvas(slot: HTMLElement, canvas: HTMLCanvasElement, annotations: HTMLElement[] = []): void {
    for (const child of [...slot.children]) {
      if (child === canvas) continue;
      releaseCanvasResources(child);
      child.remove();
    }
    if (!canvas.isConnected) slot.append(canvas);
    for (const annotation of annotations) slot.append(annotation);
  }

  private releaseFinalPage(pageNo: number): void {
    this.renderScheduler.remove(this.pdfGeneration, pageNo);
    const active = this.activeRenders.get(pageNo);
    if (active) {
      active.task?.cancel();
      this.recordEvent("preview.render-cancel", { pageNo });
      this.activeRenders.delete(pageNo);
    }
    const slot = this.iframe?.contentDocument
      ?.querySelector<HTMLElement>(`.pdf-page-container[data-page-no="${pageNo}"]`)
    if (!slot) return;
    for (const child of [...slot.children]) {
      releaseCanvasResources(child);
      child.remove();
    }
    delete slot.dataset.renderKey;
  }

  private renderedPageNumbers(): number[] {
    const doc = this.iframe?.contentDocument;
    if (!doc) return [];
    return [...doc.querySelectorAll<HTMLElement>(".pdf-page-container[data-render-key]")]
      .map(slot => Number(slot.dataset.pageNo))
      .filter(Number.isFinite);
  }

  private trimResidentPages(focusPage: number): void {
    const rendered = this.renderedPageNumbers();
    if (rendered.length <= PERFORMANCE_BUDGETS.maxResidentPdfPages) return;
    pagesToEvict(rendered, focusPage, PERFORMANCE_BUDGETS.maxResidentPdfPages)
      .forEach(pageNo => this.releaseFinalPage(pageNo));
  }

  private cancelAllPageRenders(): void {
    this.renderScheduler.clear();
    if (this.motionFrame !== null) cancelAnimationFrame(this.motionFrame);
    this.motionFrame = null;
    this.motion.reset(this.iframe?.contentWindow?.scrollY ?? 0, performance.now());
    this.motionStartedAt = null;
    this.finalDecisionAt = null;
    this.cancelActivePageRenders();
  }

  private cancelActivePageRenders(): void {
    for (const [pageNo, render] of this.activeRenders) {
      render.task?.cancel();
      this.recordEvent("preview.render-cancel", { pageNo });
      this.activeRenders.delete(pageNo);
    }
  }

  private cancelDistantPageRenders(focusPage: number, radius: number): void {
    for (const [pageNo, render] of this.activeRenders) {
      if (Math.abs(pageNo - focusPage) <= radius) continue;
      render.task?.cancel();
      this.recordEvent("preview.render-cancel", { pageNo });
      this.activeRenders.delete(pageNo);
    }
  }

  private recordMetric(name: PerformanceMetric["name"], milliseconds: number, detail: Record<string, string | number | boolean>): void {
    this.onPerformance?.({ name, milliseconds, detail });
  }

  private recordEvent(name: PerformanceMetric["name"], detail: Record<string, string | number | boolean>): void {
    this.onPerformance?.({ name, detail });
  }

  private async disposePdfDocument(): Promise<void> {
    this.observer?.disconnect();
    this.observer = null;
    this.cancelAllPageRenders();
    const loadingTask = this.pdfLoadingTask;
    const pendingLoadingTask = this.pendingPdfLoadingTask;
    const pdfDoc = this.pdfDoc;
    this.pdfLoadingTask = null;
    this.pendingPdfLoadingTask = null;
    this.pdfDoc = null;
    await cleanupPdfResources(pdfDoc, loadingTask);
    if (pendingLoadingTask && pendingLoadingTask !== loadingTask) {
      try { await pendingLoadingTask.destroy(); } catch {}
    }
    this.pageDimensions.clear();
    this.pageSlots = [];
    this.pdfOutlineDestinations = [];
  }

  public scrollToPage(pageNo: number): void {
    const pageCount = Number(this.pdfDoc?.numPages ?? 0);
    if (pageCount < 1 || !Number.isFinite(pageNo)) return;
    const normalizedPage = Math.max(1, Math.min(Math.round(pageNo), pageCount));
    const slot = this.iframe?.contentDocument
      ?.querySelector<HTMLElement>(`.pdf-page-container[data-page-no="${normalizedPage}"]`);
    if (!slot) return;
    this.jumpToPreviewOffset(slot.offsetTop, normalizedPage);
  }

  public async scrollToOutlineBookmark(bookmarkIndex: number): Promise<boolean> {
    const pdfDoc = this.pdfDoc;
    const generation = this.pdfGeneration;
    const rawDestination = this.pdfOutlineDestinations[bookmarkIndex];
    if (!pdfDoc || rawDestination === undefined) return false;
    try {
      const destination = typeof rawDestination === "string"
        ? await pdfDoc.getDestination(rawDestination)
        : rawDestination;
      if (generation !== this.pdfGeneration || this.pdfDoc !== pdfDoc) return false;
      const pageReference = Array.isArray(destination) ? destination[0] : null;
      if (pageReference === null || pageReference === undefined) return false;
      const pageIndex = typeof pageReference === "number"
        ? pageReference
        : await pdfDoc.getPageIndex(pageReference);
      if (generation !== this.pdfGeneration || this.pdfDoc !== pdfDoc) return false;
      if (!Number.isInteger(pageIndex) || pageIndex < 0) return false;
      this.scrollToPage(pageIndex + 1);
      return true;
    } catch {
      return false;
    }
  }

  private schedulePdfResourceCleanup(
    pdfDoc: any,
    loadingTask: { destroy(): Promise<void> } | null,
  ): void {
    if (!pdfDoc && !loadingTask) return;
    this.pdfCleanupQueue = this.pdfCleanupQueue
      .catch(() => {})
      .then(async () => {
        await waitForUiIdle();
        while (this.resizeLayoutSuspended) await delay(32);
        await cleanupPdfResources(pdfDoc, loadingTask);
      });
  }

  public async revealDocumentPosition(position: { page_no: number; x: number; y: number }, options: { ripple?: boolean } = {}): Promise<boolean> {
    const slot = this.iframe?.contentDocument
      ?.querySelector<HTMLElement>(`.pdf-page-container[data-page-no="${position.page_no}"]`);
    if (!slot) return false;
    const view = this.iframe?.contentWindow;
    if (!view) return false;

    const zoom = this.previewZoomPercent / 100;
    const targetY = slot.offsetTop + (position.y * zoom) - (view.innerHeight * 0.45);
    this.jumpToPreviewOffset(Math.max(0, targetY), position.page_no);
    if (options.ripple) {
      return this.showForwardSyncRippleAtDocumentPosition(position);
    }
    return true;
  }

  private async showForwardSyncRippleAtDocumentPosition(position: { page_no: number; x: number; y: number }): Promise<boolean> {
    const generation = ++this.forwardRippleGeneration;
    const view = this.iframe?.contentWindow;
    const doc = this.iframe?.contentDocument;
    if (!view || !doc) return false;

    await waitForPreviewScrollToSettle(view, 100, 100);
    const slot = doc.querySelector<HTMLElement>(`.pdf-page-container[data-page-no="${position.page_no}"]`);
    if (generation !== this.forwardRippleGeneration || !slot) return false;

    const zoom = this.previewZoomPercent / 100;
    const slotRect = slot.getBoundingClientRect();
    const x = slotRect.left + (position.x * zoom);
    const y = slotRect.top + (position.y * zoom);
    return this.renderForwardSyncRipple(doc, x, y);
  }

  private jumpToPreviewOffset(top: number, pageNo: number): void {
    const view = this.iframe?.contentWindow;
    if (!view) return;
    this.instantScrollTargetPage = pageNo;
    view.scrollTo({ top, behavior: "auto" });
    this.onDebug?.(`Preview programmatic scroll requested: page=${pageNo}; target=${top.toFixed(1)}; observed=${view.scrollY.toFixed(1)}; session=${this.mountedSessionKey || "none"}.`);
    this.finishInstantPageJump(pageNo);
    window.setTimeout(() => {
      if (this.instantScrollTargetPage !== pageNo) return;
      this.instantScrollTargetPage = null;
      this.finishInstantPageJump(pageNo);
    }, 0);
  }

  private finishInstantPageJump(pageNo: number): void {
    const view = this.iframe?.contentWindow;
    if (!view) return;
    this.motion.reset(view.scrollY, performance.now());
    this.motionDestinationPage = pageNo;
    this.motionStartedAt = null;
    this.finalDecisionAt = performance.now();
    this.renderScheduler.removeReason("decelerating-destination");
    this.renderScheduler.removeReason("directional-neighbor");
    this.cancelDistantPageRenders(pageNo, 2);
    this.queueViewportFinalRenders("first-stable");
    void this.pumpPageRenderQueue();
    this.reportPageStatus(pageNo);
    const reportScrollPosition = (phase: string) => {
      this.onScrollPositionChanged?.(view.scrollY);
      this.onDebug?.(`Preview programmatic scroll observed: phase=${phase}; page=${pageNo}; observed=${view.scrollY.toFixed(1)}; session=${this.mountedSessionKey || "none"}.`);
    };
    // WebView can report the old scroll offset immediately after scrollTo.
    // Report again after layout so session-linked tabs retain the position
    // reached by forward/inverse navigation, not the previous viewport.
    reportScrollPosition("immediate");
    view.requestAnimationFrame(() => reportScrollPosition("animation-frame"));
    view.setTimeout(() => reportScrollPosition("32ms"), 32);
  }

  private reportPageStatus(currentPage: number): void {
    const pageCount = Number(this.pdfDoc?.numPages ?? 0);
    const normalizedPage = pageCount > 0
      ? Math.max(1, Math.min(Math.round(currentPage), pageCount))
      : 0;
    const key = `${normalizedPage}:${pageCount}`;
    if (key === this.lastPageStatusKey) return;
    this.lastPageStatusKey = key;
    this.onPageChanged?.({ currentPage: normalizedPage, pageCount });
  }

  private renderForwardSyncRipple(doc: Document, x: number, y: number): boolean {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
    doc.querySelectorAll(".forward-sync-ripple").forEach(element => element.remove());
    const ripple = doc.createElement("div");
    ripple.className = "forward-sync-ripple";
    ripple.style.left = `${x}px`;
    ripple.style.top = `${y}px`;
    doc.body.appendChild(ripple);
    window.setTimeout(() => {
      if (ripple.isConnected) ripple.remove();
    }, 1600);
    return true;
  }

  private captureScrollAnchor(): PreviewViewportAnchor | null {
    const doc = this.iframe?.contentDocument;
    const view = this.iframe?.contentWindow;
    if (!doc || !view) return null;
    const pages = [...doc.querySelectorAll<HTMLElement>(".pdf-page-container")]
      .map(slot => {
        const rect = slot.getBoundingClientRect();
        return {
          pageNo: Number(slot.dataset.pageNo),
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height,
        };
      })
      .filter(page => Number.isFinite(page.pageNo));
    return capturePreviewViewportAnchor(pages, view.innerWidth, view.innerHeight);
  }

  private captureScrollPosition(): number {
    const view = this.iframe?.contentWindow;
    const doc = this.iframe?.contentDocument;
    return Math.max(
      0,
      view?.scrollY
        ?? doc?.documentElement.scrollTop
        ?? doc?.body.scrollTop
        ?? 0
    );
  }

  private restoreScrollPosition(scrollTop: number): void {
    if (!Number.isFinite(scrollTop)) return;
    requestAnimationFrame(() => {
      const view = this.iframe?.contentWindow;
      const doc = this.iframe?.contentDocument;
      if (!view || !doc) return;
      const maximum = Math.max(0, doc.documentElement.scrollHeight - view.innerHeight);
      const restoredTop = Math.min(Math.max(0, scrollTop), maximum);
      this.jumpToPreviewOffset(restoredTop, this.pageNumberAtScrollTop(restoredTop));
      this.updateGoToFirstPageButton();
    });
  }

  private restoreScrollAnchor(anchor: PreviewViewportAnchor | null, afterLayout = false): void {
    if (!anchor) return;
    const restore = () => {
      const slot = this.iframe?.contentDocument
        ?.querySelector<HTMLElement>(`.pdf-page-container[data-page-no="${anchor.pageNo}"]`);
      const view = this.iframe?.contentWindow;
      if (!slot || !view) return;
      const rect = slot.getBoundingClientRect();
      const delta = previewViewportAnchorDelta(anchor, {
        pageNo: anchor.pageNo,
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
      }, view.innerWidth, view.innerHeight);
      view.scrollBy({ left: delta.left, top: delta.top, behavior: "auto" });
    };
    requestAnimationFrame(() => {
      if (afterLayout) requestAnimationFrame(restore);
      else restore();
    });
  }

  private setupIframeInteractions(): void {
    const doc = this.iframe?.contentDocument;
    if (!doc) {
      this.debugInverse("Interaction installation deferred: iframe document unavailable.");
      return;
    }
    this.syncTheme();
    if (doc.documentElement.dataset.typsastraInteractions === "true") return;
    doc.documentElement.dataset.typsastraInteractions = "true";
    this.motion.reset(this.iframe?.contentWindow?.scrollY ?? 0, performance.now());
    const goToFirstPageButton = doc.getElementById("preview-go-first") as HTMLButtonElement | null;
    goToFirstPageButton?.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      this.hideDraftImagePopover();
      this.jumpToPreviewOffset(0, 1);
      this.updateGoToFirstPageButton();
    });
    this.updateGoToFirstPageButton();
    this.debugInverse(`Interaction listener installed: readyState=${doc.readyState}, url=${doc.URL || "(empty)"}.`);
    doc.addEventListener("contextmenu", event => event.preventDefault());
    doc.addEventListener("pointerdown", event => {
      if ((event.target as Element | null)?.closest("#preview-go-first")) return;
      this.rememberDraftPointer(event);
      window.postMessage({ type: "HIDE_CONTEXT_MENU" }, "*");
      this.motion.setPointerDown(true);
    }, true);
    this.iframe?.contentWindow?.addEventListener("pointerup", () => this.motion.setPointerDown(false), true);
    this.iframe?.contentWindow?.addEventListener("pointercancel", () => this.motion.setPointerDown(false), true);
    this.iframe?.contentWindow?.addEventListener("blur", () => {
      this.motion.setPointerDown(false);
      this.previewLinkModifierHeld = false;
      this.setPreviewLinkModifier(doc, false);
    });
    doc.addEventListener("pointermove", event => {
      this.previewPointerInside = true;
      this.rememberDraftPointer(event);
      this.setPreviewLinkModifier(doc, this.previewLinkModifierHeld);
    }, { passive: true });
    doc.addEventListener("pointerover", event => {
      this.previewPointerInside = true;
      this.rememberDraftPointer(event);
      this.setPreviewLinkModifier(doc, this.previewLinkModifierHeld);
      const link = (event.target as Element | null)?.closest<HTMLElement>(".draft-image-link");
      if (link) void this.showDraftImagePopover(link);
    });
    doc.addEventListener("pointerout", event => {
      const link = (event.target as Element | null)?.closest<HTMLElement>(".draft-image-link");
      const related = event.relatedTarget as Node | null;
      if (link && (!related || !link.contains(related))) {
        this.hideDraftImagePopover();
        this.scheduleDraftHoverRetarget(0);
      }
    });
    doc.addEventListener("focusin", event => {
      const link = (event.target as Element | null)?.closest<HTMLElement>(".draft-image-link");
      if (link) void this.showDraftImagePopover(link);
    });
    doc.addEventListener("focusout", event => {
      if ((event.target as Element | null)?.closest(".draft-image-link")) this.hideDraftImagePopover();
    });
    doc.documentElement.addEventListener("pointerleave", () => {
      this.previewPointerInside = false;
      this.setPreviewLinkModifier(doc, false);
      this.draftPointerPosition = null;
      this.hideDraftImagePopover();
    });
    doc.addEventListener("keydown", event => {
      this.previewLinkModifierHeld = previewLinkModifierAfterKeyboardEvent(event, "keydown");
      this.setPreviewLinkModifier(doc, this.previewPointerInside && this.previewLinkModifierHeld);
    });
    doc.addEventListener("keyup", event => {
      this.previewLinkModifierHeld = previewLinkModifierAfterKeyboardEvent(event, "keyup");
      this.setPreviewLinkModifier(doc, this.previewPointerInside && this.previewLinkModifierHeld);
    });
    doc.addEventListener("click", event => {
      const target = event.target as Element | null;
      if (target?.closest("#preview-go-first")) return;
      const annotationLink = target?.closest<HTMLElement>(".annotation-link");
      const mouse = event as MouseEvent;
      if (annotationLink) {
        event.preventDefault();
        const annotationTarget = this.annotationTargets.get(annotationLink);
        if (annotationTarget?.kind === "draft-image") {
          this.hideDraftImagePopover();
          if (mouse.button === 0 && !previewLinkModifierPressed(mouse)) {
            event.stopPropagation();
            this.onPreviewClick({ draftImageId: annotationTarget.id });
            return;
          }
        }
        if (mouse.button === 0 && previewLinkModifierPressed(mouse)) {
          event.stopPropagation();
          void this.activatePreviewLink(annotationLink);
          return;
        }
      }
      const slot = target?.closest<HTMLElement>(".pdf-page-container");
      if (!slot) {
        this.debugInverse("Click ignored: no PDF page container at target.");
        return;
      }
      const pageNo = Number(slot.dataset.pageNo);
      this.debugInverse(`Click received: page=${pageNo}, x=${mouse.clientX.toFixed(1)}, y=${mouse.clientY.toFixed(1)}, target=${target?.tagName ?? "unknown"}.`);
      const point = this.pdfDocumentPointAtClick(pageNo, slot, mouse);
      this.debugInverse(`PDF coordinate resolved: page=${pageNo}, x=${point.documentPosition?.x.toFixed(2)}, y=${point.documentPosition?.y.toFixed(2)}.`);
      this.onPreviewClick(point);
    }, true);

    doc.addEventListener("wheel", event => {
      this.previewPointerInside = true;
      this.rememberDraftPointer(event);
      this.setPreviewLinkModifier(doc, this.previewLinkModifierHeld);
      if (event.ctrlKey) {
        event.preventDefault();
        if (event.deltaY < 0) {
          this.zoomIn();
        } else {
          this.zoomOut();
        }
      } else {
        this.scheduleDraftHoverRetarget();
      }
    }, { passive: false });
    this.iframe?.contentWindow?.addEventListener(
      "scroll",
      () => {
        this.hideDraftImagePopover();
        this.scheduleDraftHoverRetarget();
        this.updateGoToFirstPageButton();
        this.onScrollPositionChanged?.(this.iframe?.contentWindow?.scrollY ?? 0);
        this.deferPageRenderingDuringScroll();
      },
      { passive: true }
    );
  }

  private updateGoToFirstPageButton(): void {
    const doc = this.iframe?.contentDocument;
    const view = this.iframe?.contentWindow;
    const button = doc?.getElementById("preview-go-first") as HTMLButtonElement | null;
    if (!button || !view) return;
    const visible = view.scrollY > 48;
    button.classList.toggle("is-visible", visible);
    button.tabIndex = visible ? 0 : -1;
    button.setAttribute("aria-hidden", visible ? "false" : "true");
  }

  private setPreviewLinkModifier(doc: Document, active: boolean): void {
    doc.documentElement.classList.toggle("preview-link-modifier", active);
  }

  private async activatePreviewLink(link: HTMLElement): Promise<void> {
    const target = this.annotationTargets.get(link);
    if (!target) return;
    if (target.kind === "draft-image") return;
    if (target.kind === "external") {
      try {
        await openUrl(target.url);
      } catch (error) {
        console.warn("Failed to open PDF link:", error);
      }
      return;
    }
    await this.jumpToPdfDestination(target.destination);
  }

  private async jumpToPdfDestination(destination: string | unknown[]): Promise<void> {
    if (!this.pdfDoc) return;
    try {
      const resolved = typeof destination === "string"
        ? await this.pdfDoc.getDestination(destination)
        : destination;
      if (!Array.isArray(resolved) || resolved.length === 0) return;
      const pageReference = resolved[0];
      const pageIndex = typeof pageReference === "number"
        ? pageReference
        : await this.pdfDoc.getPageIndex(pageReference);
      if (!Number.isInteger(pageIndex)) return;
      const pageNo = pageIndex + 1;
      const slot = this.iframe?.contentDocument
        ?.querySelector<HTMLElement>(`.pdf-page-container[data-page-no="${pageNo}"]`);
      if (!slot) return;

      const destinationKind = typeof resolved[1] === "object" && resolved[1] !== null
        ? String((resolved[1] as { name?: unknown }).name ?? "")
        : "";
      const x = Number(resolved[2]);
      const y = Number(resolved[3]);
      if (destinationKind === "XYZ" && Number.isFinite(y)) {
        const page = await this.pdfDoc.getPage(pageNo);
        const viewport = page.getViewport({ scale: 1 });
        const point = viewport.convertToViewportPoint(Number.isFinite(x) ? x : 0, y);
        if (Array.isArray(point) && point.length >= 2) {
          await this.revealDocumentPosition({ page_no: pageNo, x: Number(point[0]), y: Number(point[1]) });
          return;
        }
      }
      this.scrollToPage(pageNo);
    } catch (error) {
      console.warn("Failed to follow PDF destination:", error);
    }
  }

  private pdfDocumentPointAtClick(pageNo: number, slot: HTMLElement, event: MouseEvent): PreviewClickPoint {
    const slotRect = slot.getBoundingClientRect();
    const x = event.clientX - slotRect.left;
    const y = event.clientY - slotRect.top;
    const zoom = this.previewZoomPercent / 100;
    return {
      pageNo,
      documentPosition: { page_no: pageNo, x: x / zoom, y: y / zoom }
    };
  }

  private debugInverse(reason: string): void {
    this.reportInteractionStatus({ kind: "debug", url: this.mountedUrl, reason: `Inverse sync: ${reason}` });
  }

  public activateSession(sessionKey: string): boolean {
    if (!this.pdfDoc || this.mountedSessionKey !== sessionKey) return false;
    this.clearMessageHost();
    if (this.pendingRestoredScrollTop !== null) {
      const scrollTop = this.pendingRestoredScrollTop;
      this.pendingRestoredScrollTop = null;
      this.restoreScrollPosition(scrollTop);
    }
    return true;
  }

  public async clear(): Promise<void> {
    this.hideDraftImagePopover();
    ++this.pdfGeneration;
    releaseCanvasResources(this.iframe?.contentDocument?.documentElement ?? null);
    this.iframe?.remove();
    this.iframe = null;
    this.mountedUrl = "";
    this.mountedSessionKey = "";
    this.currentPdfBytes = 0;
    this.currentPdfBytesRead = 0;
    this.currentPdfRangeRequests = 0;
    this.currentPdfTransport = "none";
    await this.disposePdfDocument();
    this.pdfWorker?.destroy();
    this.pdfWorker = null;
    this.clearErrorOverlay();
    this.clearMessageHost();
    this.reportPageStatus(0);
  }

  public async draftImageIdsForPage(pageNo: number): Promise<string[]> {
    if (!this.pdfDoc || pageNo < 1 || pageNo > this.pdfDoc.numPages) return [];
    try {
      const page = await this.pdfDoc.getPage(pageNo);
      const ids: string[] = [];
      const seen = new Set<string>();
      for (const annotation of await page.getAnnotations()) {
        const target = previewLinkTarget(annotation);
        if (target?.kind !== "draft-image" || seen.has(target.id)) continue;
        seen.add(target.id);
        ids.push(target.id);
      }
      if (!this.activeRenders.has(pageNo)) page.cleanup();
      return ids;
    } catch {
      return [];
    }
  }

  private async showDraftImagePopover(link: HTMLElement): Promise<void> {
    if (this.draftHoverLink === link) return;
    const startedAt = performance.now();
    const target = this.annotationTargets.get(link);
    if (target?.kind !== "draft-image" || !this.onDraftImageRequest) return;
    this.draftHoverLink = link;
    const generation = ++this.draftHoverGeneration;
    await new Promise(resolve => window.setTimeout(resolve, 120));
    if (generation !== this.draftHoverGeneration || !this.isDraftLinkActive(link)) return;
    let image = await this.onDraftImageRequest(target.id).catch(() => null);
    if (generation !== this.draftHoverGeneration || !image) return;
    if (image.status !== "ready") {
      this.showDraftImageStatusPopover(
        link,
        image.status === "failed"
          ? image.message ?? "Image preview unavailable."
          : "Preparing image preview…"
      );
      while (
        image.status !== "failed"
        && generation === this.draftHoverGeneration
        && this.isDraftLinkActive(link)
      ) {
        await new Promise(resolve => window.setTimeout(resolve, 250));
        image = await this.onDraftImageRequest(target.id).catch(() => null);
        if (!image) return;
        if (image.status === "ready") break;
      }
    }
    if (image.status === "failed") {
      this.showDraftImageStatusPopover(link, image.message ?? "Image preview unavailable.");
      return;
    }
    if (
      generation !== this.draftHoverGeneration
      || !this.isDraftLinkActive(link)
      || image.status !== "ready"
    ) return;
    this.hideDraftImagePopover(false);
    const doc = this.iframe?.contentDocument;
    if (!doc) return;
    const objectUrl = URL.createObjectURL(
      new Blob([Uint8Array.from(image.bytes).buffer], { type: image.mimeType })
    );
    this.draftObjectUrl = objectUrl;
    const popover = doc.createElement("div");
    popover.className = "draft-image-popover";
    popover.setAttribute("role", "tooltip");
    const preview = doc.createElement("img");
    preview.src = objectUrl;
    preview.alt = image.filename;
    await preview.decode().catch(() => {});
    if (generation !== this.draftHoverGeneration || !this.isDraftLinkActive(link)) {
      this.hideDraftImagePopover();
      return;
    }
    const viewportWidth = this.iframe?.contentWindow?.innerWidth ?? 800;
    const viewportHeight = this.iframe?.contentWindow?.innerHeight ?? 600;
    const maximumImageWidth = Math.max(1, Math.min(320, viewportWidth - 32));
    const maximumImageHeight = Math.max(1, Math.min(240, viewportHeight - 58));
    const naturalWidth = Math.max(1, preview.naturalWidth);
    const naturalHeight = Math.max(1, preview.naturalHeight);
    const imageScale = Math.min(
      1,
      maximumImageWidth / naturalWidth,
      maximumImageHeight / naturalHeight
    );
    const renderedImageWidth = Math.max(1, Math.round(naturalWidth * imageScale));
    const renderedImageHeight = Math.max(1, Math.round(naturalHeight * imageScale));
    preview.style.width = `${renderedImageWidth}px`;
    preview.style.height = `${renderedImageHeight}px`;
    const label = doc.createElement("div");
    label.className = "draft-image-popover-label";
    label.textContent = `${image.width.toLocaleString()} × ${image.height.toLocaleString()} px · ${formatFileSize(image.sourceBytes)} source`;
    popover.append(preview, label);
    popover.style.width = `${renderedImageWidth + 16}px`;
    doc.body.append(popover);
    const anchor = link.getBoundingClientRect();
    const width = popover.offsetWidth;
    const height = popover.offsetHeight;
    const left = Math.max(8, Math.min(anchor.left, viewportWidth - width - 8));
    const preferredTop = anchor.bottom + 8;
    const top = preferredTop + height <= viewportHeight
      ? preferredTop
      : Math.max(8, anchor.top - height - 8);
    popover.style.left = `${left}px`;
    popover.style.top = `${top}px`;
    this.draftPopover = popover;
    this.onPerformance?.({
      name: "preview.draft-hover",
      milliseconds: performance.now() - startedAt,
      detail: {
        thumbnailBytes: image.bytes.byteLength,
        sourceBytes: image.sourceBytes,
        width: image.width,
        height: image.height
      }
    });
  }

  private showDraftImageStatusPopover(link: HTMLElement, message: string): void {
    this.hideDraftImagePopover(false);
    const doc = this.iframe?.contentDocument;
    if (!doc) return;
    const popover = doc.createElement("div");
    popover.className = "draft-image-popover";
    popover.setAttribute("role", "status");
    const label = doc.createElement("div");
    label.className = "draft-image-popover-label";
    label.textContent = message;
    popover.append(label);
    doc.body.append(popover);
    const anchor = link.getBoundingClientRect();
    popover.style.left = `${Math.max(8, Math.min(anchor.left, (this.iframe?.clientWidth ?? 800) - popover.offsetWidth - 8))}px`;
    popover.style.top = `${Math.max(8, Math.min(anchor.bottom + 8, (this.iframe?.clientHeight ?? 600) - popover.offsetHeight - 8))}px`;
    this.draftPopover = popover;
  }

  private hideDraftImagePopover(invalidate = true): void {
    if (invalidate) {
      this.draftHoverGeneration += 1;
      this.draftHoverLink = null;
    }
    this.draftPopover?.remove();
    this.draftPopover = null;
    if (this.draftObjectUrl) URL.revokeObjectURL(this.draftObjectUrl);
    this.draftObjectUrl = null;
  }

  private rememberDraftPointer(event: Pick<MouseEvent, "clientX" | "clientY">): void {
    this.draftPointerPosition = { x: event.clientX, y: event.clientY };
  }

  private scheduleDraftHoverRetarget(delay = 90): void {
    if (this.draftHoverRetargetTimer !== null) {
      window.clearTimeout(this.draftHoverRetargetTimer);
    }
    this.draftHoverRetargetTimer = window.setTimeout(() => {
      this.draftHoverRetargetTimer = null;
      window.requestAnimationFrame(() => this.retargetDraftHoverAtPointer());
    }, delay);
  }

  private draftLinkAtPointer(): HTMLElement | null {
    const doc = this.iframe?.contentDocument;
    const point = this.draftPointerPosition;
    if (!doc || !point) return null;
    return doc
      .elementFromPoint(point.x, point.y)
      ?.closest<HTMLElement>(".draft-image-link") ?? null;
  }

  private isDraftLinkActive(link: HTMLElement): boolean {
    return link.matches(":focus") || this.draftLinkAtPointer() === link;
  }

  private retargetDraftHoverAtPointer(): void {
    const link = this.draftLinkAtPointer();
    if (link) {
      void this.showDraftImagePopover(link);
    } else {
      this.hideDraftImagePopover();
    }
  }

  public setMessage(html: string): void {
    this.hideDraftImagePopover();
    ++this.pdfGeneration;
    releaseCanvasResources(this.iframe?.contentDocument?.documentElement ?? null);
    this.iframe?.remove();
    this.iframe = null;
    this.mountedUrl = "";
    this.mountedSessionKey = "";
    this.currentPdfBytes = 0;
    this.currentPdfBytesRead = 0;
    this.currentPdfRangeRequests = 0;
    this.currentPdfTransport = "none";
    void this.disposePdfDocument();
    this.clearErrorOverlay();
    this.clearMessageHost();
    this.reportPageStatus(0);
    const host = document.createElement("div");
    host.className = "preview-message-host";
    host.innerHTML = html;
    this.pane.appendChild(host);
    this.messageHost = host;
  }

  public setConfirmationMessage(options: {
    title: string;
    message: string;
    confirmLabel: string;
    onConfirm: () => void | Promise<void>;
    preservePreview?: boolean;
    pairedGuardrail?: boolean;
  }): void {
    if (options.preservePreview && this.currentUrl) {
      this.setMessageOverlay("");
    } else {
      this.setMessage("");
    }
    const host = this.messageHost;
    if (!host) return;
    const placeholder = document.createElement("div");
    placeholder.className = "preview-disabled-placeholder";
    if (options.pairedGuardrail) {
      placeholder.classList.add("guardrail-paired-placeholder", "guardrail-preview-placeholder");
    }
    const content = document.createElement("div");
    content.className = "guardrail-placeholder-content";
    const title = document.createElement("div");
    title.className = "preview-disabled-title";
    title.textContent = options.title;
    const description = document.createElement("div");
    description.className = "preview-disabled-msg";
    description.textContent = options.message;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "editor-file-placeholder-action";
    button.textContent = options.confirmLabel;
    button.addEventListener("click", () => {
      button.disabled = true;
      button.textContent = "Loading…";
      void Promise.resolve(options.onConfirm()).catch(error => {
        console.error("Preview confirmation action failed:", error);
        button.disabled = false;
        button.textContent = options.confirmLabel;
      });
    });
    content.append(title, description, button);
    placeholder.append(content);
    host.appendChild(placeholder);
  }

  public setMessageOverlay(html: string): void {
    this.clearErrorOverlay();
    this.clearMessageHost();
    const host = document.createElement("div");
    host.className = "preview-message-host preview-preserved-message-overlay";
    host.innerHTML = html;
    this.pane.appendChild(host);
    this.messageHost = host;
  }

  public setLoading(message: string, preservePreview = true): void {
    const markup = `<div class="preview-loading-placeholder" role="status" aria-live="polite">`
      + `<div class="preview-loading-spinner" aria-hidden="true"></div>`
      + `<div class="preview-loading-message">${escapeHtml(message)}</div>`
      + `</div>`;
    if (!preservePreview) {
      this.setMessage(markup);
      this.messageHost?.classList.add("preview-loading-overlay", "preview-loading-replacement");
      return;
    }
    this.clearMessageHost();
    const host = document.createElement("div");
    host.className = "preview-message-host preview-loading-overlay";
    host.innerHTML = markup;
    this.pane.appendChild(host);
    this.messageHost = host;
  }

  public setError(title: string, message: string): void {
    this.clearLoadingHost();
    this.clearErrorOverlay();
    const overlay = document.createElement("div");
    overlay.className = "compiler-preview-error-overlay";
    const content = document.createElement("div");
    content.className = "compiler-preview-error-content";
    const titleElement = document.createElement("h3");
    titleElement.className = "compiler-preview-error-title";
    titleElement.textContent = `ⓧ ${title}`;
    const details = document.createElement("pre");
    details.className = "compiler-preview-error-message";
    details.textContent = message;
    content.append(titleElement, details);
    overlay.appendChild(content);
    this.pane.appendChild(overlay);
    this.errorOverlay = overlay;
  }

  public setCompilerError(
    title: string,
    message: string,
    options: {
      displayPath: (filePath: string) => string;
      navigate: (location: TypstSourceLocation) => void;
    },
  ): void {
    const diagnostic = parsePreviewCompilerDiagnostic(message);
    if (!diagnostic) return this.setError(title, message);
    this.clearLoadingHost();
    this.clearErrorOverlay();
    const overlay = document.createElement("div");
    overlay.className = "compiler-preview-error-overlay";
    const content = document.createElement("div");
    content.className = "compiler-preview-error-content compiler-preview-diagnostic";
    const titleElement = document.createElement("h3");
    titleElement.className = "compiler-preview-error-title";
    titleElement.textContent = `\u24e7 ${title}`;
    const summary = document.createElement("p");
    summary.className = "compiler-preview-diagnostic-summary";
    summary.textContent = diagnostic.summary;
    content.append(titleElement, summary);

    diagnostic.frames.forEach((frame, index) => {
      const frameContent = document.createElement("div");
      frameContent.className = "compiler-preview-diagnostic-frame-content";
      const locationRow = document.createElement("div");
      locationRow.className = "compiler-preview-diagnostic-location-row";
      const location = document.createElement("button");
      location.type = "button";
      location.className = "compiler-preview-diagnostic-location";
      location.textContent = `${options.displayPath(frame.filePath)}:${frame.line}:${frame.column}`;
      location.title = frame.filePath;
      location.addEventListener("click", () => options.navigate(frame));
      const copy = document.createElement("button");
      copy.type = "button";
      copy.className = "compiler-preview-diagnostic-copy";
      copy.textContent = "Copy path";
      copy.title = `Copy ${frame.filePath}`;
      copy.addEventListener("click", () => { void writeText(frame.filePath); });
      locationRow.append(location, copy);
      frameContent.append(locationRow);
      if (frame.snippet) {
        const snippet = document.createElement("pre");
        snippet.className = "compiler-preview-diagnostic-snippet";
        snippet.textContent = frame.snippet;
        frameContent.append(snippet);
      }
      if (index === 0 && frame.kind === "primary") {
        const section = document.createElement("section");
        section.className = "compiler-preview-diagnostic-frame";
        section.append(frameContent);
        content.append(section);
      } else {
        const disclosure = document.createElement("details");
        disclosure.className = "compiler-preview-diagnostic-frame compiler-preview-diagnostic-secondary";
        const disclosureSummary = document.createElement("summary");
        const label = frame.label ? `${frame.kind}: ${frame.label}` : `${frame.kind} location`;
        disclosureSummary.textContent = `${label} \u2014 ${options.displayPath(frame.filePath)}:${frame.line}`;
        disclosure.append(disclosureSummary, frameContent);
        content.append(disclosure);
      }
    });
    diagnostic.notes.forEach(text => {
      const note = document.createElement("div");
      note.className = "compiler-preview-diagnostic-note";
      note.textContent = text;
      content.append(note);
    });
    const rawDisclosure = document.createElement("details");
    rawDisclosure.className = "compiler-preview-diagnostic-raw";
    const rawSummary = document.createElement("summary");
    rawSummary.textContent = "Show raw compiler output";
    const raw = document.createElement("pre");
    raw.textContent = diagnostic.raw;
    rawDisclosure.append(rawSummary, raw);
    content.append(rawDisclosure);
    overlay.append(content);
    this.pane.appendChild(overlay);
    this.errorOverlay = overlay;
  }

  public clearErrorOverlay(): void {
    this.errorOverlay?.remove();
    this.errorOverlay = null;
  }

  private clearMessageHost(): void {
    this.messageHost?.remove();
    this.messageHost = null;
  }

  private clearLoadingHost(): void {
    if (!this.messageHost?.querySelector(".preview-loading-placeholder")) return;
    this.clearMessageHost();
  }

  private reportInteractionStatus(status: PreviewInteractionStatus): void {
    const key = `${status.kind}:${status.url}:${status.reason ?? ""}`;
    if (key === this.lastInteractionStatusKey) return;
    this.lastInteractionStatusKey = key;
    this.onInteractionStatus?.(status);
  }

}

async function readInitialPdfPageDimensions(pdfDoc: any): Promise<Map<number, PageDimensions>> {
  const dimensions = new Map<number, PageDimensions>();
  if (pdfDoc.numPages < 1) return dimensions;
  const page = await pdfDoc.getPage(1);
  const viewport = page.getViewport({ scale: 1 });
  const first = { width: viewport.width, height: viewport.height };
  for (let pageNo = 1; pageNo <= pdfDoc.numPages; pageNo += 1) {
    dimensions.set(pageNo, first);
  }
  page.cleanup();
  return dimensions;
}

function nextTurn(): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, 0));
}

function waitForUiIdle(): Promise<void> {
  return new Promise(resolve => {
    if (typeof window.requestIdleCallback === "function") {
      window.requestIdleCallback(() => resolve(), { timeout: 750 });
    } else {
      window.setTimeout(resolve, 50);
    }
  });
}

async function cleanupPdfResources(
  pdfDoc: any,
  loadingTask: PdfLoadingHandle | null
): Promise<void> {
  if (pdfDoc) {
    try { await pdfDoc.cleanup(false); } catch {}
    try { await pdfDoc.destroy(); } catch {}
  }
  if (loadingTask) {
    try { await loadingTask.destroy(); } catch {}
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>]/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[character] ?? character);
}

function viewportRectangle(viewport: any, rect: unknown): [number, number, number, number] | null {
  if (!Array.isArray(rect) || rect.length < 4 || typeof viewport?.convertToViewportPoint !== "function") {
    return null;
  }
  const x1 = Number(rect[0]);
  const y1 = Number(rect[1]);
  const x2 = Number(rect[2]);
  const y2 = Number(rect[3]);
  if (![x1, y1, x2, y2].every(Number.isFinite)) return null;
  const first = viewport.convertToViewportPoint(x1, y1);
  const second = viewport.convertToViewportPoint(x2, y2);
  if (!Array.isArray(first) || !Array.isArray(second)) return null;
  return [first[0], first[1], second[0], second[1]];
}

function pdfLoadingHandle(
  loadingTask: PdfLoadingHandle,
  closeRangeSource: (() => Promise<void>) | null
): PdfLoadingHandle {
  let destroyed = false;
  return {
    async destroy(): Promise<void> {
      if (destroyed) return;
      destroyed = true;
      try {
        await loadingTask.destroy();
      } finally {
        await closeRangeSource?.();
      }
    }
  };
}

function replaceElementChildren(element: Element, ...children: Node[]): void {
  const retained = new Set(children);
  for (const child of [...element.children]) {
    if (!retained.has(child)) releaseCanvasResources(child);
  }
  while (element.firstChild) {
    element.removeChild(element.firstChild);
  }
  for (const child of children) {
    element.appendChild(child);
  }
}

function releaseCanvas(canvas: HTMLCanvasElement): void {
  // Resizing clears the graphics backing store immediately in WebView2/WebKit
  // instead of waiting for a later JavaScript and GPU garbage-collection pass.
  canvas.width = 0;
  canvas.height = 0;
}

function releaseCanvasResources(root: Element | null): void {
  if (!root) return;
  // Preview canvases live in an iframe realm, so `instanceof
  // HTMLCanvasElement` from the parent window is not reliable here.
  if (root.tagName === "CANVAS") releaseCanvas(root as HTMLCanvasElement);
  root.querySelectorAll<HTMLCanvasElement>("canvas").forEach(releaseCanvas);
}

async function waitForPreviewScrollToSettle(
  view: Window,
  initialDelayMs: number,
  afterScrollStopDelayMs: number
): Promise<void> {
  let sawScroll = false;
  const startedAt = performance.now();
  let lastScrollAt = performance.now();
  let lastX = view.scrollX;
  let lastY = view.scrollY;
  const onScroll = () => {
    sawScroll = true;
    lastScrollAt = performance.now();
    lastX = view.scrollX;
    lastY = view.scrollY;
  };

  view.addEventListener("scroll", onScroll, { passive: true });
  await delay(initialDelayMs);
  if (view.scrollX !== lastX || view.scrollY !== lastY) {
    onScroll();
  }
  if (!sawScroll) {
    view.removeEventListener("scroll", onScroll);
    return;
  }

  await new Promise<void>(resolve => {
    const check = () => {
      const now = performance.now();
      if (now - lastScrollAt >= afterScrollStopDelayMs || now - startedAt >= 5000) {
        window.setTimeout(resolve, afterScrollStopDelayMs);
        return;
      }
      view.requestAnimationFrame(check);
    };
    view.requestAnimationFrame(check);
  });
  view.removeEventListener("scroll", onScroll);
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, ms));
}
