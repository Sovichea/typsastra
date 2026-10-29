import type { PreviewDocumentPosition } from "../compiler/lsp";

export type OutlinePreviewItem = {
  title: string;
  position?: PreviewDocumentPosition;
  bookmarkIndex?: number;
  children: OutlinePreviewItem[];
};
import { filePathKey } from "../platform/paths";
import { createAppIcon } from "../ui/icons";
import type { PdfiumDestination, PdfiumOutlineItem } from "../preview/pdfiumDocument";
import type { PreviewSourceOutlineItem } from "../preview/previewOutlineNavigator";

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

export type DocumentOutlineNoticeKind =
  | "missing-include"
  | "dynamic-include"
  | "include-cycle"
  | "import-not-supported";

export type DocumentOutlineNotice = {
  kind: DocumentOutlineNoticeKind;
  filePath: string;
  line: number;
  message: string;
};

export type DocumentOutlineParseResult = {
  headings: DocumentHeading[];
  notices: DocumentOutlineNotice[];
  files: string[];
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
  visited: Set<string> = new Set(),
  followIncludes = true,
): Promise<DocumentHeading[]> {
  const result = await parseDocumentOutlineDetailed(
    filePath,
    source,
    workspaceRoot,
    readFile,
    { ancestors: visited, followIncludes },
  );
  return result.headings;
}

export async function parseDocumentOutlineDetailed(
  filePath: string,
  source: string,
  workspaceRoot: string,
  readFile: (path: string) => Promise<string | null>,
  options: { ancestors?: ReadonlySet<string>; followIncludes?: boolean } = {},
): Promise<DocumentOutlineParseResult> {
  const notices: DocumentOutlineNotice[] = [];
  const noticeKeys = new Set<string>();
  const files = new Set<string>();
  const occurrenceByFile = new Map<string, Map<string, number>>();
  const flat = await parseDocumentOutlineFlat(
    filePath,
    source,
    workspaceRoot,
    readFile,
    new Set(options.ancestors ?? []),
    occurrenceByFile,
    notices,
    noticeKeys,
    files,
    options.followIncludes !== false,
  );

  const roots: DocumentHeading[] = [];
  const parents: DocumentHeading[] = [];
  for (const heading of flat) {
    while (parents.length && parents[parents.length - 1].level >= heading.level) parents.pop();
    const parent = parents[parents.length - 1];
    if (parent) parent.children.push(heading);
    else roots.push(heading);
    parents.push(heading);
  }
  return { headings: roots, notices, files: [...files] };
}

function addOutlineNotice(
  notices: DocumentOutlineNotice[],
  keys: Set<string>,
  notice: DocumentOutlineNotice,
): void {
  const key = `${notice.kind}\0${filePathKey(notice.filePath)}\0${notice.line}\0${notice.message}`;
  if (keys.has(key)) return;
  keys.add(key);
  notices.push(notice);
}

async function parseDocumentOutlineFlat(
  filePath: string,
  source: string,
  workspaceRoot: string,
  readFile: (path: string) => Promise<string | null>,
  ancestors: Set<string>,
  occurrenceByFile: Map<string, Map<string, number>>,
  notices: DocumentOutlineNotice[],
  noticeKeys: Set<string>,
  files: Set<string>,
  followIncludes: boolean,
): Promise<DocumentHeading[]> {
  const flat: DocumentHeading[] = [];
  const fileKey = filePathKey(filePath);
  ancestors.add(fileKey);
  files.add(filePath);
  const fileOccurrences = occurrenceByFile.get(fileKey) ?? new Map<string, number>();
  occurrenceByFile.set(fileKey, fileOccurrences);

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
          const occurrence = (fileOccurrences.get(signature) ?? 0) + 1;
          fileOccurrences.set(signature, occurrence);
          const markerLength = match[1].length + match[2].length + match[3].length;
          flat.push({
            id: `${fileKey}::${signature}:${occurrence}`,
            level,
            title,
            filePath,
            from: lineStart + match[1].length,
            textFrom: lineStart + markerLength,
            to: lineEnd,
            line: lineNumber,
            children: []
          });
        } else if (followIncludes) {
          const includeMatch = line.match(/#include\s*(?:\(\s*)?["']([^"']+)["']/);
          if (includeMatch) {
            const includePath = includeMatch[1];
            const resolvedPath = resolveIncludePath(filePath, workspaceRoot, includePath);
            const resolvedKey = filePathKey(resolvedPath);
            if (ancestors.has(resolvedKey)) {
              addOutlineNotice(notices, noticeKeys, {
                kind: "include-cycle",
                filePath,
                line: lineNumber,
                message: `Include cycle stopped at "${includePath}".`,
              });
            } else {
              const includeSource = await readFile(resolvedPath);
              if (includeSource === null) {
                addOutlineNotice(notices, noticeKeys, {
                  kind: "missing-include",
                  filePath,
                  line: lineNumber,
                  message: `Could not resolve include "${includePath}".`,
                });
              } else {
                const subHeadings = await parseDocumentOutlineFlat(
                  resolvedPath,
                  includeSource,
                  workspaceRoot,
                  readFile,
                  new Set(ancestors),
                  occurrenceByFile,
                  notices,
                  noticeKeys,
                  files,
                  followIncludes,
                );
                flat.push(...subHeadings);
              }
            }
          } else if (/#include\b/.test(line)) {
            addOutlineNotice(notices, noticeKeys, {
              kind: "dynamic-include",
              filePath,
              line: lineNumber,
              message: `Dynamic include on line ${lineNumber} is not indexed.`,
            });
          }
          if (/#import\b/.test(line)) {
            const importMatch = line.match(/#import\s*(?:\(\s*)?["']([^"']+)["']/);
            const importPath = importMatch?.[1] ?? "";
            if (
              importPath.toLowerCase().endsWith(".typ")
              && !importPath.startsWith("@")
              && !importPath.includes("://")
            ) {
              addOutlineNotice(notices, noticeKeys, {
                kind: "import-not-supported",
                filePath,
                line: lineNumber,
                message: `Imported Typst modules are not indexed: "${importPath}".`,
              });
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

function flattenOutlinePreviewItems(items: readonly OutlinePreviewItem[]): OutlinePreviewItem[] {
  return items.flatMap(item => [item, ...flattenOutlinePreviewItems(item.children)]);
}

type StandalonePdfOutlineItem = PdfiumOutlineItem & {
  id: string;
  children: StandalonePdfOutlineItem[];
};

function identifyPdfOutline(
  items: readonly PdfiumOutlineItem[],
  prefix = "pdf",
): StandalonePdfOutlineItem[] {
  return items.map((item, index) => {
    const id = `${prefix}:${index}`;
    return { ...item, id, children: identifyPdfOutline(item.children, id) };
  });
}

function flattenPdfOutline(items: readonly StandalonePdfOutlineItem[]): StandalonePdfOutlineItem[] {
  return items.flatMap(item => [item, ...flattenPdfOutline(item.children)]);
}

function comparableTitle(title: string): string {
  return title
    .replace(/^\s*\d+(?:\.\d+)*[.:]?\s+/u, "")
    .replace(/[\s*_`~#]+/g, "")
    .toLocaleLowerCase();
}

export function matchOutlinePreviewPositions(
  headings: readonly DocumentHeading[],
  items: readonly OutlinePreviewItem[],
): void {
  const flatHeadings = flattenHeadings(headings);
  for (const heading of flatHeadings) {
    heading.previewPosition = undefined;
    heading.previewBookmarkIndex = undefined;
  }
  const rendered = flattenOutlinePreviewItems(items);
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
  for (const heading of flatHeadings) {
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
  }
}

export function outlineSourceSnapshot(
  headings: readonly DocumentHeading[],
): PreviewSourceOutlineItem[] {
  const convert = (heading: DocumentHeading): PreviewSourceOutlineItem => ({
    title: heading.title,
    bookmarkIndex: heading.previewBookmarkIndex,
    position: heading.previewPosition
      ? { ...heading.previewPosition }
      : undefined,
    children: heading.children.map(convert),
  });
  return headings.map(convert);
}

export class DocumentOutlineController {
  private headings: DocumentHeading[] = [];
  private flatHeadings: DocumentHeading[] = [];
  private readonly collapsed = new Set<string>();
  private cursor = 0;
  private activePath: string | null = null;
  private activeHeadingKey: string | null = null;
  private selectedHeadingId: string | null = null;
  private pdfOutline: StandalonePdfOutlineItem[] | null = null;
  private flatPdfOutline: StandalonePdfOutlineItem[] = [];
  private previewOutlineItems: readonly OutlinePreviewItem[] = [];
  private projectFiles = new Set<string>();
  private pendingPreviewSyncHeadingKey: string | null = null;

  constructor(
    private readonly container: HTMLElement,
    _section: HTMLElement,
    private readonly onNavigate: (heading: DocumentHeading) => void,
    private readonly onNavigatePdf?: (destination: PdfiumDestination) => void,
    private readonly onActiveHeadingChanged?: (heading: DocumentHeading) => void,
    private readonly onChanged?: () => void,
    private readonly onNotices?: (notices: readonly DocumentOutlineNotice[]) => void,
  ) {}

  public initialize(): void {
    this.container.tabIndex = 0;
    this.container.setAttribute("role", "tree");
    this.container.setAttribute("aria-label", "Document Outline");
    this.container.addEventListener("focus", () => this.ensureKeyboardSelection());
    this.container.addEventListener("keydown", event => this.handleKeyboardNavigation(event));
    this.render();
  }

  public async update(
    path: string | null,
    source: string,
    workspaceRoot: string,
    readFile: (path: string) => Promise<string | null>,
    isCurrent: () => boolean = () => true,
    followIncludes = true,
  ): Promise<void> {
    const parsed = path?.toLowerCase().endsWith(".typ")
      ? await parseDocumentOutlineDetailed(path, source, workspaceRoot, readFile, { followIncludes })
      : { headings: [], notices: [], files: [] };
    if (!isCurrent()) return;
    if (followIncludes) {
      this.projectFiles = new Set(parsed.files.map(filePathKey));
    }
    this.onNotices?.(parsed.notices);
    this.pdfOutline = null;
    this.flatPdfOutline = [];
    this.headings = parsed.headings;
    matchOutlinePreviewPositions(this.headings, this.previewOutlineItems);
    this.flatHeadings = flattenHeadings(this.headings);
    const validIds = new Set(this.flatHeadings.map(heading => heading.id));
    for (const id of this.collapsed) {
      if (!validIds.has(id)) this.collapsed.delete(id);
    }
    if (this.selectedHeadingId && !validIds.has(this.selectedHeadingId)) this.selectedHeadingId = null;
    this.render();
    this.setCursorPosition(this.cursor);
    this.onChanged?.();
  }

  public clear(): void {
    this.headings = [];
    this.flatHeadings = [];
    this.cursor = 0;
    this.activePath = null;
    this.activeHeadingKey = null;
    this.selectedHeadingId = null;
    this.pdfOutline = null;
    this.flatPdfOutline = [];
    this.previewOutlineItems = [];
    this.projectFiles.clear();
    this.onNotices?.([]);
    this.pendingPreviewSyncHeadingKey = null;
    this.collapsed.clear();
    this.render();
    this.onChanged?.();
  }

  public setActiveFilePath(activePath: string | null): void {
    const previousPathKey = this.activePath ? filePathKey(this.activePath) : null;
    const nextPathKey = activePath ? filePathKey(activePath) : null;
    this.activePath = activePath;
    if (previousPathKey !== nextPathKey) this.updateFileEmphasis();
  }

  public setCursorPosition(
    cursor: number,
    activePath: string | null = this.activePath,
    syncPreview = false,
  ): void {
    if (this.pdfOutline !== null) return;
    this.cursor = cursor;
    this.setActiveFilePath(activePath);
    let active: DocumentHeading | undefined;
    const activePathKey = activePath ? filePathKey(activePath) : null;
    for (const heading of this.flatHeadings) {
      if (activePathKey && filePathKey(heading.filePath) === activePathKey) {
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

  public hasProjectFile(path: string): boolean {
    return this.projectFiles.has(filePathKey(path));
  }

  public hasProjectFiles(): boolean {
    return this.projectFiles.size > 0;
  }

  public previewPositionAt(cursor: number): PreviewDocumentPosition | undefined {
    let position: PreviewDocumentPosition | undefined;
    const activePathKey = this.activePath ? filePathKey(this.activePath) : null;
    for (const heading of this.flatHeadings) {
      if (activePathKey && filePathKey(heading.filePath) === activePathKey) {
        if (heading.from > cursor) break;
        if (heading.previewPosition) position = heading.previewPosition;
      }
    }
    return position;
  }

  public updatePreviewPositions(items: readonly OutlinePreviewItem[]): void {
    this.previewOutlineItems = items;
    matchOutlinePreviewPositions(this.headings, items);
    for (const heading of this.flatHeadings) {
      const headingKey = `${heading.filePath}\0${heading.id}`;
      if (
        this.pendingPreviewSyncHeadingKey === headingKey
        && (heading.previewPosition !== undefined || heading.previewBookmarkIndex !== undefined)
      ) {
        this.pendingPreviewSyncHeadingKey = null;
        this.onActiveHeadingChanged?.(heading);
      }
    }
    this.onChanged?.();
  }

  public setStandalonePdfOutline(items: readonly PdfiumOutlineItem[]): void {
    this.pdfOutline = identifyPdfOutline(items);
    this.flatPdfOutline = flattenPdfOutline(this.pdfOutline);
    this.selectedHeadingId = null;
    this.activeHeadingKey = null;
    this.collapsed.clear();
    this.render();
    this.onChanged?.();
  }

  public clearStandalonePdfOutline(): void {
    if (this.pdfOutline === null) return;
    this.pdfOutline = null;
    this.flatPdfOutline = [];
    this.selectedHeadingId = null;
    this.render();
    this.setCursorPosition(this.cursor);
    this.onChanged?.();
  }

  private updateFileEmphasis(): void {
    const activeKey = this.activePath ? filePathKey(this.activePath) : null;
    const activeFileHasHeadings = !!activeKey
      && this.flatHeadings.some(heading => filePathKey(heading.filePath) === activeKey);
    this.container.querySelectorAll<HTMLElement>(".outline-item[data-outline-file]").forEach(row => {
      const fileKey = row.dataset.outlineFile ? filePathKey(row.dataset.outlineFile) : null;
      row.classList.toggle(
        "outline-item-other-file",
        activeFileHasHeadings && !!fileKey && fileKey !== activeKey,
      );
    });
  }

  public waitForPreviewPosition(heading: DocumentHeading): void {
    const current = this.findHeading(heading.id) ?? heading;
    if (current.previewPosition !== undefined || current.previewBookmarkIndex !== undefined) return;
    this.pendingPreviewSyncHeadingKey = `${current.filePath}\0${current.id}`;
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
    if (count) count.textContent = String(
      this.pdfOutline === null ? this.flatHeadings.length : this.flatPdfOutline.length,
    );
    if (this.pdfOutline !== null) {
      if (!this.pdfOutline.length) {
        this.selectedHeadingId = null;
        const empty = document.createElement("div");
        empty.className = "outline-empty";
        empty.textContent = "No bookmarks in this PDF.";
        this.container.replaceChildren(empty);
        return;
      }
      this.container.replaceChildren(this.renderPdfLevel(this.pdfOutline));
      return;
    }
    if (!this.headings.length) {
      this.selectedHeadingId = null;
      const empty = document.createElement("div");
      empty.className = "outline-empty";
      empty.textContent = "No headings in this outline.";
      this.container.replaceChildren(empty);
      return;
    }
    this.container.replaceChildren(this.renderLevel(this.headings));
    this.updateFileEmphasis();
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
      if (this.pdfOutline !== null) {
        const item = this.flatPdfOutline.find(item => item.id === selected.dataset.outlineId);
        if (item?.destination) this.onNavigatePdf?.(item.destination);
        return;
      }
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
      row.dataset.outlineFile = heading.filePath;
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

  private renderPdfLevel(items: readonly StandalonePdfOutlineItem[]): HTMLUListElement {
    const list = document.createElement("ul");
    list.className = "outline-list";
    for (const outlineItem of items) {
      const item = document.createElement("li");
      item.className = "outline-node";
      const row = document.createElement("div");
      row.className = `outline-item${this.selectedHeadingId === outlineItem.id ? " keyboard-selected" : ""}`;
      row.dataset.outlineId = outlineItem.id;
      row.setAttribute("role", "treeitem");
      row.setAttribute("aria-selected", String(this.selectedHeadingId === outlineItem.id));
      row.title = outlineItem.destination
        ? `${outlineItem.title} (page ${outlineItem.destination.pageNo})`
        : outlineItem.title;

      const disclosure = document.createElement("button");
      disclosure.type = "button";
      disclosure.tabIndex = -1;
      disclosure.className = "outline-disclosure";
      if (outlineItem.children.length) {
        const isCollapsed = this.collapsed.has(outlineItem.id);
        disclosure.appendChild(createAppIcon("chevronDown", { size: 14 }));
        disclosure.classList.toggle("collapsed", isCollapsed);
        disclosure.setAttribute("aria-label", `${isCollapsed ? "Expand" : "Collapse"} ${outlineItem.title}`);
        disclosure.setAttribute("aria-expanded", String(!isCollapsed));
        disclosure.addEventListener("click", event => {
          event.stopPropagation();
          this.selectedHeadingId = outlineItem.id;
          if (isCollapsed) this.collapsed.delete(outlineItem.id);
          else this.collapsed.add(outlineItem.id);
          this.render();
        });
      } else {
        disclosure.classList.add("placeholder");
        disclosure.disabled = true;
        disclosure.setAttribute("aria-hidden", "true");
      }

      const label = document.createElement("button");
      label.type = "button";
      label.tabIndex = -1;
      label.className = "outline-label";
      label.textContent = outlineItem.title;
      if (outlineItem.destination) {
        label.addEventListener("click", () => {
          this.selectedHeadingId = outlineItem.id;
          this.onNavigatePdf?.(outlineItem.destination!);
        });
      } else {
        label.setAttribute("aria-disabled", "true");
      }
      row.append(disclosure, label);
      item.appendChild(row);
      if (outlineItem.children.length) {
        const children = this.renderPdfLevel(outlineItem.children);
        children.classList.toggle("hidden", this.collapsed.has(outlineItem.id));
        item.appendChild(children);
      }
      list.appendChild(item);
    }
    return list;
  }
}
