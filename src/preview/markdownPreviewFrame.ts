import { installPreviewZoomGestures, zoomPreviewElementAtPoint, GestureZoomSteps } from "./previewZoomGestures";
import DOMPurify from "dompurify";
import { marked } from "marked";

export type MarkdownResource = {
  source: string;
  alt: string;
};

export type MarkdownPreviewDependencies = {
  resolveImage: (documentPath: string, source: string) => Promise<MarkdownResource | null>;
  logGestureInput?: (message: string) => void;
  openLink: (documentPath: string, href: string) => void | Promise<void>;
};

const MARKDOWN_RENDER_DELAY_MS = 140;

const ALLOWED_TAGS = [
  "a", "blockquote", "br", "code", "del", "div", "em", "h1", "h2", "h3",
  "h4", "h5", "h6", "hr", "img", "input", "li", "ol", "p", "pre", "s",
  "span", "strong", "table", "tbody", "td", "th", "thead", "tr", "ul",
];

const ALLOWED_ATTRIBUTES = [
  "alt", "checked", "class", "colspan", "data-markdown-href", "data-markdown-src",
  "disabled", "id", "rowspan", "start", "title", "type",
];

function slug(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/[\s_]+/gu, "-")
    .replace(/^-+|-+$/gu, "") || "section";
}

export class MarkdownPreviewFrame {
  private readonly host: HTMLElement;
  private readonly article: HTMLElement;
  private readonly scrollPositions = new Map<string, number>();
  private renderTimer: number | null = null;
  private renderGeneration = 0;
  private activePath: string | null = null;
  private scale = 1;

  public constructor(
    private readonly hostParent: HTMLElement,
    private readonly dependencies: MarkdownPreviewDependencies,
  ) {
    this.host = document.createElement("div");
    this.host.className = "markdown-preview-host hidden";
    this.host.setAttribute("aria-label", "Markdown preview");
    this.article = document.createElement("article");
    this.article.className = "markdown-preview-document";
    this.host.appendChild(this.article);
    this.hostParent.appendChild(this.host);
    const steps = new GestureZoomSteps(25, 500);
    installPreviewZoomGestures(this.host, gesture => {
      const scale = steps.next(this.scale * 100, gesture.factor, gesture.deltaPercent, gesture.ensureStep) / 100;
      zoomPreviewElementAtPoint(this.host, this.article, this.scale, scale, gesture, () => {
        this.scale = scale;
        this.article.style.setProperty("zoom", String(scale));
      });
    }, { enabled: () => this.isActive, onStart: () => steps.reset(), onEnd: () => steps.reset(), onInput: message => this.dependencies.logGestureInput?.(message) });

    this.host.addEventListener("scroll", () => {
      if (this.activePath) this.scrollPositions.set(this.activePath, this.host.scrollTop);
    }, { passive: true });
    this.host.addEventListener("click", event => this.handleClick(event));
    window.addEventListener("keydown", event => {
      if (this.isActive && (event.ctrlKey || event.metaKey)) {
        this.host.classList.add("markdown-preview-link-mode");
      }
    });
    window.addEventListener("keyup", event => {
      if (!(event.ctrlKey || event.metaKey)) this.host.classList.remove("markdown-preview-link-mode");
    });
  }

  public get isActive(): boolean {
    return !this.host.classList.contains("hidden");
  }

  public activate(documentPath: string, source: string): void {
    this.ensureAttached();
    if (this.activePath && this.activePath !== documentPath) {
      this.scrollPositions.set(this.activePath, this.host.scrollTop);
    }
    this.activePath = documentPath;
    this.host.classList.remove("hidden");
    this.schedule(documentPath, source, 0);
  }

  public deactivate(): void {
    if (this.activePath) this.scrollPositions.set(this.activePath, this.host.scrollTop);
    this.activePath = null;
    this.host.classList.add("hidden");
    this.host.classList.remove("markdown-preview-link-mode");
    if (this.renderTimer !== null) window.clearTimeout(this.renderTimer);
    this.renderTimer = null;
    this.renderGeneration += 1;
  }

  public schedule(documentPath: string, source: string, delay = MARKDOWN_RENDER_DELAY_MS): void {
    if (this.renderTimer !== null) window.clearTimeout(this.renderTimer);
    const generation = ++this.renderGeneration;
    this.renderTimer = window.setTimeout(() => {
      this.renderTimer = null;
      void this.render(documentPath, source, generation);
    }, delay);
  }

  private async render(documentPath: string, source: string, generation: number): Promise<void> {
    const previousScroll = this.activePath === documentPath
      ? this.host.scrollTop
      : (this.scrollPositions.get(documentPath) ?? 0);
    const raw = await marked.parse(source, { gfm: true, breaks: false });
    if (generation !== this.renderGeneration || this.activePath !== documentPath) return;

    const parsed = new DOMParser().parseFromString(raw, "text/html");
    parsed.querySelectorAll("a[href]").forEach(link => {
      const href = link.getAttribute("href");
      link.removeAttribute("href");
      if (href) link.setAttribute("data-markdown-href", href);
    });
    parsed.querySelectorAll("img[src]").forEach(image => {
      const source = image.getAttribute("src");
      image.removeAttribute("src");
      if (source) image.setAttribute("data-markdown-src", source);
    });
    const usedHeadingIds = new Map<string, number>();
    parsed.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6").forEach(heading => {
      const base = slug(heading.textContent ?? "");
      const occurrence = usedHeadingIds.get(base) ?? 0;
      usedHeadingIds.set(base, occurrence + 1);
      heading.id = occurrence === 0 ? base : `${base}-${occurrence + 1}`;
    });

    const sanitized = DOMPurify.sanitize(parsed.body.innerHTML, {
      ALLOWED_TAGS,
      ALLOWED_ATTR: ALLOWED_ATTRIBUTES,
      ALLOW_DATA_ATTR: true,
      FORBID_TAGS: ["embed", "form", "iframe", "object", "script", "style"],
      FORBID_ATTR: ["style"],
    });
    this.article.innerHTML = sanitized;
    this.article.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach(input => {
      input.disabled = true;
    });
    await this.resolveImages(documentPath, generation);
    if (generation !== this.renderGeneration || this.activePath !== documentPath) return;
    requestAnimationFrame(() => {
      if (generation !== this.renderGeneration || this.activePath !== documentPath) return;
      this.host.scrollTop = Math.min(previousScroll, Math.max(0, this.host.scrollHeight - this.host.clientHeight));
    });
  }

  private ensureAttached(): void {
    if (!this.host.isConnected) this.hostParent.appendChild(this.host);
  }

  private async resolveImages(documentPath: string, generation: number): Promise<void> {
    const images = [...this.article.querySelectorAll<HTMLImageElement>("img[data-markdown-src]")];
    await Promise.all(images.map(async image => {
      const source = image.dataset.markdownSrc ?? "";
      const resource = await this.dependencies.resolveImage(documentPath, source).catch(() => null);
      if (generation !== this.renderGeneration || this.activePath !== documentPath) return;
      if (!resource) {
        const blocked = document.createElement("span");
        blocked.className = "markdown-preview-blocked-resource";
        blocked.textContent = source ? `Image unavailable: ${source}` : "Image unavailable";
        image.replaceWith(blocked);
        return;
      }
      image.src = resource.source;
      if (!image.alt) image.alt = resource.alt;
      image.removeAttribute("data-markdown-src");
    }));
  }

  private handleClick(event: MouseEvent): void {
    const target = (event.target as Element | null)?.closest<HTMLElement>("[data-markdown-href]");
    const href = target?.dataset.markdownHref;
    if (!target || !href || !this.activePath) return;
    event.preventDefault();
    if (!(event.ctrlKey || event.metaKey)) return;
    if (href.startsWith("#")) {
      let fragment = href.slice(1);
      try {
        fragment = decodeURIComponent(fragment);
      } catch {
        return;
      }
      const destination = this.article.querySelector<HTMLElement>(`#${CSS.escape(fragment)}`);
      destination?.scrollIntoView({ block: "start" });
      return;
    }
    void this.dependencies.openLink(this.activePath, href);
  }
}
