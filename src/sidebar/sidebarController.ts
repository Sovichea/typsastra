export type SidebarTool = "explorer" | "images";

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
    document.body.classList.remove("image-tools-active");
  }

  public toggle(): void {
    if (!this.port.hasWorkspace()) return;
    // Image Tools owns the sidebar surface. Toggling the workspace sidebar
    // must not hide the image explorer while that tool is active.
    if (this.state.activeTool === "images") return;
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
    document.body.classList.toggle("image-tools-active", showingImages);
    document.getElementById("explorer-sidebar-content")?.classList.toggle("hidden", showingImages);
    document.getElementById("image-tools-sidebar-content")?.classList.toggle("hidden", !showingImages);
    const explorerButton = document.getElementById("sidebar-explorer-button") as HTMLButtonElement | null;
    const imagesButton = document.getElementById("sidebar-images-button") as HTMLButtonElement | null;
    explorerButton?.classList.toggle("active", !showingImages);
    imagesButton?.classList.toggle("active", showingImages);
    explorerButton?.setAttribute("aria-pressed", String(!showingImages));
    imagesButton?.setAttribute("aria-pressed", String(showingImages));

    this.codeRenderPane.classList.toggle("hidden", showingImages);
    document.getElementById("image-viewer-pane")?.classList.add("hidden");
    this.previewPane.classList.remove("hidden");
    this.port.setMainPreviewVisibleWhileUndocked(showingImages);
    if (showingImages) {
      if (toolChanged) this.port.invalidatePreview("switched to Image Tools");
      this.port.showImageTools();
    } else {
      this.port.hideImageTools();
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
    // Image Tools keeps the sidebar surface (and its image explorer) open even
    // when the workspace sidebar preference is hidden.
    const visible = (this.state.visible || showingImages) && !this.port.isWorkspaceLoading();

    explorerSidebar?.classList.toggle("hidden", !visible);
    if (explorerSidebar) explorerSidebar.style.display = "";
    explorerResizer?.classList.toggle("hidden", !visible);
    this.port.reconcileDockedPaneWidths();
    if (sidebarToggle) {
      sidebarToggle.disabled = showingImages;
      const expanded = showingImages || this.state.visible;
      const label = showingImages
        ? "Image Tools keeps the sidebar open"
        : this.state.visible
          ? "Hide sidebar"
          : "Show sidebar";
      sidebarToggle.setAttribute("aria-expanded", String(expanded));
      sidebarToggle.setAttribute("aria-label", label);
      sidebarToggle.title = label;
    }
  }
}
