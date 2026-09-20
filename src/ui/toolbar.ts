import { createAppIcon, type AppIconName } from "./icons";

/** A select option shared by toolbars. */
export type ToolbarSelectOption = { value: string; label: string };

/** A row inside a toolbar dropdown menu. */
export type ToolbarMenuEntry =
  | { kind: "item"; label: string; icon?: AppIconName; checked?: boolean; disabled?: boolean; onSelect: () => void }
  | { kind: "toggle"; label: string; icon?: AppIconName; checked: boolean; onSelect: () => void }
  | { kind: "separator" }
  | { kind: "heading"; label: string }
  | {
      kind: "choices";
      values: readonly number[];
      current: () => number;
      format?: (value: number) => string;
      onSelect: (value: number) => void;
    }
  | { kind: "color"; value: string; onInput: (value: string) => void };

/** A control placed directly on a toolbar. */
export type ToolbarEntry =
  | { kind: "menu"; id: string; label: string; entries: () => readonly ToolbarMenuEntry[] }
  | {
      kind: "toggle";
      id: string;
      title: string;
      icon: AppIconName;
      active?: boolean;
      disabled?: boolean;
      onSelect: () => void;
    }
  | {
      kind: "select";
      id: string;
      label: string;
      value: string;
      disabled?: boolean;
      options: readonly ToolbarSelectOption[];
      onChange: (value: string) => void;
    }
  | { kind: "separator" };

export type SharedToolbar = {
  element: HTMLElement;
  /** Sets the active (pressed) state of a toggle or menu button. */
  setActive(id: string, active: boolean): void;
  /** Disables the control with the given id. */
  setDisabled(id: string, disabled: boolean): void;
  /** Updates the value of a select control. */
  setSelectValue(id: string, value: string): void;
  /** Opens a menu at a viewport position, e.g. for a context menu. */
  openMenuAt(position: { left: number; top: number }, entries: () => readonly ToolbarMenuEntry[]): void;
  closeMenus(): void;
  dispose(): void;
};

function buildMenuItem(entry: Extract<ToolbarMenuEntry, { kind: "item" | "toggle" }>, rebuild: () => void): HTMLElement {
  const item = document.createElement("div");
  item.className = "dropdown-item app-menu-item";
  item.setAttribute("role", "menuitem");
  if (entry.kind === "item" && entry.disabled) item.classList.add("dropdown-item-disabled");
  if (entry.icon) item.appendChild(createAppIcon(entry.icon, { size: 14, className: "app-menu-icon" }));
  const label = document.createElement("span");
  label.className = "app-menu-label";
  label.textContent = entry.checked ? `✓ ${entry.label}` : entry.label;
  item.appendChild(label);
  if (entry.kind !== "item" || !entry.disabled) {
    item.addEventListener("click", () => {
      entry.onSelect();
      rebuild();
    });
  }
  return item;
}

function buildMenu(
  menu: HTMLElement,
  entries: readonly ToolbarMenuEntry[],
  rebuild: () => void,
): void {
  menu.replaceChildren();
  entries.forEach(entry => {
    if (entry.kind === "separator") {
      const separator = document.createElement("div");
      separator.className = "dropdown-separator";
      menu.appendChild(separator);
      return;
    }
    if (entry.kind === "heading") {
      const heading = document.createElement("div");
      heading.className = "app-menu-heading";
      heading.textContent = entry.label;
      menu.appendChild(heading);
      return;
    }
    if (entry.kind === "choices") {
      const row = document.createElement("div");
      row.className = "app-menu-choices";
      entry.values.forEach(value => {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = (entry.format ?? String)(value);
        if (entry.current() === value) button.classList.add("active");
        button.addEventListener("click", () => {
          entry.onSelect(value);
          rebuild();
        });
        row.appendChild(button);
      });
      menu.appendChild(row);
      return;
    }
    if (entry.kind === "color") {
      const row = document.createElement("div");
      row.className = "app-menu-color";
      const input = document.createElement("input");
      input.type = "color";
      input.value = entry.value;
      input.addEventListener("input", () => entry.onInput(input.value));
      row.appendChild(input);
      menu.appendChild(row);
      return;
    }
    menu.appendChild(buildMenuItem(entry, rebuild));
  });
}

/** Builds a toolbar of toggle buttons, selects, and dropdown menus. */
export function createToolbar(options: {
  entries: readonly ToolbarEntry[];
  ariaLabel?: string;
  className?: string;
}): SharedToolbar {
  const buttons = new Map<string, HTMLButtonElement>();
  const selects = new Map<string, HTMLSelectElement>();
  const element = document.createElement("div");
  element.className = ["app-toolbar", options.className].filter(Boolean).join(" ");
  element.setAttribute("role", "toolbar");
  if (options.ariaLabel) element.setAttribute("aria-label", options.ariaLabel);

  let activeMenu: HTMLElement | null = null;
  let activeAnchor: HTMLElement | null = null;
  let activeEntries: (() => readonly ToolbarMenuEntry[]) | null = null;
  let menuCleanup: (() => void) | null = null;

  const closeMenus = (): void => {
    menuCleanup?.();
    menuCleanup = null;
    activeMenu?.remove();
    activeMenu = null;
    activeAnchor = null;
    activeEntries = null;
  };

  const rebuild = (): void => {
    const menu = activeMenu;
    const entries = activeEntries;
    if (!menu || !entries || !document.body.contains(menu)) return;
    buildMenu(menu, entries(), rebuild);
  };

  const showMenu = (
    position: { left: number; top: number },
    entries: () => readonly ToolbarMenuEntry[],
    anchor: HTMLElement | null,
  ): void => {
    closeMenus();
    const menu = document.createElement("div");
    menu.className = "dropdown-menu app-menu";
    menu.setAttribute("role", "menu");
    buildMenu(menu, entries(), rebuild);
    document.body.appendChild(menu);
    menu.style.left = `${Math.max(8, Math.min(position.left, window.innerWidth - menu.offsetWidth - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(position.top, window.innerHeight - menu.offsetHeight - 8))}px`;
    activeMenu = menu;
    activeAnchor = anchor;
    activeEntries = entries;
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node
        && (menu.contains(event.target) || activeAnchor?.contains(event.target))) {
        // Clicks inside the menu or on its owning control must not count as
        // "outside"; the owning button toggles the menu closed.
        return;
      }
      closeMenus();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeMenus();
    };
    menuCleanup = () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
    window.setTimeout(() => {
      // The menu may have been replaced before the listeners were attached.
      if (activeMenu !== menu) return;
      document.addEventListener("pointerdown", onPointerDown, true);
      document.addEventListener("keydown", onKeyDown, true);
    }, 0);
  };

  options.entries.forEach(entry => {
    if (entry.kind === "separator") {
      const separator = document.createElement("span");
      separator.className = "app-toolbar-separator";
      element.appendChild(separator);
      return;
    }
    if (entry.kind === "select") {
      const label = document.createElement("label");
      label.className = "app-toolbar-select";
      const caption = document.createElement("span");
      caption.textContent = entry.label;
      const select = document.createElement("select");
      select.setAttribute("data-toolbar-id", entry.id);
      entry.options.forEach(option => {
        const optionElement = document.createElement("option");
        optionElement.value = option.value;
        optionElement.textContent = option.label;
        select.appendChild(optionElement);
      });
      select.value = entry.value;
      select.disabled = entry.disabled === true;
      select.addEventListener("change", () => entry.onChange(select.value));
      label.append(caption, select);
      selects.set(entry.id, select);
      element.appendChild(label);
      return;
    }
    const button = document.createElement("button");
    button.type = "button";
    button.className = entry.kind === "menu" ? "toolbar-button app-toolbar-menu" : "toolbar-button app-toolbar-toggle";
    button.setAttribute("data-toolbar-id", entry.id);
    const title = entry.kind === "menu" ? entry.label : entry.title;
    button.title = title;
    button.setAttribute("aria-label", title);
    if (entry.kind === "menu") {
      const caption = document.createElement("span");
      caption.textContent = entry.label;
      button.appendChild(caption);
      button.appendChild(createAppIcon("chevronDown", { size: 12, className: "app-toolbar-caret" }));
      button.addEventListener("click", event => {
        event.stopPropagation();
        if (activeMenu && activeAnchor === button) {
          closeMenus();
          return;
        }
        const rect = button.getBoundingClientRect();
        showMenu({ left: rect.left, top: rect.bottom + 4 }, entry.entries, button);
      });
    } else {
      button.classList.toggle("active", entry.active === true);
      button.disabled = entry.disabled === true;
      button.appendChild(createAppIcon(entry.icon, { size: 14 }));
      button.addEventListener("click", () => entry.onSelect());
    }
    buttons.set(entry.id, button);
    element.appendChild(button);
  });

  return {
    element,
    setActive(id, active) {
      buttons.get(id)?.classList.toggle("active", active);
    },
    setDisabled(id, disabled) {
      const button = buttons.get(id);
      if (button) button.disabled = disabled;
      const select = selects.get(id);
      if (select) select.disabled = disabled;
    },
    setSelectValue(id, value) {
      const select = selects.get(id);
      if (select) select.value = value;
    },
    openMenuAt(position, entries) {
      showMenu(position, entries, null);
    },
    closeMenus,
    dispose() {
      closeMenus();
      element.remove();
    },
  };
}
