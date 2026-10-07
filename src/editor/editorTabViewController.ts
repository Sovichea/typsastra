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

export class EditorTabViewController {
  constructor(
    private readonly tabBar: HTMLElement,
    private readonly deps: EditorTabViewDependencies,
  ) {}

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
  }
}
