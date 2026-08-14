import type { PerformanceMetric } from "../performance/diagnostics";
import {
  PreviewFrame,
  type DraftPreviewImageResult,
  type PreviewClickPoint,
  type PreviewInteractionStatus,
  type PreviewOutlineItem,
  type PreviewPageStatus,
} from "./previewFrame";
import {
  MarkdownPreviewFrame,
  type MarkdownResource,
} from "./markdownPreviewFrame";

export interface PreviewControllerPort {
  onPreviewClick(point: PreviewClickPoint): void;
  onInteractionStatus(status: PreviewInteractionStatus): void;
  onZoomChanged(zoomPercent: number): void;
  onPerformance(metric: Omit<PerformanceMetric, "recordedAt">): void;
  onPageChanged(status: PreviewPageStatus): void;
  loadDraftImage(id: string): Promise<DraftPreviewImageResult | null>;
  onScrollPositionChanged(scrollTop: number): void;
  onDebug(message: string): void;
  onDocumentOutline(items: PreviewOutlineItem[]): void;
  onLoadStage(
    stage: string,
    detail: Record<string, number | string | boolean>,
  ): void | Promise<void>;
  resolveMarkdownImage(documentPath: string, source: string): Promise<MarkdownResource | null>;
  openMarkdownLink(documentPath: string, href: string): Promise<void>;
}

/** Owns the mutually exclusive PDF and Markdown preview surfaces. */
export class PreviewController {
  readonly pdf: PreviewFrame;
  readonly markdown: MarkdownPreviewFrame;

  constructor(pane: HTMLElement, port: PreviewControllerPort) {
    this.pdf = new PreviewFrame(
      pane,
      point => port.onPreviewClick(point),
      status => port.onInteractionStatus(status),
      zoomPercent => port.onZoomChanged(zoomPercent),
      metric => port.onPerformance(metric),
      status => port.onPageChanged(status),
      id => port.loadDraftImage(id),
      scrollTop => port.onScrollPositionChanged(scrollTop),
      message => port.onDebug(message),
      items => port.onDocumentOutline(items),
      (stage, detail) => port.onLoadStage(stage, detail),
    );
    this.markdown = new MarkdownPreviewFrame(pane, {
      resolveImage: (documentPath, source) => port.resolveMarkdownImage(documentPath, source),
      openLink: (documentPath, href) => port.openMarkdownLink(documentPath, href),
    });
  }
}
