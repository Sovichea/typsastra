import type { PreviewDocumentPosition } from "../compiler/lsp";

type RenderedOutlineItem = {
  title: string;
  position?: PreviewDocumentPosition;
  bookmarkIndex?: number;
  children: RenderedOutlineItem[];
};
import { createAppIcon } from "../ui/icons";

export type DocumentHeading = {
  id: string;
  level: number;
  title: string;
  filePath: string;
  from: number;
  textFrom: number;
  to: number;
  line: number;
  previewPosition?: PreviewDocumentPosition;
  previewBookmarkIndex?: number;
  children: DocumentHeading[];
};

function updateBlockCommentDepth(line: string, initialDepth: number): number {
  let depth = initialDepth;
  for (let index = 0; index < line.length - 1; index++) {
    const pair = line.slice(index, index + 2);
    if (pair === "/*") {
      depth++;
      index++;
    } else if (pair === "*/" && depth > 0) {
      depth--;
      index++;
    }
  }
  return depth;
}

function displayTitle(sourceTitle: string): string {
  const withoutLabel = sourceTitle.replace(/\s*<[\p{L}\p{N}_:.-]+>\s*$/u, "").trim();
  return withoutLabel || "Untitled heading";
}

function resolveIncludePath(currentPath: string, workspaceRoot: string, includePath: string): string {
  let baseDir = includePath.startsWith("/") ? workspaceRoot : currentPath.substring(0, Math.max(currentPath.lastIndexOf("/"), currentPath.lastIndexOf("\\")));
  if (includePath.startsWith("/")) includePath = includePath.slice(1);
  
  let result = baseDir + "/" + includePath;
  result = result.replace(/\\/g, "/");
  result = result.replace(/\/\.\//g, "/");
  while (result.match(/\/[^/]+\/\.\.\//)) {
    result = result.replace(/\/[^/]+\/\.\.\//, "/");
  }
  return result.replace(/(?<!:)\/+/g, "/");
}

export async function parseDocumentOutline(
  filePath: string,
  source: string,
  workspaceRoot: string,
  readFile: (path: string) => Promise<string | null>,
  visited: Set<string> = new Set()
): Promise<DocumentHeading[]> {
  const flat = await parseDocumentOutlineFlat(filePath, source, workspaceRoot, readFile, visited);
  
  const roots: DocumentHeading[] = [];
  const parents: DocumentHeading[] = [];
  for (const heading of flat) {
    while (parents.length && parents[parents.length - 1].level >= heading.level) parents.pop();
    const parent = parents[parents.length - 1];
    if (parent) parent.children.push(heading);
    else roots.push(heading);
    parents.push(heading);
  }
  return roots;
}

const occurrences = new Map<string, number>();

async function parseDocumentOutlineFlat(
  filePath: string,
  source: string,
  workspaceRoot: string,
  readFile: (path: string) => Promise<string | null>,
  visited: Set<string>
): Promise<DocumentHeading[]> {
  const flat: DocumentHeading[] = [];
  if (visited.size === 0) occurrences.clear();
  visited.add(filePath);
  
  let blockCommentDepth = 0;
  let rawFenceLength = 0;
  let lineStart = 0;
  let lineNumber = 1;

  while (lineStart <= source.length) {
    const newline = source.indexOf("\n", lineStart);
    const rawLineEnd = newline === -1 ? source.length : newline;
    const lineEnd = rawLineEnd > lineStart && source[rawLineEnd - 1] === "\r"
      ? rawLineEnd - 1
      : rawLineEnd;
    const line = source.slice(lineStart, lineEnd);
    const trimmed = line.trimStart();

    if (rawFenceLength > 0) {
      const closingFence = trimmed.match(/^(`{3,})\s*$/);
      if (closingFence && closingFence[1].length >= rawFenceLength) rawFenceLength = 0;
    } else if (blockCommentDepth > 0) {
      blockCommentDepth = updateBlockCommentDepth(line, blockCommentDepth);
    } else {
      const rawFence = trimmed.match(/^(`{3,})(.*)$/);
      if (rawFence) {
        if (!rawFence[2].includes(rawFence[1])) rawFenceLength = rawFence[1].length;
      } else if (trimmed.startsWith("//")) {
        // A comment-only line cannot contain a document heading.
      } else if (trimmed.startsWith("/*")) {
        blockCommentDepth = updateBlockCommentDepth(line, blockCommentDepth);
      } else {
        const match = line.match(/^([ \t]*)(=+)([ \t]+)(.+?)\s*$/);
        if (match) {
          const level = match[2].length;
          const title = displayTitle(match[4]);
          const signature = `${level}:${title}`;
          const occurrence = (occurrences.get(signature) ?? 0) + 1;
          occurrences.set(signature, occurrence);
          const markerLength = match[1].length + match[2].length + match[3].length;
          flat.push({
            id: `${signature}:${occurrence}`,
            level,
            title,
            filePath,
            from: lineStart + match[1].length,
            textFrom: lineStart + markerLength,
            to: lineEnd,
            line: lineNumber,
            children: []
          });
        } else {
          const includeMatch = line.match(/include\s*["']([^"']+)["']/);
          if (includeMatch) {
            const includePath = includeMatch[1];
            const resolvedPath = resolveIncludePath(filePath, workspaceRoot, includePath);
            if (!visited.has(resolvedPath)) {
              const includeSource = await readFile(resolvedPath);
              if (includeSource !== null) {
                const subHeadings = await parseDocumentOutlineFlat(resolvedPath, includeSource, workspaceRoot, readFile, visited);
                flat.push(...subHeadings);
              }
            }
          }
        }
        blockCommentDepth = updateBlockCommentDepth(line, blockCommentDepth);
      }
    }

    if (newline === -1) break;
    lineStart = newline + 1;
    lineNumber++;
  }

  return flat;
}

function flattenHeadings(headings: readonly DocumentHeading[]): DocumentHeading[] {
  return headings.flatMap(heading => [heading, ...flattenHeadings(heading.children)]);
}

function flattenRenderedOutline(items: readonly RenderedOutlineItem[]): RenderedOutlineItem[] {
  return items.flatMap(item => [item, ...flattenRenderedOutline(item.children)]);
}

function comparableTitle(title: string): string {
  return title
    .replace(/^\s*\d+(?:\.\d+)*[.:]?\s+/u, "")
    .replace(/[\s*_`~#]+/g, "")
    .toLocaleLowerCase();
}

export class DocumentOutlineController {
  private headings: DocumentHeading[] = [];
  private flatHeadings: DocumentHeading[] = [];
  private readonly collapsed = new Set<string>();
  private cursor = 0;
  private activePath: string | null = null;
  private activeHeadingKey: string | null = null;
  private selectedHeadingId: string | null = null;
  private pendingPreviewSyncHeadingKey: string | null = null;

  constructor(
    private readonly container: HTMLElement,
    private readonly section: HTMLElement,
    private readonly onNavigate: (heading: DocumentHeading) => void,
    private readonly onActiveHeadingChanged?: (heading: DocumentHeading) => void,
  ) {}

  public initialize(): void {
    const toggle = document.getElementById("document-outline-toggle");
    toggle?.addEventListener("click", () => {
      const isCollapsed = this.section.classList.toggle("collapsed");
      toggle.setAttribute("aria-expanded", String(!isCollapsed));
    });
    this.container.tabIndex = 0;
    this.container.setAttribute("role", "tree");
    this.container.setAttribute("aria-label", "Document Outline");
    this.container.addEventListener("focus", () => this.ensureKeyboardSelection());
    this.container.addEventListener("keydown", event => this.handleKeyboardNavigation(event));
    this.render();
  }

  public async update(path: string | null, source: string, workspaceRoot: string, readFile: (path: string) => Promise<string | null>): Promise<void> {
    this.activePath = path;
    this.headings = path?.toLowerCase().endsWith(".typ") ? await parseDocumentOutline(path, source, workspaceRoot, readFile) : [];
    this.flatHeadings = flattenHeadings(this.headings);
    const validIds = new Set(this.flatHeadings.map(heading => heading.id));
    for (const id of this.collapsed) {
      if (!validIds.has(id)) this.collapsed.delete(id);
    }
    if (this.selectedHeadingId && !validIds.has(this.selectedHeadingId)) this.selectedHeadingId = null;
    this.render();
    this.setCursorPosition(this.cursor);
  }

  public clear(): void {
    this.headings = [];
    this.flatHeadings = [];
    this.cursor = 0;
    this.activePath = null;
    this.activeHeadingKey = null;
    this.selectedHeadingId = null;
    this.pendingPreviewSyncHeadingKey = null;
    this.collapsed.clear();
    this.render();
  }

  public setCursorPosition(
    cursor: number,
    activePath: string | null = this.activePath,
    syncPreview = false,
  ): void {
    this.cursor = cursor;
    this.activePath = activePath;
    let active: DocumentHeading | undefined;
    for (const heading of this.flatHeadings) {
      if (heading.filePath === activePath) {
        if (heading.from > cursor) break;
        active = heading;
      }
    }
    const activeKey = active ? `${active.filePath}\0${active.id}` : null;
    if (activeKey === this.activeHeadingKey) {
      if (active && syncPreview) this.requestPreviewSync(active, activeKey!);
      return;
    }
    this.activeHeadingKey = activeKey;
    this.container.querySelectorAll<HTMLElement>(".outline-item.active").forEach(item => {
      item.classList.remove("active");
    });
    if (active) {
      const row = Array.from(this.container.querySelectorAll<HTMLElement>(".outline-item"))
        .find(item => item.dataset.outlineId === active.id);
      row?.classList.add("active");
      row?.scrollIntoView({ block: "nearest" });
      if (syncPreview) this.requestPreviewSync(active, activeKey!);
    }
  }

  public findHeading(id: string): DocumentHeading | undefined {
    return this.flatHeadings.find(heading => heading.id === id);
  }

  public previewPositionAt(cursor: number): PreviewDocumentPosition | undefined {
    let position: PreviewDocumentPosition | undefined;
    for (const heading of this.flatHeadings) {
      if (heading.filePath === this.activePath) {
        if (heading.from > cursor) break;
        if (heading.previewPosition) position = heading.previewPosition;
      }
    }
    return position;
  }

  public updatePreviewPositions(items: readonly RenderedOutlineItem[]): void {
    for (const heading of this.flatHeadings) {
      heading.previewPosition = undefined;
      heading.previewBookmarkIndex = undefined;
    }
    const rendered = flattenRenderedOutline(items);
    const claimed = new Set<number>();
    const renderedTitles = rendered.map(item => comparableTitle(item.title));
    const exactMatches = new Map<string, number[]>();
    rendered.forEach((item, index) => {
      if (item.position === undefined && item.bookmarkIndex === undefined) return;
      const title = renderedTitles[index];
      const indexes = exactMatches.get(title) ?? [];
      indexes.push(index);
      exactMatches.set(title, indexes);
    });
    for (const heading of this.flatHeadings) {
      const title = comparableTitle(heading.title);
      const exact = exactMatches.get(title);
      let renderedIndex = exact?.shift() ?? -1;
      while (renderedIndex !== -1 && claimed.has(renderedIndex)) {
        renderedIndex = exact?.shift() ?? -1;
      }
      if (renderedIndex === -1) {
        renderedIndex = rendered.findIndex((item, index) => {
          if (
            claimed.has(index)
            || (item.position === undefined && item.bookmarkIndex === undefined)
          ) return false;
          return renderedTitles[index].endsWith(title);
        });
      }
      if (renderedIndex === -1) continue;
      claimed.add(renderedIndex);
      heading.previewPosition = rendered[renderedIndex].position;
      heading.previewBookmarkIndex = rendered[renderedIndex].bookmarkIndex;
      const headingKey = `${heading.filePath}\0${heading.id}`;
      if (
        this.pendingPreviewSyncHeadingKey === headingKey
        && (heading.previewPosition !== undefined || heading.previewBookmarkIndex !== undefined)
      ) {
        this.pendingPreviewSyncHeadingKey = null;
        this.onActiveHeadingChanged?.(heading);
      }
    }
  }

  private requestPreviewSync(heading: DocumentHeading, headingKey: string): void {
    const hasDestination = heading.previewPosition !== undefined
      || heading.previewBookmarkIndex !== undefined;
    this.pendingPreviewSyncHeadingKey = hasDestination ? null : headingKey;
    this.onActiveHeadingChanged?.(heading);
  }

  private render(): void {
    this.activeHeadingKey = null;
    const count = document.getElementById("document-outline-count");
    if (count) count.textContent = String(this.flatHeadings.length);
    if (!this.headings.length) {
      this.selectedHeadingId = null;
      const empty = document.createElement("div");
      empty.className = "outline-empty";
      empty.textContent = "No headings in the active document.";
      this.container.replaceChildren(empty);
      return;
    }
    this.container.replaceChildren(this.renderLevel(this.headings));
  }

  private visibleRows(): HTMLElement[] {
    return [...this.container.querySelectorAll<HTMLElement>(".outline-item[data-outline-id]")]
      .filter(row => row.getClientRects().length > 0);
  }

  private selectRow(row: HTMLElement): void {
    this.selectedHeadingId = row.dataset.outlineId ?? null;
    this.container.querySelectorAll<HTMLElement>(".outline-item.keyboard-selected").forEach(current => {
      current.classList.remove("keyboard-selected");
      current.setAttribute("aria-selected", "false");
    });
    row.classList.add("keyboard-selected");
    row.setAttribute("aria-selected", "true");
    row.scrollIntoView({ block: "nearest" });
  }

  private ensureKeyboardSelection(): void {
    const selected = this.selectedHeadingId
      ? [...this.container.querySelectorAll<HTMLElement>(".outline-item[data-outline-id]")]
          .find(row => row.dataset.outlineId === this.selectedHeadingId) ?? null
      : null;
    const row = selected ?? this.container.querySelector<HTMLElement>(".outline-item.active") ?? this.visibleRows()[0];
    if (row) this.selectRow(row);
  }

  private handleKeyboardNavigation(event: KeyboardEvent): void {
    if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'Enter'].includes(event.key)) return;
    this.ensureKeyboardSelection();
    const rows = this.visibleRows();
    const selected = this.container.querySelector<HTMLElement>(".outline-item.keyboard-selected[data-outline-id]");
    if (!selected || !rows.length) return;
    event.preventDefault();
    event.stopPropagation();

    const index = Math.max(0, rows.indexOf(selected));
    if (event.key === "ArrowUp") this.selectRow(rows[Math.max(0, index - 1)]);
    else if (event.key === "ArrowDown") this.selectRow(rows[Math.min(rows.length - 1, index + 1)]);
    else if (event.key === "Home") this.selectRow(rows[0]);
    else if (event.key === "End") this.selectRow(rows[rows.length - 1]);
    else if (event.key === "Enter") {
      const heading = this.findHeading(selected.dataset.outlineId ?? "");
      if (heading) this.onNavigate(heading);
    } else if (event.key === "ArrowRight") {
      const disclosure = selected.querySelector<HTMLButtonElement>(".outline-disclosure:not(.placeholder)");
      if (disclosure?.getAttribute("aria-expanded") === "false") disclosure.click();
      else if (rows[index + 1]) this.selectRow(rows[index + 1]);
    } else if (event.key === "ArrowLeft") {
      const disclosure = selected.querySelector<HTMLButtonElement>(".outline-disclosure:not(.placeholder)");
      if (disclosure?.getAttribute("aria-expanded") === "true") disclosure.click();
      else {
        const parent = selected.closest("li.outline-node")?.parentElement?.closest("li.outline-node")
          ?.querySelector<HTMLElement>(":scope > .outline-item");
        if (parent) this.selectRow(parent);
      }
    }
  }

  private renderLevel(headings: readonly DocumentHeading[]): HTMLUListElement {
    const list = document.createElement("ul");
    list.className = "outline-list";
    for (const heading of headings) {
      const item = document.createElement("li");
      item.className = "outline-node";
      const row = document.createElement("div");
      row.className = `outline-item${this.selectedHeadingId === heading.id ? " keyboard-selected" : ""}`;
      row.dataset.outlineId = heading.id;
      row.setAttribute("role", "treeitem");
      row.setAttribute("aria-selected", String(this.selectedHeadingId === heading.id));
      row.title = `${heading.title} (line ${heading.line})`;

      const disclosure = document.createElement("button");
      disclosure.type = "button";
      disclosure.tabIndex = -1;
      disclosure.className = "outline-disclosure";
      if (heading.children.length) {
        const isCollapsed = this.collapsed.has(heading.id);
        disclosure.appendChild(createAppIcon("chevronDown", { size: 14 }));
        disclosure.classList.toggle("collapsed", isCollapsed);
        disclosure.setAttribute("aria-label", `${isCollapsed ? "Expand" : "Collapse"} ${heading.title}`);
        disclosure.setAttribute("aria-expanded", String(!isCollapsed));
        disclosure.addEventListener("click", event => {
          event.stopPropagation();
          this.selectedHeadingId = heading.id;
          if (this.collapsed.has(heading.id)) this.collapsed.delete(heading.id);
          else this.collapsed.add(heading.id);
          this.render();
          this.setCursorPosition(this.cursor);
        });
      } else {
        disclosure.classList.add("placeholder");
        disclosure.tabIndex = -1;
        disclosure.disabled = true;
        disclosure.setAttribute("aria-hidden", "true");
      }

      const label = document.createElement("button");
      label.type = "button";
      label.tabIndex = -1;
      label.className = "outline-label";
      label.textContent = heading.title;
      label.addEventListener("click", () => {
        this.selectedHeadingId = heading.id;
        this.onNavigate(heading);
      });
      row.append(disclosure, label);
      item.appendChild(row);
      if (heading.children.length) {
        const children = this.renderLevel(heading.children);
        children.classList.toggle("hidden", this.collapsed.has(heading.id));
        item.appendChild(children);
      }
      list.appendChild(item);
    }
    return list;
  }
}
