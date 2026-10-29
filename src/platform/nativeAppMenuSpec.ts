export type PredefinedRole =
  | "Separator"
  | "Services"
  | "Hide"
  | "HideOthers"
  | "ShowAll"
  | "Minimize"
  | "Maximize"
  | "CloseWindow"
  | "BringAllToFront"
  | "Undo"
  | "Redo"
  | "Cut"
  | "Copy"
  | "Paste"
  | "SelectAll";

export type NativeMenuNode =
  | {
      kind: "item";
      id: string;
      label: string;
      accelerator?: string;
      elementId: string;
      workspaceScoped?: boolean;
    }
  | {
      kind: "check";
      id: string;
      label: string;
      accelerator?: string;
      elementId: string;
      check: "wordWrap" | "editorToolbar";
      workspaceScoped?: boolean;
    }
  | { kind: "predefined"; item: PredefinedRole; text?: string }
  | { kind: "separator" }
  | { kind: "recent-placeholder" };

export interface NativeMenuSubmenuSpec {
  label: string;
  role?: "app" | "window" | "help";
  nodes: NativeMenuNode[];
}

export function buildNativeMenuSpec(productName: string): NativeMenuSubmenuSpec[] {
  return [
    {
      label: productName,
      role: "app",
      nodes: [
        { kind: "item", id: "action-about-typsastra", label: `About ${productName}`, elementId: "action-about-typsastra" },
        { kind: "separator" },
        { kind: "item", id: "action-open-settings", label: "Settings…", accelerator: "CmdOrCtrl+,", elementId: "action-open-settings" },
        { kind: "separator" },
        { kind: "predefined", item: "Services" },
        { kind: "separator" },
        { kind: "predefined", item: "Hide", text: `Hide ${productName}` },
        { kind: "predefined", item: "HideOthers", text: "Hide Others" },
        { kind: "predefined", item: "ShowAll", text: "Show All" },
        { kind: "separator" },
        { kind: "item", id: "action-exit", label: `Quit ${productName}`, accelerator: "CmdOrCtrl+Q", elementId: "action-exit" },
      ],
    },
    {
      label: "File",
      nodes: [
        { kind: "item", id: "action-new-file", label: "New File", accelerator: "CmdOrCtrl+N", elementId: "action-new-file", workspaceScoped: true },
        { kind: "item", id: "action-open-folder", label: "Open Project…", accelerator: "CmdOrCtrl+O", elementId: "action-open-folder" },
        { kind: "item", id: "action-import-project", label: "Import Typsastra Project…", elementId: "action-import-project" },
        { kind: "recent-placeholder" },
        { kind: "separator" },
        { kind: "item", id: "action-save-file", label: "Save", accelerator: "CmdOrCtrl+S", elementId: "action-save-file", workspaceScoped: true },
        { kind: "item", id: "action-save-file-as", label: "Save As…", accelerator: "Shift+CmdOrCtrl+S", elementId: "action-save-file-as", workspaceScoped: true },
        { kind: "separator" },
        { kind: "item", id: "action-export-pdf", label: "Export PDF", accelerator: "CmdOrCtrl+E", elementId: "action-export-pdf", workspaceScoped: true },
        { kind: "item", id: "action-export-project", label: "Export Typsastra Project…", elementId: "action-export-project", workspaceScoped: true },
        { kind: "item", id: "action-export-source-zip", label: "Export Source ZIP…", elementId: "action-export-source-zip", workspaceScoped: true },
        { kind: "separator" },
        { kind: "item", id: "action-restart-workspace", label: "Reload Project", elementId: "action-restart-workspace", workspaceScoped: true },
        { kind: "item", id: "action-close-project", label: "Close Project", elementId: "action-close-project", workspaceScoped: true },
      ],
    },
    {
      label: "Edit",
      nodes: [
        { kind: "predefined", item: "Undo", text: "Undo" },
        { kind: "predefined", item: "Redo", text: "Redo" },
        { kind: "separator" },
        { kind: "predefined", item: "Cut", text: "Cut" },
        { kind: "predefined", item: "Copy", text: "Copy" },
        { kind: "predefined", item: "Paste", text: "Paste" },
        { kind: "item", id: "action-select-all", label: "Select All", accelerator: "CmdOrCtrl+A", elementId: "action-select-all" },
        { kind: "separator" },
        { kind: "item", id: "action-navigation-back", label: "Back", accelerator: "Alt+Left", elementId: "action-navigation-back" },
        { kind: "item", id: "action-navigation-forward", label: "Forward", accelerator: "Alt+Right", elementId: "action-navigation-forward" },
        { kind: "separator" },
        { kind: "item", id: "action-search-project", label: "Search Project", accelerator: "CmdOrCtrl+Shift+F", elementId: "action-search-project", workspaceScoped: true },
        { kind: "item", id: "action-replace-project", label: "Replace in Project", accelerator: "CmdOrCtrl+Shift+H", elementId: "action-replace-project", workspaceScoped: true },
        { kind: "separator" },
        { kind: "item", id: "action-format-document", label: "Format Document", accelerator: "Alt+Shift+F", elementId: "action-format-document", workspaceScoped: true },
        { kind: "separator" },
        { kind: "item", id: "action-fold-file", label: "Fold Current File", elementId: "action-fold-file", workspaceScoped: true },
        { kind: "item", id: "action-unfold-file", label: "Unfold Current File", elementId: "action-unfold-file", workspaceScoped: true },
      ],
    },
    {
      label: "View",
      nodes: [
        { kind: "check", id: "action-toggle-word-wrap", label: "Word Wrap", accelerator: "Alt+Z", elementId: "action-toggle-word-wrap", check: "wordWrap" },
        { kind: "item", id: "action-toggle-sidebar", label: "Toggle Sidebar", accelerator: "CmdOrCtrl+B", elementId: "action-toggle-sidebar", workspaceScoped: true },
        { kind: "check", id: "action-toggle-editor-toolbar", label: "Editor Toolbar", accelerator: "Shift+CmdOrCtrl+T", elementId: "action-toggle-editor-toolbar", check: "editorToolbar", workspaceScoped: true },
        { kind: "separator" },
        { kind: "item", id: "action-restore-default-layout", label: "Restore Default Layout", elementId: "action-restore-default-layout", workspaceScoped: true },
      ],
    },
    {
      label: "Terminal",
      nodes: [
        { kind: "item", id: "action-toggle-logs", label: "Toggle Log Console", accelerator: "CmdOrCtrl+Backquote", elementId: "action-toggle-logs" },
        { kind: "item", id: "action-clear-logs", label: "Clear Logs", elementId: "action-clear-logs" },
        { kind: "separator" },
        { kind: "item", id: "action-restart-lsp", label: "Restart Tinymist LSP", elementId: "action-restart-lsp" },
      ],
    },
    {
      label: "Window",
      role: "window",
      nodes: [
        { kind: "predefined", item: "Minimize" },
        { kind: "predefined", item: "Maximize" },
        { kind: "separator" },
        { kind: "predefined", item: "CloseWindow" },
        { kind: "separator" },
        { kind: "predefined", item: "BringAllToFront" },
      ],
    },
    {
      label: "Help",
      role: "help",
      nodes: [
        { kind: "item", id: "action-docs-typsastra", label: "Typsastra Documentation", elementId: "action-docs-typsastra" },
        { kind: "item", id: "action-docs-typst", label: "Typst Reference", elementId: "action-docs-typst" },
      ],
    },
  ];
}

export function nativeMenuElementIds(spec: NativeMenuSubmenuSpec[]): string[] {
  return spec.flatMap(submenu => submenu.nodes)
    .filter((node): node is Extract<NativeMenuNode, { elementId: string }> => "elementId" in node)
    .map(node => node.elementId);
}

export function workspaceScopedMenuIds(spec: NativeMenuSubmenuSpec[]): string[] {
  return spec.flatMap(submenu => submenu.nodes)
    .filter((node): node is Extract<NativeMenuNode, { elementId: string }> =>
      "elementId" in node && node.workspaceScoped === true)
    .map(node => node.elementId);
}

let nativeMenuInstalled = false;

export function nativeAppMenuOwnsShortcuts(): boolean {
  return nativeMenuInstalled;
}

export function setNativeAppMenuInstalled(installed: boolean): void {
  nativeMenuInstalled = installed;
}
