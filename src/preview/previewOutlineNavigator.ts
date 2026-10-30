import { createAppIcon } from "../ui/icons";
import type { PdfiumDestination, PdfiumOutlineItem } from "./pdfiumDocument";
import { t } from "../i18n";

export type PreviewOutlineEntry = {
  id: string;
  title: string;
  bookmarkIndex?: number;
  destination?: PdfiumDestination | null;
  position?: { page_no: number; x: number; y: number };
  children: PreviewOutlineEntry[];
};

export type PreviewSourceOutlineItem = {
  title: string;
  bookmarkIndex?: number;
  position?: { page_no: number; x: number; y: number };
  children: PreviewSourceOutlineItem[];
};

function outlineTitle(title: string): string {
  return title.trim() || "Untitled";
}

export function sourceDocumentOutlineEntries(
  items: readonly PreviewSourceOutlineItem[],
): PreviewOutlineEntry[] {
  const convert = (item: PreviewSourceOutlineItem, id: string): PreviewOutlineEntry => ({
    id,
    title: outlineTitle(item.title),
    bookmarkIndex: item.bookmarkIndex,
    position: item.position,
    children: item.children.map((child, index) => convert(child, `${id}.${index}`)),
  });
  return items.map((item, index) => convert(item, String(index)));
}

export function standalonePdfOutlineEntries(
  items: readonly PdfiumOutlineItem[],
): PreviewOutlineEntry[] {
  const convert = (item: PdfiumOutlineItem, id: string): PreviewOutlineEntry => ({
    id,
    title: outlineTitle(item.title),
    destination: item.destination,
    children: item.children.map((child, index) => convert(child, `${id}.${index}`)),
  });
  return items.map((item, index) => convert(item, String(index)));
}

export function flattenPreviewOutlineEntries(
  entries: readonly PreviewOutlineEntry[],
): PreviewOutlineEntry[] {
  return entries.flatMap(entry => [entry, ...flattenPreviewOutlineEntries(entry.children)]);
}

export interface PreviewOutlineNavigatorOptions {
  host: HTMLElement;
  navigateBookmark(bookmarkIndex: number): void;
  navigateDestination(destination: PdfiumDestination): void;
  navigatePosition(position: { page_no: number; x: number; y: number }): void;
}

/** Floating document-outline navigator used by the undocked preview window. */
export class PreviewOutlineNavigator {
  private readonly panel: HTMLElement;
  private readonly header: HTMLElement;
  private readonly body: HTMLElement;
  private readonly count: HTMLElement;
  private readonly minimizeButton: HTMLButtonElement;
  private entries: PreviewOutlineEntry[] = [];
  private readonly collapsed = new Set<string>();
  private selectedId: string | null = null;
  private minimized = false;
  private floatingLeft: string | null = null;
  private floatingTop: string | null = null;

  public constructor(private readonly options: PreviewOutlineNavigatorOptions) {
    this.panel = document.createElement("aside");
    this.panel.className = "preview-outline-panel hidden";
    this.panel.setAttribute("aria-label", t("Preview outline"));

    this.header = document.createElement("div");
    this.header.className = "preview-outline-header";
    this.header.title = t("Drag to reposition");

    const title = document.createElement("span");
    title.className = "preview-outline-title";
    title.textContent = t("Outline");

    this.count = document.createElement("span");
    this.count.className = "preview-outline-count";
    this.count.textContent = "0";

    this.minimizeButton = document.createElement("button");
    this.minimizeButton.type = "button";
    this.minimizeButton.className = "preview-outline-minimize";
    this.minimizeButton.addEventListener("click", event => {
      event.stopPropagation();
      this.setMinimized(!this.minimized);
    });

    this.header.append(title, this.count, this.minimizeButton);

    this.body = document.createElement("div");
    this.body.className = "preview-outline-body";
    this.body.id = "preview-outline-body";
    this.body.setAttribute("role", "tree");
    this.body.setAttribute("aria-label", t("Document outline"));

    this.panel.append(this.header, this.body);
    this.options.host.appendChild(this.panel);
    this.updateMinimizeControl();

    this.header.addEventListener("pointerdown", event => this.beginDrag(event, this.header));
    window.addEventListener("resize", () => this.clampToHost());
  }

  public setVisible(visible: boolean): void {
    this.panel.classList.toggle("hidden", !visible);
  }

  public setSourceOutline(items: readonly PreviewSourceOutlineItem[]): void {
    this.entries = sourceDocumentOutlineEntries(items);
    this.render();
  }

  public setStandalonePdfOutline(items: readonly PdfiumOutlineItem[] | null): void {
    this.entries = items ? standalonePdfOutlineEntries(items) : [];
    this.render();
  }

  private setMinimized(minimized: boolean): void {
    if (this.minimized === minimized) return;
    if (minimized) {
      if (this.panel.style.left) this.floatingLeft = this.panel.style.left;
      if (this.panel.style.top) this.floatingTop = this.panel.style.top;
    }
    this.minimized = minimized;
    this.panel.classList.toggle("minimized", minimized);
    if (minimized) {
      this.panel.style.left = "12px";
      this.panel.style.top = "auto";
      this.panel.style.bottom = "12px";
    } else {
      this.panel.style.bottom = "auto";
      this.panel.style.left = this.floatingLeft ?? "12px";
      this.panel.style.top = this.floatingTop ?? "12px";
      this.clampToHost();
    }
    this.updateMinimizeControl();
  }

  private updateMinimizeControl(): void {
    const label = this.minimized ? t("Restore outline") : t("Minimize outline");
    this.minimizeButton.title = label;
    this.minimizeButton.setAttribute("aria-label", label);
    this.minimizeButton.setAttribute("aria-expanded", String(!this.minimized));
    this.minimizeButton.setAttribute("aria-controls", this.body.id);
    this.minimizeButton.classList.toggle("expand", this.minimized);
    this.minimizeButton.replaceChildren(
      createAppIcon(this.minimized ? "chevronDown" : "minimize2", { size: 13 }),
    );
    this.header.title = this.minimized ? "" : t("Drag to reposition");
  }

  private beginDrag(event: PointerEvent, handle: HTMLElement): void {
    if (this.minimized || event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
    const host = this.options.host;
    const panelRect = this.panel.getBoundingClientRect();
    const hostRect = host.getBoundingClientRect();
    const offsetX = event.clientX - panelRect.left;
    const offsetY = event.clientY - panelRect.top;
    const width = panelRect.width;
    const height = panelRect.height;

    const move = (moveEvent: PointerEvent) => {
      const maxLeft = Math.max(0, host.clientWidth - width);
      const maxTop = Math.max(0, host.clientHeight - height);
      const left = Math.max(0, Math.min(moveEvent.clientX - hostRect.left - offsetX, maxLeft));
      const top = Math.max(0, Math.min(moveEvent.clientY - hostRect.top - offsetY, maxTop));
      this.panel.style.left = `${left}px`;
      this.panel.style.top = `${top}px`;
    };
    const end = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
      handle.removeEventListener("lostpointercapture", end);
      this.panel.classList.remove("dragging");
      if (handle.hasPointerCapture(event.pointerId)) {
        handle.releasePointerCapture(event.pointerId);
      }
    };

    this.panel.classList.add("dragging");
    handle.setPointerCapture(event.pointerId);
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
    handle.addEventListener("lostpointercapture", end);
    event.preventDefault();
  }

  private clampToHost(): void {
    if (this.minimized) return;
    if (!this.panel.style.left && !this.panel.style.top) return;
    const host = this.options.host;
    const panelRect = this.panel.getBoundingClientRect();
    const hostRect = host.getBoundingClientRect();
    const left = Math.max(0, Math.min(
      panelRect.left - hostRect.left,
      Math.max(0, host.clientWidth - panelRect.width),
    ));
    const top = Math.max(0, Math.min(
      panelRect.top - hostRect.top,
      Math.max(0, host.clientHeight - panelRect.height),
    ));
    this.panel.style.left = `${left}px`;
    this.panel.style.top = `${top}px`;
  }

  private render(): void {
    this.count.textContent = String(flattenPreviewOutlineEntries(this.entries).length);
    if (!this.entries.length) {
      this.selectedId = null;
      const empty = document.createElement("div");
      empty.className = "preview-outline-empty";
      empty.textContent = t("No outline in this document.");
      this.body.replaceChildren(empty);
      return;
    }
    this.body.replaceChildren(this.renderLevel(this.entries, 1));
    this.syncSelection();
  }

  private renderLevel(entries: readonly PreviewOutlineEntry[], level: number): HTMLUListElement {
    const list = document.createElement("ul");
    list.className = "preview-outline-list";
    for (const entry of entries) {
      const item = document.createElement("li");
      item.className = "preview-outline-node";

      const row = document.createElement("div");
      row.className = "preview-outline-row";
      row.dataset.outlineId = entry.id;
      row.setAttribute("role", "treeitem");
      row.setAttribute("aria-level", String(level));
      row.setAttribute("aria-selected", "false");

      if (entry.children.length) {
        const isCollapsed = this.collapsed.has(entry.id);
        const disclosure = document.createElement("button");
        disclosure.type = "button";
        disclosure.className = "preview-outline-disclosure";
        disclosure.classList.toggle("collapsed", isCollapsed);
        disclosure.setAttribute("aria-expanded", String(!isCollapsed));
        disclosure.setAttribute("aria-label", t`${isCollapsed ? "Expand" : "Collapse"} ${entry.title}`);
        disclosure.appendChild(createAppIcon("chevronDown", { size: 12 }));
        disclosure.addEventListener("click", event => {
          event.stopPropagation();
          if (this.collapsed.has(entry.id)) this.collapsed.delete(entry.id);
          else this.collapsed.add(entry.id);
          this.render();
        });
        row.appendChild(disclosure);
      } else {
        const placeholder = document.createElement("span");
        placeholder.className = "preview-outline-disclosure placeholder";
        placeholder.setAttribute("aria-hidden", "true");
        row.appendChild(placeholder);
      }

      const label = document.createElement("button");
      label.type = "button";
      label.className = "preview-outline-label";
      label.textContent = entry.title;
      label.title = entry.title;
      const navigable = entry.position !== undefined
        || entry.bookmarkIndex !== undefined
        || Boolean(entry.destination);
      label.disabled = !navigable;
      label.classList.toggle("disabled", !navigable);
      if (navigable) label.addEventListener("click", () => this.activate(entry));
      row.appendChild(label);

      item.appendChild(row);
      if (entry.children.length) {
        const children = this.renderLevel(entry.children, level + 1);
        children.classList.toggle("hidden", this.collapsed.has(entry.id));
        item.appendChild(children);
      }
      list.appendChild(item);
    }
    return list;
  }

  private activate(entry: PreviewOutlineEntry): void {
    this.selectedId = entry.id;
    if (entry.position) {
      this.options.navigatePosition(entry.position);
    } else if (entry.bookmarkIndex !== undefined) {
      this.options.navigateBookmark(entry.bookmarkIndex);
    } else if (entry.destination) {
      this.options.navigateDestination(entry.destination);
    }
    this.syncSelection();
  }

  private syncSelection(): void {
    this.body.querySelectorAll<HTMLElement>(".preview-outline-row").forEach(row => {
      const selected = row.dataset.outlineId === this.selectedId;
      row.classList.toggle("active", selected);
      row.setAttribute("aria-selected", String(selected));
    });
  }
}
