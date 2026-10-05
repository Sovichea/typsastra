import {
  CheckMenuItem,
  Menu,
  MenuItem,
  PredefinedMenuItem,
  Submenu,
} from "@tauri-apps/api/menu";
import type { MenuItemOptions, PredefinedMenuItemOptions } from "@tauri-apps/api/menu";
import { getName } from "@tauri-apps/api/app";
import type { Resource } from "@tauri-apps/api/core";
import { resolveRuntimeTitlebar, type RuntimeTitlebarInput } from "./runtimeTitlebar";
import {
  buildNativeMenuSpec,
  setNativeAppMenuInstalled,
  workspaceScopedMenuIds,
  type NativeMenuNode,
} from "./nativeAppMenuSpec";
import { applicationShortcuts, shortcutFor, type ShortcutOverrides } from "./shortcutRegistry";

export interface NativeAppMenuDependencies {
  shortcuts(): ShortcutOverrides;
  wordWrapEnabled(): boolean;
  editorToolbarVisible(): boolean;
  workspaceOpen(): boolean;
  recentProjects(): readonly string[];
  openRecentProject(path: string): void;
  showAllRecentProjects(): void;
}

export interface NativeAppMenuCheckState {
  wordWrap: boolean;
  editorToolbar: boolean;
}

export interface NativeAppMenuHandle {
  syncShortcuts(shortcuts: ShortcutOverrides): void;
  setShortcutCaptureActive(active: boolean): Promise<void>;
  syncCheckState(state: NativeAppMenuCheckState): void;
  syncWorkspaceState(open: boolean): void;
  refreshRecentProjects(): void;
  dispose(): Promise<void>;
}

type ActionMenuItem = MenuItem | CheckMenuItem;

export function menuAccelerator(value: string): string | undefined {
  // Native menus only accept single strokes. Chords remain available through
  // the application key dispatcher even on macOS.
  return value && !value.includes(" ") ? value.replace(/\bMod\b/g, "CmdOrCtrl").replace(/-/g, "+") : undefined;
}

export function nativeAppMenuSupported(input?: RuntimeTitlebarInput): boolean {
  const state = resolveRuntimeTitlebar(input ?? {
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    search: window.location.search,
    dev: (import.meta as ImportMeta & { env?: { DEV?: boolean } }).env?.DEV === true,
  });
  return state.mode === "native-macos"
    && !state.simulated
    && new URLSearchParams(window.location.search).get("mode") !== "preview";
}

function projectName(path: string): string {
  return path.split(/[/\\]/).filter(Boolean).pop() || path;
}

async function buildRecentSubmenu(
  projects: readonly string[],
  deps: NativeAppMenuDependencies,
): Promise<Submenu> {
  const items: Array<MenuItemOptions | PredefinedMenuItemOptions> = [];
  if (projects.length === 0) {
    items.push({ text: "No recent projects", enabled: false });
  } else {
    for (const path of projects) {
      items.push({
        text: projectName(path),
        action: () => deps.openRecentProject(path),
      });
    }
  }
  items.push({ item: "Separator" });
  items.push({
    text: "Show All Recent Projects…",
    action: () => deps.showAllRecentProjects(),
  });
  return Submenu.new({ text: "Open Recent", items });
}

async function materializeNode(
  node: NativeMenuNode,
  deps: NativeAppMenuDependencies,
  items: Map<string, ActionMenuItem>,
): Promise<Submenu | MenuItem | CheckMenuItem | PredefinedMenuItem | null> {
  switch (node.kind) {
    case "item": {
      const item = await MenuItem.new({
        id: node.id,
        text: node.label,
        enabled: node.workspaceScoped ? deps.workspaceOpen() : undefined,
        accelerator: menuAccelerator(shortcutFor(node.id, deps.shortcuts(), true)),
        action: () => document.getElementById(node.elementId)?.click(),
      });
      items.set(node.id, item);
      return item;
    }
    case "check": {
      const item = await CheckMenuItem.new({
        id: node.id,
        text: node.label,
        checked: node.check === "wordWrap" ? deps.wordWrapEnabled() : deps.editorToolbarVisible(),
        enabled: node.workspaceScoped ? deps.workspaceOpen() : undefined,
        accelerator: menuAccelerator(shortcutFor(node.id, deps.shortcuts(), true)),
        action: () => document.getElementById(node.elementId)?.click(),
      });
      items.set(node.id, item);
      return item;
    }
    case "predefined":
      return PredefinedMenuItem.new({ item: node.item, text: node.text });
    case "recent-placeholder":
      return buildRecentSubmenu(deps.recentProjects(), deps);
    case "separator":
      return PredefinedMenuItem.new({ item: "Separator" });
  }
}

class NativeAppMenuHandleImpl implements NativeAppMenuHandle {
  private readonly accelerators = new Map<string, string>();
  private shortcutCaptureActive = false;
  private shortcutChanges = Promise.resolve();
  private lastWorkspaceOpen: boolean;
  private lastWordWrap: boolean;
  private lastEditorToolbar: boolean;
  private recentSubmenu: Submenu | null = null;
  private recentRebuild = Promise.resolve();

  constructor(
    private readonly deps: NativeAppMenuDependencies,
    private readonly items: Map<string, ActionMenuItem>,
    private readonly scopedIds: readonly string[],
    private readonly menu: Menu,
    private readonly resources: Resource[],
    private readonly fileSubmenu: Submenu | null,
    private readonly recentIndex: number,
    initialRecent: Submenu | null,
  ) {
    this.lastWorkspaceOpen = deps.workspaceOpen();
    this.lastWordWrap = deps.wordWrapEnabled();
    this.lastEditorToolbar = deps.editorToolbarVisible();
    this.recentSubmenu = initialRecent;
  }

  syncShortcuts(shortcuts: ShortcutOverrides): void {
    if (this.shortcutCaptureActive) return;
    for (const { id } of applicationShortcuts) {
      if (!this.items.has(id)) continue;
      const value = shortcutFor(id, shortcuts, true);
      if (this.accelerators.get(id) === value) continue;
      this.accelerators.set(id, value);
      void this.queueAccelerator(id, menuAccelerator(value) ?? null).catch(error => {
        console.warn(`Could not update native shortcut ${id}:`, error);
      });
    }
  }

  setShortcutCaptureActive(active: boolean): Promise<void> {
    if (active === this.shortcutCaptureActive) return this.shortcutChanges;
    this.shortcutCaptureActive = active;
    if (active) {
      // macOS menu accelerators execute before a WebView keydown. Release them
      // while the recorder is open so Cmd+S, Cmd+Q and friends can be captured.
      const changes = applicationShortcuts
        .filter(({ id }) => this.items.has(id))
        .map(({ id }) => this.queueAccelerator(id, null));
      return Promise.all(changes).then(() => undefined);
    } else {
      this.accelerators.clear();
      this.syncShortcuts(this.deps.shortcuts());
      return this.shortcutChanges;
    }
  }

  private queueAccelerator(id: string, value: string | null): Promise<void> {
    const change = this.shortcutChanges
      .then(() => this.items.get(id)?.setAccelerator(value))
      .then(() => undefined);
    // A failed item must not block later changes, but its caller still receives
    // the rejection so the recorder knows it isn't safe to start listening.
    this.shortcutChanges = change.catch(() => {});
    return change;
  }

  syncWorkspaceState(open: boolean): void {
    if (this.lastWorkspaceOpen === open) return;
    this.lastWorkspaceOpen = open;
    for (const id of this.scopedIds) {
      this.items.get(id)?.setEnabled(open).catch(() => {});
    }
  }

  syncCheckState(state: NativeAppMenuCheckState): void {
    if (state.wordWrap === this.lastWordWrap && state.editorToolbar === this.lastEditorToolbar) return;
    if (state.wordWrap !== this.lastWordWrap) {
      this.lastWordWrap = state.wordWrap;
      const item = this.items.get("action-toggle-word-wrap");
      if (item instanceof CheckMenuItem) void item.setChecked(state.wordWrap).catch(() => {});
    }
    if (state.editorToolbar !== this.lastEditorToolbar) {
      this.lastEditorToolbar = state.editorToolbar;
      const item = this.items.get("action-toggle-editor-toolbar");
      if (item instanceof CheckMenuItem) void item.setChecked(state.editorToolbar).catch(() => {});
    }
  }

  refreshRecentProjects(): void {
    this.recentRebuild = this.recentRebuild
      .then(() => this.rebuildRecentSubmenu())
      .catch(() => {});
  }

  private async rebuildRecentSubmenu(): Promise<void> {
    if (!this.fileSubmenu || this.recentIndex < 0) return;
    const next = await buildRecentSubmenu(this.deps.recentProjects(), this.deps);
    await this.fileSubmenu.removeAt(this.recentIndex);
    await this.fileSubmenu.insert(next, this.recentIndex);
    const previous = this.recentSubmenu;
    this.recentSubmenu = next;
    if (previous) await previous.close().catch(() => {});
  }

  async dispose(): Promise<void> {
    for (const item of this.items.values()) await item.close().catch(() => {});
    if (this.recentSubmenu) await this.recentSubmenu.close().catch(() => {});
    for (const resource of this.resources) await resource.close().catch(() => {});
    void this.menu.close().catch(() => {});
  }
}

export async function installNativeAppMenu(
  deps: NativeAppMenuDependencies,
): Promise<NativeAppMenuHandle | null> {
  if (!nativeAppMenuSupported()) return null;
  try {
    const productName = await getName();
    const spec = buildNativeMenuSpec(productName);
    const items = new Map<string, ActionMenuItem>();
    const resources: Resource[] = [];
    const submenus: Submenu[] = [];
    let fileSubmenu: Submenu | null = null;
    let recentIndex = -1;
    let initialRecent: Submenu | null = null;

    for (const submenuSpec of spec) {
      const submenu = await Submenu.new({ text: submenuSpec.label, items: [] });
      resources.push(submenu);
      for (const node of submenuSpec.nodes) {
        const materialized = await materializeNode(node, deps, items);
        if (materialized) await submenu.append(materialized);
        if (node.kind === "recent-placeholder") {
          fileSubmenu = submenu;
          recentIndex = submenuSpec.nodes.indexOf(node);
          if (materialized instanceof Submenu) initialRecent = materialized;
        }
      }
      submenus.push(submenu);
    }

    const menu = await Menu.new({ items: submenus });
    await menu.setAsAppMenu();
    const windowSubmenu = submenus[spec.findIndex(submenu => submenu.role === "window")];
    if (windowSubmenu) await windowSubmenu.setAsWindowsMenuForNSApp();
    const helpSubmenu = submenus[spec.findIndex(submenu => submenu.role === "help")];
    if (helpSubmenu) await helpSubmenu.setAsHelpMenuForNSApp();

    setNativeAppMenuInstalled(true);
    document.documentElement.classList.add("native-app-menu");
    return new NativeAppMenuHandleImpl(
      deps,
      items,
      workspaceScopedMenuIds(spec),
      menu,
      resources,
      fileSubmenu,
      recentIndex,
      initialRecent,
    );
  } catch (error) {
    console.warn("Failed to install the native macOS application menu:", error);
    return null;
  }
}
