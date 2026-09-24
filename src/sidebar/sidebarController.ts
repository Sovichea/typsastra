export type SidebarTool = "explorer" | "images" | "tables";

export interface SidebarControllerState {
  visible: boolean;
  activeTool: SidebarTool;
}

export interface SidebarControllerPort {
  hasWorkspace(): boolean;
  isWorkspaceLoading(): boolean;
  isActiveSurfaceNonText(): boolean;
  invalidatePreview(reason: string): void;
  showImageTools(): void;
  hideImageTools(): void;
  showTableTools(): void;
  hideTableTools(): void;
  showRestoringPreview(): void;
  restoreDocumentPreview(): void;
  setMainPreviewVisibleWhileUndocked(visible: boolean): void;
  reconcileDockedPaneWidths(): void;
  persist(): void;
}

export class SidebarController {
  private state: SidebarControllerState = {
    visible: true,
    activeTool: "explorer",
  };

  constructor(
    private readonly port: SidebarControllerPort,
    private readonly codeRenderPane: HTMLElement,
    private readonly previewPane: HTMLElement,
  ) {}

  public get visible(): boolean {
    return this.state.visible;
  }

  public get activeTool(): SidebarTool {
    return this.state.activeTool;
  }

  public restore(state: SidebarControllerState): void {
    this.state = { ...state };
    this.setTool(state.activeTool, false);
    this.applyVisibility();
  }

  public reset(): void {
    this.state = { visible: true, activeTool: "explorer" };
    document.body.classList.remove("image-tools-active", "table-tools-active");
  }

  public toggle(): void {
    if (!this.port.hasWorkspace()) return;
    // Image Tools and Table Tools own the sidebar surface. Toggling the
    // workspace sidebar must not hide their explorer while that tool is active.
    if (this.state.activeTool === "images" || this.state.activeTool === "tables") return;
    this.state.visible = !this.state.visible;
    this.applyVisibility();
    this.port.persist();
  }

  public setVisible(visible: boolean, persist = false): void {
    this.state.visible = visible;
    this.applyVisibility();
    if (persist) this.port.persist();
  }

  public setTool(tool: SidebarTool, persist = true): void {
    if (!this.port.hasWorkspace()) return;
    const toolChanged = this.state.activeTool !== tool;
    this.state.activeTool = tool;

    const showingImages = tool === "images";
    const showingTables = tool === "tables";
    const showingExplorer = !showingImages && !showingTables;
    document.body.classList.toggle("image-tools-active", showingImages);
    document.body.classList.toggle("table-tools-active", showingTables);
    document.getElementById("explorer-sidebar-content")?.classList.toggle("hidden", !showingExplorer);
    document.getElementById("image-tools-sidebar-content")?.classList.toggle("hidden", !showingImages);
    document.getElementById("tables-sidebar-content")?.classList.toggle("hidden", !showingTables);
    const explorerButton = document.getElementById("sidebar-explorer-button") as HTMLButtonElement | null;
    const imagesButton = document.getElementById("sidebar-images-button") as HTMLButtonElement | null;
    const tablesButton = document.getElementById("sidebar-tables-button") as HTMLButtonElement | null;
    explorerButton?.classList.toggle("active", showingExplorer);
    imagesButton?.classList.toggle("active", showingImages);
    tablesButton?.classList.toggle("active", showingTables);
    explorerButton?.setAttribute("aria-pressed", String(showingExplorer));
    imagesButton?.setAttribute("aria-pressed", String(showingImages));
    tablesButton?.setAttribute("aria-pressed", String(showingTables));

    this.codeRenderPane.classList.toggle("hidden", !showingExplorer);
    document.getElementById("image-viewer-pane")?.classList.add("hidden");
    document.getElementById("table-tool-inspector")?.classList.toggle("hidden", !showingTables);
    this.previewPane.classList.remove("hidden");
    this.port.setMainPreviewVisibleWhileUndocked(showingImages);
    if (showingImages) {
      this.port.hideTableTools();
      if (toolChanged) this.port.invalidatePreview("switched to Image Tools");
      this.port.showImageTools();
    } else if (showingTables) {
      this.port.hideImageTools();
      if (toolChanged) this.port.invalidatePreview("switched to Table Tools");
      this.port.showTableTools();
    } else {
      this.port.hideImageTools();
      this.port.hideTableTools();
      this.codeRenderPane.classList.toggle("hidden", this.port.isActiveSurfaceNonText());
      document.getElementById("image-viewer-pane")?.classList.toggle(
        "hidden",
        !this.port.isActiveSurfaceNonText(),
      );
      if (toolChanged) this.port.showRestoringPreview();
      this.port.restoreDocumentPreview();
    }
    this.applyVisibility();
    if (persist) this.port.persist();
  }

  public applyVisibility(): void {
    const explorerSidebar = document.getElementById("explorer-sidebar");
    const explorerResizer = document.getElementById("explorer-resizer");
    const sidebarToggle = document.getElementById("sidebar-toggle-button") as HTMLButtonElement | null;
    const showingImages = this.state.activeTool === "images";
    const showingTables = this.state.activeTool === "tables";
    const toolKeepsSidebarOpen = showingImages || showingTables;
    // Image Tools and Table Tools keep the sidebar surface (and their explorer)
    // open even when the workspace sidebar preference is hidden.
    const visible = (this.state.visible || toolKeepsSidebarOpen) && !this.port.isWorkspaceLoading();

    explorerSidebar?.classList.toggle("hidden", !visible);
    if (explorerSidebar) explorerSidebar.style.display = "";
    explorerResizer?.classList.toggle("hidden", !visible);
    this.port.reconcileDockedPaneWidths();
    if (sidebarToggle) {
      sidebarToggle.disabled = toolKeepsSidebarOpen;
      const expanded = toolKeepsSidebarOpen || this.state.visible;
      const label = showingImages
        ? "Image Tools keeps the sidebar open"
        : showingTables
          ? "Table Tools keeps the sidebar open"
          : this.state.visible
            ? "Hide sidebar"
            : "Show sidebar";
      sidebarToggle.setAttribute("aria-expanded", String(expanded));
      sidebarToggle.setAttribute("aria-label", label);
      sidebarToggle.title = label;
    }
  }
}
