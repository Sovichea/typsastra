import type { EditorTab } from "./editorTab";
import { fileNameFromPath, filePathKey } from "../platform/paths";
import { createAppIcon } from "../ui/icons";

type EditorTabViewDependencies = {
  tabs: () => EditorTab[];
  activeFilePath: () => string | null;
  pinnedMainFilePath: () => string | null;
  sortPinnedMainFirst: () => void;
  activateTab: (path: string) => Promise<void>;
  closeTab: (path: string) => Promise<void> | void;
  promoteTab: (tab: EditorTab) => Promise<void> | void;
  reportActivationFailure: (path: string, error: unknown) => void;
};

type TabListElements = {
  container: HTMLElement;
  button: HTMLButtonElement;
  menu: HTMLElement;
};

export type TabListItem = {
  path: string;
  title: string;
  active: boolean;
  dirty: boolean;
  pinnedMain: boolean;
  offProject: boolean;
};

export function tabListItems(
  tabs: readonly EditorTab[],
  activeFilePath: string | null,
  pinnedMainFilePath: string | null,
): TabListItem[] {
  return tabs.map(tab => ({
    path: tab.path,
    title: fileNameFromPath(tab.path),
    active: !!activeFilePath && filePathKey(tab.path) === filePathKey(activeFilePath),
    dirty: tab.isDirty,
    pinnedMain: !!pinnedMainFilePath
      && filePathKey(tab.path) === filePathKey(pinnedMainFilePath),
    offProject: tab.offProject === true,
  }));
}

export class EditorTabViewController {
  private tabListOpen = false;

  constructor(
    private readonly tabBar: HTMLElement,
    private readonly deps: EditorTabViewDependencies,
    private readonly tabList?: TabListElements,
  ) {}

  public initialize(): void {
    if (!this.tabList) return;
    this.tabList.button.addEventListener("click", () => {
      this.setTabListOpen(!this.tabListOpen);
    });
    this.tabList.button.addEventListener("keydown", event => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        this.setTabListOpen(true);
        const items = this.tabListMenuItems();
        items[event.key === "ArrowDown" ? 0 : items.length - 1]?.focus();
      }
    });
    this.tabList.menu.addEventListener("keydown", event => this.handleTabListKeydown(event));
    document.addEventListener("pointerdown", event => {
      if (!this.tabListOpen || this.tabList?.container.contains(event.target as Node)) return;
      this.setTabListOpen(false);
    });
    document.addEventListener("keydown", event => {
      if (event.key !== "Escape" || !this.tabListOpen) return;
      this.setTabListOpen(false);
      this.tabList?.button.focus();
    });
    this.renderTabList();
  }

  render(): void {
    this.deps.sortPinnedMainFirst();
    this.tabBar.innerHTML = "";

    const activeFilePath = this.deps.activeFilePath();
    const pinnedMainFilePath = this.deps.pinnedMainFilePath();
    for (const tab of this.deps.tabs()) {
      const isActive = tab.path === activeFilePath;
      const isPinnedMain = Boolean(
        pinnedMainFilePath && filePathKey(tab.path) === filePathKey(pinnedMainFilePath),
      );
      const tabButton = document.createElement("button");
      tabButton.className = `editor-tab${isActive ? " active" : ""}${tab.isDirty ? " dirty" : ""}${tab.temporary ? " temporary" : ""}${isPinnedMain ? " pinned-main-tab" : ""}${tab.offProject ? " off-project" : ""}`;
      tabButton.type = "button";
      tabButton.role = "tab";
      tabButton.title = tab.path;
      tabButton.setAttribute("aria-selected", String(isActive));
      tabButton.dataset.path = tab.path;

      const title = document.createElement("span");
      title.className = "editor-tab-title";
      title.textContent = fileNameFromPath(tab.path);
      tabButton.appendChild(title);

      const dirtyDot = document.createElement("span");
      dirtyDot.className = "editor-tab-dirty";
      dirtyDot.setAttribute("aria-hidden", "true");
      tabButton.appendChild(dirtyDot);

      if (!isPinnedMain) {
        const closeButton = document.createElement("span");
        closeButton.className = "editor-tab-close";
        closeButton.appendChild(createAppIcon("x", { size: 13 }));
        closeButton.title = "Close";
        closeButton.setAttribute("aria-label", `Close ${fileNameFromPath(tab.path)}`);
        tabButton.appendChild(closeButton);
        closeButton.addEventListener("click", event => {
          event.stopPropagation();
          void this.deps.closeTab(tab.path);
        });
      }

      tabButton.addEventListener("click", () => {
        void this.deps.activateTab(tab.path).catch(error => {
          this.deps.reportActivationFailure(tab.path, error);
        });
      });
      tabButton.addEventListener("dblclick", () => {
        void this.deps.promoteTab(tab);
      });
      this.tabBar.appendChild(tabButton);
    }
    this.renderTabList();
  }

  private renderTabList(): void {
    if (!this.tabList) return;
    const items = tabListItems(
      this.deps.tabs(),
      this.deps.activeFilePath(),
      this.deps.pinnedMainFilePath(),
    );
    this.tabList.button.disabled = items.length === 0;
    this.tabList.menu.replaceChildren(...items.map(item => {
      const button = document.createElement("button");
      button.type = "button";
      button.role = "menuitem";
      button.className = `editor-tab-list-item${item.active ? " active" : ""}`;
      button.dataset.path = item.path;
      button.title = item.path;
      if (item.active) button.setAttribute("aria-current", "page");

      const check = document.createElement("span");
      check.className = "editor-tab-list-item-check";
      check.textContent = item.active ? "✓" : "";
      check.setAttribute("aria-hidden", "true");
      button.appendChild(check);

      const title = document.createElement("span");
      title.className = "editor-tab-list-item-title";
      title.textContent = item.title;
      button.appendChild(title);

      if (item.pinnedMain) {
        const main = document.createElement("span");
        main.className = "editor-tab-list-item-main";
        main.textContent = "main";
        button.appendChild(main);
      }
      if (item.dirty) {
        const dirty = document.createElement("span");
        dirty.className = "editor-tab-list-item-dirty";
        dirty.title = "Unsaved changes";
        dirty.setAttribute("aria-label", "Unsaved changes");
        button.appendChild(dirty);
      }

      button.addEventListener("click", () => {
        this.setTabListOpen(false);
        void this.deps.activateTab(item.path).catch(error => {
          this.deps.reportActivationFailure(item.path, error);
        });
      });
      return button;
    }));
  }

  private setTabListOpen(open: boolean): void {
    if (!this.tabList) return;
    this.tabListOpen = open;
    this.tabList.container.classList.toggle("active", open);
    this.tabList.button.setAttribute("aria-expanded", String(open));
    if (!open) return;
    this.renderTabList();
    const items = this.tabListMenuItems();
    const activeIndex = items.findIndex(item => item.classList.contains("active"));
    items[Math.max(0, activeIndex)]?.focus();
  }

  private tabListMenuItems(): HTMLButtonElement[] {
    if (!this.tabList) return [];
    return [...this.tabList.menu.querySelectorAll<HTMLButtonElement>(".editor-tab-list-item")];
  }

  private handleTabListKeydown(event: KeyboardEvent): void {
    const items = this.tabListMenuItems();
    if (!items.length) return;
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    let next = -1;
    if (event.key === "ArrowDown") next = (current + 1) % items.length;
    else if (event.key === "ArrowUp") next = (current - 1 + items.length) % items.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = items.length - 1;
    if (next === -1) return;
    event.preventDefault();
    items[next].focus();
  }
}
