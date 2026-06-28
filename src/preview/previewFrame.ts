export type PreviewTextPoint = { text: string; offset: number };

export class PreviewFrame {
  private iframe: HTMLIFrameElement | null = null;
  private mountedUrl = "";

  constructor(
    private readonly pane: HTMLElement,
    private readonly onTextClick: (point: PreviewTextPoint) => void
  ) {}

  public get element(): HTMLIFrameElement | null {
    return this.iframe;
  }

  /**
   * Returns the currently mounted preview URL, or empty if no preview is active.
   */
  public get currentUrl(): string {
    return this.mountedUrl;
  }

  /**
   * Mount a preview iframe. If the URL matches the currently mounted preview,
   * skip remounting — Tinymist updates existing previews via WebSocket.
   * Returns true if a fresh mount was performed, false if reused.
   */
  public async mount(previewUrl: string, _getPreviewHtml?: () => Promise<string>): Promise<boolean> {
    // Reuse existing iframe if the preview URL hasn't changed
    if (this.iframe && this.mountedUrl === previewUrl && this.iframe.parentElement === this.pane) {
      return false;
    }

    this.pane.innerHTML = "";
    const iframe = document.createElement("iframe");
    iframe.className = "preview-frame";
    iframe.addEventListener("load", () => this.configureDocument());
    this.pane.appendChild(iframe);
    this.iframe = iframe;
    this.mountedUrl = previewUrl;

    iframe.src = previewUrl;
    return true;
  }

  /**
   * Force a fresh mount even if the URL hasn't changed.
   * Used when the preview content must be reloaded (e.g. after LSP restart).
   */
  public async remount(previewUrl: string, getPreviewHtml: () => Promise<string>): Promise<void> {
    this.mountedUrl = "";
    await this.mount(previewUrl, getPreviewHtml);
  }

  /**
   * Clear the preview pane and reset state.
   */
  public clear(): void {
    this.pane.innerHTML = "";
    this.iframe = null;
    this.mountedUrl = "";
  }

  public mountSvgPages(pages: readonly string[]): void {
    this.pane.innerHTML = "";
    const iframe = document.createElement("iframe");
    iframe.className = "preview-frame";
    iframe.sandbox.add("allow-same-origin");
    iframe.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><style>
      html,body{margin:0;min-height:100%;background:#d8d8d8}body{padding:24px;box-sizing:border-box}
      .page{display:block;margin:0 auto 24px;max-width:100%;height:auto;box-shadow:0 2px 10px rgba(0,0,0,.2)}
    </style></head><body>${pages.map(page => page.replace("<svg", '<svg class="page"')).join("")}</body></html>`;
    this.pane.appendChild(iframe);
    this.iframe = iframe;
    this.mountedUrl = "";
  }


  private configureDocument(): void {
    try {
      const doc = this.iframe?.contentDocument;
      if (!doc || doc.documentElement.dataset.typstryInteractions === "true") return;
      doc.documentElement.dataset.typstryInteractions = "true";
      doc.addEventListener("click", event => {
        const point = this.textPointFromMouseEvent(doc, event);
        if (point) this.onTextClick(point);
      }, true);
      doc.addEventListener("contextmenu", event => event.preventDefault());
    } catch {
      // Cross-origin preview pages keep their own interaction handling.
    }
  }

  private textPointFromMouseEvent(doc: Document, event: MouseEvent): PreviewTextPoint | null {
    const pointDocument = doc as Document & {
      caretRangeFromPoint?: (x: number, y: number) => Range | null;
      caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    };
    const range = pointDocument.caretRangeFromPoint?.(event.clientX, event.clientY);
    if (range?.startContainer.nodeType === Node.TEXT_NODE) {
      return { text: range.startContainer.textContent ?? "", offset: range.startOffset };
    }

    const position = pointDocument.caretPositionFromPoint?.(event.clientX, event.clientY);
    if (position?.offsetNode.nodeType === Node.TEXT_NODE) {
      return { text: position.offsetNode.textContent ?? "", offset: position.offset };
    }

    const text = (event.target as Element | null)?.textContent?.trim();
    return text ? { text, offset: Math.floor(text.length / 2) } : null;
  }
}
