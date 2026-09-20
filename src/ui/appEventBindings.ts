import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getVersion } from "@tauri-apps/api/app";
import { confirm, open, save } from "@tauri-apps/plugin-dialog";
import { open as openUrl } from "@tauri-apps/plugin-shell";
import type { PreviewClickPoint } from "../preview/previewFrame";
import type { PreviewScrollPositionPayload } from "../preview/previewWindowController";
import type { PreviewContentMode } from "../preview/draftPreviewController";
import type { PreviewColorMode } from "../settings";
import { recentProjectShortcutIndex } from "../workspace/recentProjectsController";
import { installWelcomeKeyboardNavigation } from "../workspace/welcomeNavigation";
import { installModalFocusTrap } from "./modalFocus";
import { isAltGraphKeyboardEvent } from "./keyboardModifiers";
import { updateMaximizeIcon } from "./icons";
import { nativeAppMenuOwnsShortcuts } from "../platform/nativeAppMenuSpec";

export type PreviewWindowUpdate = Record<string, unknown> & { path: string };

export interface AppEventActions {
  previewWindowUpdate: () => PreviewWindowUpdate | null;
  restoreUndockedPreviewScrollPosition: (position: PreviewScrollPositionPayload) => void;
  changePreviewContentMode: (mode: PreviewContentMode) => Promise<void> | void;
  changePreviewColorMode: (mode: PreviewColorMode) => void;
  previewContentMode: () => PreviewContentMode;
  openLastPreviewExternally: () => Promise<void> | void;
  handlePdfPreviewClick: (point: PreviewClickPoint) => Promise<void> | void;
  drainPendingProjectImports: () => Promise<void> | void;
  navigateToImageTool: (imagePath: string) => Promise<void> | void;
  navigateToTableTool: (tableId: string) => Promise<void> | void;
  beforeUnload: () => void;

  dismissSpellcheckTyping: () => void;
  revealCursorInPreview: () => void;
  formatActiveDocument: () => Promise<unknown> | void;
  saveActiveFileAs: () => Promise<void> | void;
  saveActiveFile: () => Promise<void> | void;
  openRecentProject: (index: number) => boolean;

  openWorkspace: (path: string) => Promise<void> | void;
  importProject: () => Promise<void> | void;
  restartWorkspace: () => Promise<void> | void;
  closeProject: () => Promise<boolean> | void;
  workspaceRootPath: () => string | null;
  onNewFileCreated: (path: string) => Promise<void> | void;

  zoomOut: () => void;
  zoomIn: () => void;
  zoomToFit: () => void;
  openStandalonePdfSearch: () => void;
  recompilePreview: () => Promise<void> | void;
  showImageHeavyDetails: () => Promise<void> | void;
  initializePreviewPageControls: () => void;
  updatePreviewZoomLabel: () => void;
  updateManualForwardSyncAction: () => void;

  exportPdf: () => Promise<void> | void;
  exportProject: () => Promise<void> | void;
  exportSourceZip: () => Promise<void> | void;
  undo: () => void;
  redo: () => void;
  selectAllActiveSurface: () => void;
  foldCurrentFile: () => void;
  unfoldCurrentFile: () => void;
  toggleSidebar: () => void;
  setSidebarTool: (tool: "explorer" | "images" | "tables") => void;
  restoreDefaultLayout: () => void;
  toggleEditorToolbar: () => void;
  toggleLogConsole: () => void;
  clearLogs: () => void;
  restartLsp: () => Promise<void> | void;
  openExamplesWorkspace: () => Promise<void> | void;

  startWindowStateMonitor: () => Promise<void> | void;
  hasUnsavedChanges: () => boolean;
  prepareForClose: () => Promise<boolean>;
  persistWorkspaceState: () => Promise<void>;
  persistWindowState: () => Promise<void>;

  wysiwymContainer: HTMLElement;
  isWysiwymMode: () => boolean;
  handleWysiwymInput: () => void;
  previewPane: HTMLElement;
  handlePreviewSourceLocation: (line: number, column: number) => void;
}

function bindKeyboardShortcuts(actions: AppEventActions): void {
  document.addEventListener("keydown", event => {
    if (isAltGraphKeyboardEvent(event)) return;

    const isMac = navigator.userAgent.toLowerCase().includes("mac");
    const cmdOrCtrl = isMac ? event.metaKey : event.ctrlKey;
    const keyCode = event.code;

    if (
      cmdOrCtrl
      && !event.altKey
      && !event.shiftKey
      && keyCode === "KeyA"
      && !(event.target as Element | null)?.closest("input,textarea,[contenteditable]")
    ) {
      event.preventDefault();
      window.getSelection()?.removeAllRanges();
    }

    if (event.key === "Escape" && document.activeElement?.closest(".cm-editor")) {
      actions.dismissSpellcheckTyping();
    }

    if (cmdOrCtrl && keyCode === "F12" && import.meta.env.DEV) {
      event.preventDefault();
      void invoke("open_devtools");
    }

    if (event.altKey && !cmdOrCtrl && !event.shiftKey && keyCode === "Enter") {
      event.preventDefault();
      actions.revealCursorInPreview();
      return;
    }

    if (["F5", "F6", "F7", "F11"].includes(keyCode)) event.preventDefault();
    if (cmdOrCtrl && ["KeyR", "KeyP", "KeyJ", "KeyU", "KeyD"].includes(keyCode)) event.preventDefault();

    if (keyCode === "F3" || (cmdOrCtrl && ["KeyF", "KeyG", "KeyH"].includes(keyCode))) {
      const active = document.activeElement;
      if (!active || (!active.classList.contains("cm-content") && active.tagName !== "INPUT" && active.tagName !== "TEXTAREA" && !active.closest(".cm-panel"))) {
        event.preventDefault();
      }
    }

    if (cmdOrCtrl && event.shiftKey && ["KeyI", "KeyC", "KeyF", "KeyJ", "KeyR"].includes(keyCode)) {
      event.preventDefault();
    }

    if (!nativeAppMenuOwnsShortcuts() && cmdOrCtrl && event.shiftKey && !event.altKey && keyCode === "KeyF") {
      event.preventDefault();
      void actions.formatActiveDocument();
      return;
    }
    if (!nativeAppMenuOwnsShortcuts() && cmdOrCtrl && event.shiftKey && !event.altKey && keyCode === "KeyS") {
      event.preventDefault();
      void actions.saveActiveFileAs();
      return;
    }
    if (!nativeAppMenuOwnsShortcuts() && cmdOrCtrl && event.shiftKey && !event.altKey && keyCode === "KeyT") {
      event.preventDefault();
      actions.toggleEditorToolbar();
      return;
    }

    const recentProjectIndex = recentProjectShortcutIndex(event);
    const welcomeScreen = document.getElementById("welcome-screen");
    if (
      recentProjectIndex !== null
      && welcomeScreen
      && !welcomeScreen.classList.contains("hidden")
      && actions.openRecentProject(recentProjectIndex)
    ) {
      event.preventDefault();
      return;
    }

    if (!nativeAppMenuOwnsShortcuts() && cmdOrCtrl && !event.shiftKey && !event.altKey) {
      const actionByKey: Partial<Record<string, string>> = {
        KeyO: "action-open-folder",
        KeyN: "action-new-file",
        KeyB: "action-toggle-sidebar",
        KeyE: "action-export-pdf",
        KeyQ: "action-exit",
        Backquote: "action-toggle-logs",
      };
      if (keyCode === "KeyS") {
        event.preventDefault();
        void actions.saveActiveFile();
      } else if (actionByKey[keyCode]) {
        event.preventDefault();
        document.getElementById(actionByKey[keyCode]!)?.click();
      }
    }

    if (!nativeAppMenuOwnsShortcuts() && event.altKey && !cmdOrCtrl && !event.shiftKey && keyCode === "KeyZ") {
      event.preventDefault();
      document.getElementById("action-toggle-word-wrap")?.click();
    }
  });
}

function bindAboutDialog(): void {
  const aboutOverlay = document.getElementById("about-overlay");
  const aboutClose = document.getElementById("about-close") as HTMLButtonElement | null;
  const aboutAction = document.getElementById("action-about-typsastra") as HTMLElement | null;
  let focusBeforeAbout: HTMLElement | null = null;
  const closeAbout = () => {
    if (aboutOverlay?.classList.contains("hidden")) return;
    aboutOverlay?.classList.add("hidden");
    const restoreTarget = aboutAction && aboutAction.getClientRects().length > 0
      ? aboutAction
      : focusBeforeAbout;
    restoreTarget?.focus();
  };
  aboutAction?.addEventListener("click", async () => {
    focusBeforeAbout = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const version = document.getElementById("about-version");
    if (version) version.textContent = await getVersion().catch(() => "Unavailable");
    aboutOverlay?.classList.remove("hidden");
    aboutClose?.focus();
  });
  aboutClose?.addEventListener("click", closeAbout);
  document.getElementById("about-done")?.addEventListener("click", closeAbout);
  document.getElementById("about-project-page")?.addEventListener("click", () => {
    void openUrl("https://github.com/Sovichea/typsastra");
  });
  aboutOverlay?.addEventListener("click", event => {
    if (event.target === aboutOverlay) closeAbout();
  });
  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && !aboutOverlay?.classList.contains("hidden")) closeAbout();
  });
}

function bindMenuDropdowns(): void {
  const dropdownContainers = document.querySelectorAll("#app-menus .dropdown-container");
  dropdownContainers.forEach(container => {
    container.addEventListener("click", event => {
      const target = event.target as HTMLElement;
      if (target.closest(".dropdown-item")) {
        dropdownContainers.forEach(candidate => candidate.classList.remove("active"));
        return;
      }
      const isActive = container.classList.contains("active");
      dropdownContainers.forEach(candidate => candidate.classList.remove("active"));
      if (!isActive) container.classList.add("active");
      event.stopPropagation();
    });
    container.addEventListener("mouseenter", () => {
      const isAnyActive = Array.from(dropdownContainers).some(candidate => candidate.classList.contains("active"));
      if (isAnyActive && !container.classList.contains("active")) {
        dropdownContainers.forEach(candidate => candidate.classList.remove("active"));
        container.classList.add("active");
      }
    });
  });
  document.addEventListener("click", () => {
    dropdownContainers.forEach(candidate => candidate.classList.remove("active"));
  });
}

function bindWindowControls(actions: AppEventActions): void {
  const appWindow = getCurrentWindow();
  document.getElementById("titlebar-minimize")?.addEventListener("click", () => void appWindow.minimize());
  document.getElementById("titlebar-maximize")?.addEventListener("click", () => void appWindow.toggleMaximize());
  void appWindow.onResized(async () => updateMaximizeIcon(await appWindow.isMaximized()));
  void Promise.resolve(actions.startWindowStateMonitor()).catch(error => {
    console.warn("Failed to monitor the main window state:", error);
  });
  void appWindow.isMaximized().then(updateMaximizeIcon);
  document.getElementById("titlebar-close")?.addEventListener("click", () => void appWindow.close());

  let closeRequestInProgress = false;
  void appWindow.onCloseRequested(async event => {
    event.preventDefault();
    if (closeRequestInProgress) return;
    closeRequestInProgress = true;
    let proceed = true;
    if (actions.hasUnsavedChanges()) {
      proceed = await confirm("You have unsaved changes. Are you sure you want to close Typsastra?", {
        title: "Unsaved Changes",
        kind: "warning",
        okLabel: "Close Without Saving",
        cancelLabel: "Cancel"
      });
    }
    if (proceed) proceed = await actions.prepareForClose();
    if (proceed) {
      await actions.persistWorkspaceState();
      await actions.persistWindowState();
      try {
        const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
        const previewWin = await WebviewWindow.getByLabel("preview");
        if (previewWin) await previewWin.close();
      } catch (error) {
        console.error("Failed to close preview window on exit:", error);
      }
      void appWindow.destroy();
      return;
    }
    closeRequestInProgress = false;
  });
}

export function bindAppEvents(actions: AppEventActions): void {
  installModalFocusTrap();

  window.addEventListener("typsastra-open-image-tool", event => {
    const imagePath = (event as CustomEvent<{ imagePath?: string }>).detail?.imagePath;
    if (imagePath) void actions.navigateToImageTool(imagePath);
  });

  window.addEventListener("typsastra-open-table-tool", event => {
    const tableId = (event as CustomEvent<{ tableId?: string }>).detail?.tableId;
    if (tableId) void actions.navigateToTableTool(tableId);
  });

  import("@tauri-apps/api/event").then(({ listen: listenEvent, emit: emitEvent }) => {
    void listenEvent("preview-window-ready", () => {
      const update = actions.previewWindowUpdate();
      if (update) void emitEvent("pdf-update", update);
    });
    void listenEvent<PreviewScrollPositionPayload>("preview-scroll-position-changed", event => {
      actions.restoreUndockedPreviewScrollPosition(event.payload);
    });
    void listenEvent<PreviewContentMode>("preview-content-mode-request", event => {
      void actions.changePreviewContentMode(event.payload);
    });
    void listenEvent<PreviewColorMode>("preview-color-mode-request", event => {
      actions.changePreviewColorMode(event.payload);
    });
    void listenEvent<"export-pdf" | "open-external">("preview-window-action", event => {
      if (event.payload === "export-pdf") document.getElementById("action-export-pdf")?.click();
      else void actions.openLastPreviewExternally();
    });
    void listenEvent<PreviewClickPoint>("pdf-click", event => {
      void actions.handlePdfPreviewClick(event.payload);
    });
  }).catch(error => console.error("Error setting up Tauri preview event listeners", error));

  void listen("typsastra-project-open-requested", () => void actions.drainPendingProjectImports());
  window.addEventListener("beforeunload", actions.beforeUnload);
  bindKeyboardShortcuts(actions);

  void listen("menu-toggle-log-console", () => actions.toggleLogConsole());
  void listen("menu-open-folder", async () => {
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected === "string") await actions.openWorkspace(selected);
  });

  document.getElementById("preview-zoom-out-btn")?.addEventListener("click", actions.zoomOut);
  document.getElementById("preview-zoom-in-btn")?.addEventListener("click", actions.zoomIn);
  document.getElementById("preview-zoom-fit-btn")?.addEventListener("click", actions.zoomToFit);
  document.getElementById("preview-search-btn")?.addEventListener("click", actions.openStandalonePdfSearch);
  document.getElementById("preview-recompile-btn")?.addEventListener("click", () => void actions.recompilePreview());
  document.getElementById("preview-image-warning-btn")?.addEventListener("click", () => void actions.showImageHeavyDetails());
  document.getElementById("preview-content-mode-toggle")?.addEventListener("click", () => {
    void actions.changePreviewContentMode(actions.previewContentMode() === "draft" ? "normal" : "draft");
  });

  actions.initializePreviewPageControls();
  actions.updatePreviewZoomLabel();
  actions.updateManualForwardSyncAction();

  document.getElementById("action-open-folder")?.addEventListener("click", async () => {
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected === "string") await actions.openWorkspace(selected);
  });
  document.getElementById("action-import-project")?.addEventListener("click", () => void actions.importProject());
  document.getElementById("action-restart-workspace")?.addEventListener("click", () => void actions.restartWorkspace());
  document.getElementById("action-close-project")?.addEventListener("click", () => void actions.closeProject());
  document.getElementById("action-new-file")?.addEventListener("click", async () => {
    const workspaceRootPath = actions.workspaceRootPath();
    if (!workspaceRootPath) {
      alert("Please open a project first.");
      return;
    }
    const savePath = await save({
      defaultPath: workspaceRootPath,
      filters: [{ name: "Typst Document", extensions: ["typ"] }]
    });
    if (typeof savePath === "string") {
      await invoke("save_workspace_file", { path: savePath, contents: "= New Document\n" });
      await actions.onNewFileCreated(savePath);
    }
  });

  document.getElementById("action-save-file")?.addEventListener("click", () => void actions.saveActiveFile());
  document.getElementById("action-save-file-as")?.addEventListener("click", () => void actions.saveActiveFileAs());
  document.getElementById("action-export-pdf")?.addEventListener("click", () => void actions.exportPdf());
  document.getElementById("action-export-project")?.addEventListener("click", () => void actions.exportProject());
  document.getElementById("action-export-source-zip")?.addEventListener("click", () => void actions.exportSourceZip());
  document.getElementById("action-exit")?.addEventListener("click", () => void getCurrentWindow().close());
  document.getElementById("action-undo")?.addEventListener("click", actions.undo);
  document.getElementById("action-redo")?.addEventListener("click", actions.redo);
  document.getElementById("action-select-all")?.addEventListener("click", actions.selectAllActiveSurface);
  document.getElementById("action-format-document")?.addEventListener("click", () => void actions.formatActiveDocument());
  document.getElementById("action-fold-file")?.addEventListener("click", actions.foldCurrentFile);
  document.getElementById("action-unfold-file")?.addEventListener("click", actions.unfoldCurrentFile);
  document.getElementById("action-toggle-word-wrap")?.addEventListener("click", () => document.getElementById("word-wrap-toggle")?.click());
  document.getElementById("action-toggle-sidebar")?.addEventListener("click", actions.toggleSidebar);
  document.getElementById("sidebar-toggle-button")?.addEventListener("click", actions.toggleSidebar);
  document.getElementById("sidebar-explorer-button")?.addEventListener("click", () => actions.setSidebarTool("explorer"));
  document.getElementById("sidebar-images-button")?.addEventListener("click", () => actions.setSidebarTool("images"));
  document.getElementById("sidebar-tables-button")?.addEventListener("click", () => actions.setSidebarTool("tables"));
  document.getElementById("action-restore-default-layout")?.addEventListener("click", actions.restoreDefaultLayout);
  document.getElementById("action-toggle-editor-toolbar")?.addEventListener("click", actions.toggleEditorToolbar);
  document.getElementById("action-clear-logs")?.addEventListener("click", actions.clearLogs);
  document.getElementById("action-restart-lsp")?.addEventListener("click", () => void actions.restartLsp());
  document.getElementById("action-docs-typsastra")?.addEventListener("click", () => void openUrl("https://github.com/sovichea/typsastra"));
  document.getElementById("action-docs-typst")?.addEventListener("click", () => void openUrl("https://typst.app/docs"));
  bindAboutDialog();
  document.getElementById("action-toggle-logs")?.addEventListener("click", actions.toggleLogConsole);

  const welcomeScreen = document.getElementById("welcome-screen");
  if (welcomeScreen) installWelcomeKeyboardNavigation(welcomeScreen);
  document.getElementById("welcome-open-project")?.addEventListener("click", () => document.getElementById("action-open-folder")?.click());
  document.getElementById("welcome-import-project")?.addEventListener("click", () => document.getElementById("action-import-project")?.click());
  document.getElementById("welcome-open-examples")?.addEventListener("click", () => void actions.openExamplesWorkspace());

  bindMenuDropdowns();
  bindWindowControls(actions);

  actions.wysiwymContainer.addEventListener("input", () => {
    if (actions.isWysiwymMode()) actions.handleWysiwymInput();
  });
  actions.wysiwymContainer.addEventListener("click", async event => {
    const mouseEvent = event as MouseEvent;
    if (!mouseEvent.ctrlKey) return;
    const linkSpan = (mouseEvent.target as HTMLElement).closest(".wysiwym-link");
    const url = linkSpan?.getAttribute("data-url");
    if (!url || (!url.startsWith("http://") && !url.startsWith("https://"))) return;
    const trust = window.confirm(`Do you want to open this external link in your browser?\n\n${url}`);
    if (!trust) return;
    try {
      await openUrl(url);
    } catch (error) {
      console.error("Failed to open URL", error);
    }
  });

  actions.previewPane.addEventListener("click", event => {
    const sourceElement = (event.target as Element).closest("[data-source], [data-typst-source]");
    const source = sourceElement?.getAttribute("data-source") || sourceElement?.getAttribute("data-typst-source");
    if (!source) return;
    const parts = source.split(":");
    if (parts.length < 3) return;
    try {
      const line = parseInt(parts[parts.length - 2], 10);
      const column = parseInt(parts[parts.length - 1], 10);
      actions.handlePreviewSourceLocation(line, column);
    } catch (error) {
      console.warn("Failed to inverse sync:", error);
    }
  });
}
