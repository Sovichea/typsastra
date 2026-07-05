export type PreviewTextPoint = { text: string; offset: number };

export type PreviewInteractionStatus = {
  kind: "installed" | "blocked";
  url: string;
  reason?: string;
};

export class PreviewFrame {
  private iframe: HTMLIFrameElement | null = null;
  private svgIframe: HTMLIFrameElement | null = null;
  private mountedUrl = "";
  private activeSessionKey = "";
  private readonly sessions = new Map<string, { iframe: HTMLIFrameElement; url: string; usedAt: number; scrollKey: string }>();
  private readonly scrollPositions = new Map<string, { top: number; left: number }>();
  private readonly maxSessions = 5;
  private lastInteractionStatusKey = "";

  constructor(
    private readonly pane: HTMLElement,
    private readonly onTextClick: (point: PreviewTextPoint) => void,
    private readonly onInteractionStatus?: (status: PreviewInteractionStatus) => void
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
    return this.mountSession("default", previewUrl, "default");
  }

  public hasSession(sessionKey: string): boolean {
    return this.sessions.has(sessionKey);
  }

  public activateSession(sessionKey: string): boolean {
    this.captureActiveScroll();
    const session = this.sessions.get(sessionKey);
    if (!session) return false;
    if (session.iframe.parentElement !== this.pane) {
      this.sessions.delete(sessionKey);
      return false;
    }
    if (this.svgIframe) {
      this.svgIframe.remove();
      this.svgIframe = null;
    }
    for (const [key, item] of this.sessions) item.iframe.classList.toggle("hidden", key !== sessionKey);
    session.usedAt = Date.now();
    this.activeSessionKey = sessionKey;
    this.iframe = session.iframe;
    this.mountedUrl = session.url;
    this.restoreScroll(session);
    return true;
  }

  public async mountSession(
    sessionKey: string,
    previewUrl: string,
    scrollKey = sessionKey,
    getPreviewHtml?: () => Promise<string>,
    dataPlaneUrl?: string
  ): Promise<boolean> {
    const existing = this.sessions.get(sessionKey);
    if (existing?.url === previewUrl && existing.iframe.parentElement === this.pane) {
      this.activateSession(sessionKey);
      return false;
    }
    if (existing) existing.iframe.remove();
    const iframe = document.createElement("iframe");
    iframe.className = "preview-frame";
    iframe.addEventListener("load", () => {
      this.configureDocument(iframe);
      const session = this.sessions.get(sessionKey);
      if (session) this.restoreScroll(session);
    });
    this.pane.appendChild(iframe);
    this.sessions.set(sessionKey, { iframe, url: previewUrl, usedAt: Date.now(), scrollKey });
    this.activeSessionKey = sessionKey;
    this.iframe = iframe;
    this.mountedUrl = previewUrl;
    this.activateSession(sessionKey);
    const previewHtml = await getPreviewHtml?.().catch(() => "");
    if (previewHtml) {
      iframe.srcdoc = this.previewSrcdoc(previewHtml, previewUrl, dataPlaneUrl);
    } else {
      iframe.src = previewUrl;
    }
    this.evictInactiveSessions();
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

  private previewSrcdoc(html: string, previewUrl: string, dataPlaneUrl?: string): string {
    const injection = `
<base href="${escapeAttribute(previewUrl.endsWith("/") ? previewUrl : `${previewUrl}/`)}">
<script>
(() => {
  const previewBase = ${JSON.stringify(previewUrl)};
  const dataPlane = ${JSON.stringify(dataPlaneUrl ?? "")};
  const NativeWebSocket = window.WebSocket;
  window.WebSocket = function(url, protocols) {
    let next = url;
    try {
      const parsed = new URL(String(url), previewBase);
      if (parsed.protocol === "ws:" || parsed.protocol === "wss:") {
        if (dataPlane) {
          const base = new URL(dataPlane);
          base.pathname = parsed.pathname;
          base.search = parsed.search;
          base.hash = parsed.hash;
          next = base.href;
        } else if (parsed.host === location.host) {
          const base = new URL(previewBase);
          parsed.host = base.host;
          next = parsed.href;
        } else {
          next = parsed.href;
        }
      }
    } catch {}
    return protocols === undefined ? new NativeWebSocket(next) : new NativeWebSocket(next, protocols);
  };
  window.WebSocket.prototype = NativeWebSocket.prototype;
  for (const key of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"]) {
    Object.defineProperty(window.WebSocket, key, { value: NativeWebSocket[key], configurable: true });
  }
})();
</script>`;
    if (/<head\b[^>]*>/i.test(html)) {
      return html.replace(/<head\b([^>]*)>/i, `<head$1>${injection}`);
    }
    return `<!doctype html><html><head>${injection}</head><body>${html}</body></html>`;
  }

  /**
   * Clear the preview pane and reset state.
   */
  public clear(): void {
    this.pane.innerHTML = "";
    this.sessions.clear();
    this.scrollPositions.clear();
    this.iframe = null;
    this.svgIframe = null;
    this.mountedUrl = "";
    this.activeSessionKey = "";
  }

  public mountSvgPages(pages: readonly string[]): void {
    this.clearSvg();
    for (const item of this.sessions.values()) {
      item.iframe.classList.add("hidden");
    }
    this.activeSessionKey = "";
    
    const iframe = document.createElement("iframe");
    iframe.className = "preview-frame";
    iframe.sandbox.add("allow-same-origin");
    iframe.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><style>
      html,body{margin:0;min-height:100%;background:#d8d8d8}body{padding:24px;box-sizing:border-box}
      .page{display:block;margin:0 auto 24px;max-width:100%;height:auto;box-shadow:0 2px 10px rgba(0,0,0,.2)}
    </style></head><body>${pages.map(page => page.replace("<svg", '<svg class="page"')).join("")}</body></html>`;
    this.pane.appendChild(iframe);
    this.svgIframe = iframe;
    this.iframe = iframe;
    this.mountedUrl = "";
  }

  public setLoading(message: string): void {
    this.clearSvg();
    for (const item of this.sessions.values()) item.iframe.classList.add("hidden");
    this.activeSessionKey = "";
    
    const div = document.createElement("div");
    div.className = "compiler-preview-message";
    div.textContent = message;
    this.pane.appendChild(div);
    // Cast div to HTMLIFrameElement since we're using svgIframe to track it (it just needs a .remove() method)
    this.svgIframe = div as unknown as HTMLIFrameElement;
  }

  public setError(title: string, message: string): void {
    this.clearSvg();
    for (const item of this.sessions.values()) item.iframe.classList.add("hidden");
    this.activeSessionKey = "";
    
    const container = document.createElement("div");
    container.className = "compiler-preview-message error";
    const titleEl = document.createElement("strong");
    titleEl.textContent = title;
    const pre = document.createElement("pre");
    pre.textContent = message;
    container.append(titleEl, pre);
    
    this.pane.appendChild(container);
    this.svgIframe = container as unknown as HTMLIFrameElement;
  }

  public setMessage(html: string): void {
    this.clearSvg();
    for (const item of this.sessions.values()) item.iframe.classList.add("hidden");
    this.activeSessionKey = "";
    
    const div = document.createElement("div");
    div.innerHTML = html;
    this.pane.appendChild(div);
    this.svgIframe = div as unknown as HTMLIFrameElement;
  }

  private clearSvg(): void {
    if (this.svgIframe) {
      this.svgIframe.remove();
      this.svgIframe = null;
    }
  }


  private evictInactiveSessions(): void {
    while (this.sessions.size > this.maxSessions) {
      const candidate = [...this.sessions.entries()]
        .filter(([key]) => key !== this.activeSessionKey)
        .sort((left, right) => left[1].usedAt - right[1].usedAt)[0];
      if (!candidate) return;
      candidate[1].iframe.remove();
      this.sessions.delete(candidate[0]);
    }
  }

  private captureActiveScroll(): void {
    const active = this.sessions.get(this.activeSessionKey);
    if (!active) return;
    const scrollingElement = active.iframe.contentDocument?.scrollingElement;
    if (!scrollingElement) return;
    this.scrollPositions.set(active.scrollKey, {
      top: scrollingElement.scrollTop,
      left: scrollingElement.scrollLeft
    });
  }

  private restoreScroll(session: { iframe: HTMLIFrameElement; scrollKey: string }): void {
    const position = this.scrollPositions.get(session.scrollKey);
    if (!position) return;
    window.setTimeout(() => {
      const scrollingElement = session.iframe.contentDocument?.scrollingElement;
      scrollingElement?.scrollTo(position.left, position.top);
    }, 0);
  }

  private configureDocument(iframe: HTMLIFrameElement): void {
    try {
      const doc = iframe.contentDocument;
      if (!doc) {
        this.reportInteractionStatus({ kind: "blocked", url: iframe.src, reason: "contentDocument unavailable" });
        return;
      }
      if (doc.documentElement.dataset.typstryInteractions === "true") {
        this.reportInteractionStatus({ kind: "installed", url: iframe.src });
        return;
      }
      doc.documentElement.dataset.typstryInteractions = "true";
      doc.addEventListener("click", event => {
        const point = this.textPointFromMouseEvent(doc, event);
        if (point) this.onTextClick(point);
      }, true);
      doc.addEventListener("contextmenu", event => event.preventDefault());
      this.reportInteractionStatus({ kind: "installed", url: iframe.src });
    } catch (error) {
      this.reportInteractionStatus({
        kind: "blocked",
        url: iframe.src,
        reason: error instanceof Error ? error.message : String(error)
      });
      // Cross-origin preview pages keep their own interaction handling.
    }
  }

  private reportInteractionStatus(status: PreviewInteractionStatus): void {
    const key = `${status.kind}:${status.url}:${status.reason ?? ""}`;
    if (key === this.lastInteractionStatusKey) return;
    this.lastInteractionStatusKey = key;
    this.onInteractionStatus?.(status);
  }

  private textPointFromMouseEvent(doc: Document, event: MouseEvent): PreviewTextPoint | null {
    const pointDocument = doc as Document & {
      caretRangeFromPoint?: (x: number, y: number) => Range | null;
      caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    };
    const range = pointDocument.caretRangeFromPoint?.(event.clientX, event.clientY);
    if (range?.startContainer.nodeType === Node.TEXT_NODE) {
      return this.textPointFromTextNode(doc, event, range.startContainer, range.startOffset);
    }

    const position = pointDocument.caretPositionFromPoint?.(event.clientX, event.clientY);
    if (position?.offsetNode.nodeType === Node.TEXT_NODE) {
      return this.textPointFromTextNode(doc, event, position.offsetNode, position.offset);
    }

    const text = (event.target as Element | null)?.textContent?.trim();
    return text ? { text, offset: Math.floor(text.length / 2) } : null;
  }

  private textPointFromTextNode(doc: Document, event: MouseEvent, node: Node, nodeOffset: number): PreviewTextPoint {
    const nodeElement = node.parentElement ?? event.target as Element | null;
    const svgText = nodeElement?.closest("text");
    if (svgText?.contains(node)) {
      const linePoint = this.svgLineTextPoint(svgText, node, nodeOffset);
      if (linePoint) return linePoint;
    }

    const container = this.previewTextContainer(doc, event.target as Element | null, node);
    if (!container) return { text: node.textContent ?? "", offset: nodeOffset };

    const walker = doc.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    let offset = 0;
    for (let current = walker.nextNode(); current; current = walker.nextNode()) {
      if (current === node) {
        return {
          text: container.textContent ?? node.textContent ?? "",
          offset: offset + nodeOffset
        };
      }
      offset += current.textContent?.length ?? 0;
    }
    return { text: node.textContent ?? "", offset: nodeOffset };
  }

  private previewTextContainer(doc: Document, target: Element | null, node: Node): Element | null {
    let element = target;
    if (!element || !element.contains(node)) element = node.parentElement;

    let fallback: Element | null = null;
    while (element && element !== doc.body && element !== doc.documentElement) {
      const text = element.textContent ?? "";
      const display = doc.defaultView?.getComputedStyle(element).display ?? "";
      if (
        text.trim().length > 0
        && text.length <= 5000
        && (display === "block" || display === "list-item" || display === "table-cell" || display === "flex" || display === "grid")
      ) {
        return element;
      }
      if (!fallback && text.trim().length > 0 && text.length <= 5000) fallback = element;
      element = element.parentElement;
    }
    return fallback;
  }

  private svgLineTextPoint(textElement: Element, node: Node, nodeOffset: number): PreviewTextPoint | null {
    const svg = textElement.closest("svg");
    if (!svg) return null;
    const clickedRect = textElement.getBoundingClientRect();
    const clickedCenterY = clickedRect.top + clickedRect.height / 2;
    const allTextElements = [...svg.querySelectorAll("text")]
      .map(element => ({
        element,
        text: element.textContent ?? "",
        rect: element.getBoundingClientRect()
      }))
      .filter(item => item.text.length > 0 && item.rect.width > 0 && item.rect.height > 0);

    const yTolerance = Math.max(2, clickedRect.height * 0.75);
    const sameLine = allTextElements
      .filter(item => Math.abs((item.rect.top + item.rect.height / 2) - clickedCenterY) <= Math.max(yTolerance, item.rect.height * 0.75))
      .sort((left, right) => left.rect.left - right.rect.left);
    if (sameLine.length === 0) return null;

    const clickedIndex = sameLine.findIndex(item => item.element === textElement);
    if (clickedIndex === -1) return null;

    const maxLineGap = Math.max(36, clickedRect.height * 3);
    let start = clickedIndex;
    while (start > 0) {
      const gap = sameLine[start].rect.left - sameLine[start - 1].rect.right;
      if (gap > maxLineGap) break;
      start -= 1;
    }
    let end = clickedIndex;
    while (end + 1 < sameLine.length) {
      const gap = sameLine[end + 1].rect.left - sameLine[end].rect.right;
      if (gap > maxLineGap) break;
      end += 1;
    }

    const clickedLocalOffset = this.textOffsetInsideElement(textElement, node, nodeOffset);
    let text = "";
    let offset = 0;
    for (let index = start; index <= end; index += 1) {
      const item = sameLine[index];
      if (index > start && item.rect.left - sameLine[index - 1].rect.right > 1) {
        if (item.element === textElement) offset += 1;
        text += " ";
      }
      if (item.element === textElement) offset += clickedLocalOffset;
      text += item.text;
    }
    return { text, offset };
  }

  private textOffsetInsideElement(element: Element, node: Node, nodeOffset: number): number {
    const doc = element.ownerDocument;
    const walker = doc.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let offset = 0;
    for (let current = walker.nextNode(); current; current = walker.nextNode()) {
      if (current === node) return offset + nodeOffset;
      offset += current.textContent?.length ?? 0;
    }
    return nodeOffset;
  }
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
