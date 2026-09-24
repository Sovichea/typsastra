export function clampEditorPreviewSplitPct(
  requestedInputPct: number,
  viewportWidthPx: number,
  packedPreviewWidthPx: number
): number {
  if (!Number.isFinite(viewportWidthPx) || viewportWidthPx <= 0) {
    return Math.max(10, Math.min(requestedInputPct, 90));
  }
  const maximumInputPct = Math.max(
    10,
    Math.min(90, 100 - (Math.max(0, packedPreviewWidthPx) / viewportWidthPx) * 100)
  );
  return Math.max(10, Math.min(requestedInputPct, maximumInputPct));
}

export class LayoutController {
  private static readonly dragThresholdPx = 4;
  private readonly interruptResizeCallbacks = new Set<() => void>();
  private dockedInputWidthPct = 50;
  private previewUndocked = false;

  constructor(
    private readonly onLayoutChanged: () => void,
    private readonly onHideLogConsole: () => void,
    private readonly onDebug: (message: string) => void = () => {},
    private readonly onEditorWidthResizeStart: () => void = () => {},
    private readonly onEditorWidthResizeEnd: () => void = () => {},
    private readonly onPreviewUndocking: () => void = () => {},
    private readonly onPreviewDocked: () => void = () => {}
  ) {}

  public initialize(): void {
    this.initializeResizers();
    this.initializePreviewUndocking();
  }

  public recoverInterruptedResize(): boolean {
    const wasResizing = document.body.classList.contains("typsastra-resizing");
    for (const interrupt of this.interruptResizeCallbacks) interrupt();
    document.querySelectorAll<HTMLElement>(".resizer.resizing, .horizontal-resizer.resizing")
      .forEach(resizer => resizer.classList.remove("resizing"));
    document.body.classList.remove("typsastra-resizing");
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    return wasResizing;
  }

  public setDockedInputWidthPct(value: number): void {
    if (!Number.isFinite(value)) return;
    this.dockedInputWidthPct = Math.max(10, Math.min(value, 90));
  }

  public getDockedInputWidthPct(): number {
    return this.dockedInputWidthPct;
  }

  public setMainPreviewVisibleWhileUndocked(visible: boolean): void {
    if (!this.previewUndocked) return;
    const previewWrapper = document.getElementById("preview-container-wrapper");
    const resizer = document.getElementById("editor-preview-resizer");
    const input = document.getElementById("input-container-wrapper");

    if (visible) {
      previewWrapper?.classList.remove("hidden");
      if (previewWrapper) {
        previewWrapper.style.display = "flex";
        previewWrapper.style.width = `${100 - this.dockedInputWidthPct}%`;
      }
      if (resizer) {
        resizer.classList.remove("hidden");
        resizer.style.display = "block";
      }
      if (input) input.style.width = `${this.dockedInputWidthPct}%`;
    } else {
      if (previewWrapper) previewWrapper.style.display = "none";
      if (resizer) resizer.style.display = "none";
      if (input) input.style.width = "100%";
    }
  }

  public reconcileDockedPaneWidths(): void {
    const input = document.getElementById("input-container-wrapper");
    const preview = document.getElementById("preview-container-wrapper");
    const viewport = document.getElementById("workspace-viewport");
    if (
      !input
      || !preview
      || !viewport
      || input.classList.contains("hidden")
      || preview.classList.contains("hidden")
      || getComputedStyle(preview).display === "none"
    ) {
      return;
    }
    const inputWidthPct = clampEditorPreviewSplitPct(
      this.dockedInputWidthPct,
      viewport.getBoundingClientRect().width,
      this.minimumPreviewToolbarWidth()
    );
    this.setDockedInputWidthPct(inputWidthPct);
    input.style.width = `${inputWidthPct}%`;
    preview.style.width = `${100 - inputWidthPct}%`;
  }

  private captureDockedPaneSize(): void {
    const input = document.getElementById("input-container-wrapper");
    const viewport = document.getElementById("workspace-viewport");
    if (!input || !viewport) return;
    const inlineWidth = input.style.width.trim();
    if (inlineWidth.endsWith("%")) {
      const percentage = Number.parseFloat(inlineWidth);
      if (Number.isFinite(percentage) && percentage < 100) {
        this.setDockedInputWidthPct(percentage);
        return;
      }
    }
    const viewportWidth = viewport.getBoundingClientRect().width;
    const inputWidth = input.getBoundingClientRect().width;
    if (viewportWidth > 0 && inputWidth > 0 && inputWidth < viewportWidth) {
      this.setDockedInputWidthPct((inputWidth / viewportWidth) * 100);
    }
  }

  private minimumPreviewToolbarWidth(): number {
    const toolbar = document.querySelector<HTMLElement>(".preview-actions");
    if (!toolbar) return 0;
    const visibleControls = [...toolbar.children].filter(child => {
      const element = child as HTMLElement;
      return !element.hasAttribute("data-preview-collapsible")
        && !element.classList.contains("hidden")
        && getComputedStyle(element).display !== "none";
    }) as HTMLElement[];
    if (visibleControls.length === 0) return 0;
    const toolbarStyle = getComputedStyle(toolbar);
    const gap = Number.parseFloat(toolbarStyle.columnGap || toolbarStyle.gap) || 0;
    const padding =
      (Number.parseFloat(toolbarStyle.paddingLeft) || 0)
      + (Number.parseFloat(toolbarStyle.paddingRight) || 0);
    return Math.ceil(
      visibleControls.reduce((width, control) => width + control.getBoundingClientRect().width, 0)
      + gap * Math.max(0, visibleControls.length - 1)
      + padding
    );
  }

  public isPreviewUndocked(): boolean {
    return this.previewUndocked;
  }

  /**
   * Ensures the docked preview layout is visible when the editor is shown.
   * Unlike {@link dockPreview}, this never closes an intentionally undocked
   * window (for example when activating a tab during inverse sync).
   */
  public ensureDockedPreviewVisible(): void {
    if (this.previewUndocked) return;
    this.applyDockedPreviewLayout();
  }

  public dockPreview(): void {
    this.previewUndocked = false;
    import("@tauri-apps/api/webviewWindow").then(async ({ WebviewWindow }) => {
      const win = await WebviewWindow.getByLabel("preview");
      if (win) {
        await win.close();
      }
    }).catch(err => console.error("Error closing preview window", err));
    this.applyDockedPreviewLayout();
  }

  private applyDockedPreviewLayout(): void {
    const previewWrapper = document.getElementById("preview-container-wrapper");
    const resizer = document.getElementById("editor-preview-resizer");
    const input = document.getElementById("input-container-wrapper");

    const before = previewWrapper
      ? `before class="${previewWrapper.className}", inline="${previewWrapper.style.display}", computed="${getComputedStyle(previewWrapper).display}"`
      : "before missing preview wrapper";
    if (previewWrapper) {
      previewWrapper.classList.remove("hidden");
      previewWrapper.style.display = "flex";
    }
    if (resizer) {
      resizer.classList.remove("hidden");
      resizer.style.display = "block";
    }
    input?.classList.remove("hidden");
    if (input) input.style.width = `${this.dockedInputWidthPct}%`;
    if (previewWrapper) previewWrapper.style.width = `${100 - this.dockedInputWidthPct}%`;
    const after = previewWrapper
      ? `after class="${previewWrapper.className}", inline="${previewWrapper.style.display}", computed="${getComputedStyle(previewWrapper).display}", rect=${Math.round(previewWrapper.getBoundingClientRect().width)}x${Math.round(previewWrapper.getBoundingClientRect().height)}`
      : "after missing preview wrapper";
    this.onDebug(`Dock preview requested: ${before}; ${after}.`);
    requestAnimationFrame(() => this.onPreviewDocked());
  }

  private initializeResizers(): void {
    const explorerResizer = document.getElementById("explorer-resizer");
    const explorerSidebar = document.getElementById("explorer-sidebar");
    if (explorerResizer && explorerSidebar) {
      this.installDragResize(explorerResizer, "col-resize", event => {
        explorerSidebar.style.width = `${Math.max(150, Math.min(event.clientX, 800))}px`;
      }, () => {
        this.reconcileDockedPaneWidths();
        this.onEditorWidthResizeEnd();
        this.onLayoutChanged();
      }, this.onEditorWidthResizeStart);
    }

    const editorResizer = document.getElementById("editor-preview-resizer");
    const input = document.getElementById("input-container-wrapper");
    const preview = document.getElementById("preview-container-wrapper");
    const viewport = document.getElementById("workspace-viewport");
    if (editorResizer && input && preview && viewport) {
      let viewportRect: DOMRect | null = null;
      let packedPreviewWidth = 0;
      this.installDragResize(editorResizer, "col-resize", event => {
        const rect = viewportRect ?? viewport.getBoundingClientRect();
        const requestedPercentage = ((event.clientX - rect.left) / rect.width) * 100;
        const percentage = clampEditorPreviewSplitPct(
          requestedPercentage,
          rect.width,
          packedPreviewWidth
        );
        input.style.width = `${percentage}%`;
        preview.style.width = `${100 - percentage}%`;
      }, () => {
        viewportRect = null;
        packedPreviewWidth = 0;
        this.captureDockedPaneSize();
        this.onEditorWidthResizeEnd();
        this.onLayoutChanged();
      }, () => {
        viewportRect = viewport.getBoundingClientRect();
        packedPreviewWidth = this.minimumPreviewToolbarWidth();
        this.onEditorWidthResizeStart();
      });
    }

    const logResizer = document.getElementById("log-console-resizer");
    const logConsole = document.getElementById("log-console");
    if (logResizer && logConsole) {
      this.installDragResize(logResizer, "row-resize", event => {
        const statusBarHeight = document.getElementById("status-bar")?.offsetHeight || 26;
        const height = window.innerHeight - event.clientY - statusBarHeight;
        logConsole.style.height = `${Math.max(100, Math.min(height, window.innerHeight * 0.8))}px`;
      });
      logResizer.addEventListener("dblclick", this.onHideLogConsole);
    }
  }

  private initializePreviewUndocking(): void {
    const undock = document.getElementById("undock-preview-btn");
    const previewWrapper = document.getElementById("preview-container-wrapper");
    const preview = document.getElementById("preview-render-pane");
    const resizer = document.getElementById("editor-preview-resizer");
    const input = document.getElementById("input-container-wrapper");
    const restoreDock = () => this.dockPreview();
    if (!undock || !preview || !previewWrapper) return;

    undock.addEventListener("click", async () => {
      this.captureDockedPaneSize();
      this.onPreviewUndocking();
      this.previewUndocked = true;
      previewWrapper.style.display = "none";
      if (resizer) resizer.style.display = "none";
      if (input) input.style.width = "100%";
      try {
        const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
        const win = new WebviewWindow("preview", {
          url: "index.html?mode=preview",
          title: "Typsastra - Live Preview",
          width: 800,
          height: 600
        });
        win.once("tauri://close-requested", async () => {
          try {
            const { WebviewWindow: WebviewWindowType } = await import("@tauri-apps/api/webviewWindow");
            const mainWin = await WebviewWindowType.getByLabel("main");
            if (mainWin) {
              restoreDock();
            } else {
              await win.close();
            }
          } catch (e) {
            console.error("Error checking main window during close:", e);
            try { await win.close(); } catch {}
          }
        });
      } catch (error) {
        console.error("Failed to create WebviewWindow", error);
        alert("Could not open external preview window.");
        restoreDock();
      }
    });
  }

  private beginResize(resizer: HTMLElement, cursor: string): void {
    resizer.classList.add("resizing");
    document.body.classList.add("typsastra-resizing");
    document.body.style.cursor = cursor;
    document.body.style.userSelect = "none";
  }

  private endResize(resizer: HTMLElement): void {
    resizer.classList.remove("resizing");
    document.body.classList.remove("typsastra-resizing");
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  }

  private installDragResize(
    resizer: HTMLElement,
    cursor: string,
    onDrag: (event: { clientX: number; clientY: number }) => void,
    onEnd: () => void = () => {},
    onStart: () => void = () => {}
  ): void {
    let pending: { pointerId: number; x: number; y: number } | null = null;
    let dragging = false;
    let dragFrame: number | null = null;
    let latestPosition: { clientX: number; clientY: number } | null = null;

    const flushDrag = (): void => {
      dragFrame = null;
      const position = latestPosition;
      latestPosition = null;
      if (dragging && position) onDrag(position);
    };

    const interrupt = (): void => {
      if (!pending && !dragging) return;
      const pointerId = pending?.pointerId;
      const wasDragging = dragging;
      pending = null;
      dragging = false;
      latestPosition = null;
      if (dragFrame !== null) cancelAnimationFrame(dragFrame);
      dragFrame = null;
      if (pointerId !== undefined && resizer.hasPointerCapture(pointerId)) {
        resizer.releasePointerCapture(pointerId);
      }
      if (wasDragging) {
        this.endResize(resizer);
        onEnd();
      }
    };
    this.interruptResizeCallbacks.add(interrupt);

    resizer.addEventListener("pointerdown", event => {
      if (event.button !== 0) return;
      pending = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
      dragging = false;
      resizer.setPointerCapture(event.pointerId);
      event.preventDefault();
    });

    resizer.addEventListener("pointermove", event => {
      if (!pending || event.pointerId !== pending.pointerId) return;
      if (!dragging) {
        const distance = Math.hypot(event.clientX - pending.x, event.clientY - pending.y);
        if (distance < LayoutController.dragThresholdPx) return;
        dragging = true;
        // Capture editor/preview state while the panes are still measurable.
        // The resizing class hides their children behind placeholders.
        onStart();
        this.beginResize(resizer, cursor);
      }
      latestPosition = { clientX: event.clientX, clientY: event.clientY };
      if (dragFrame === null) dragFrame = requestAnimationFrame(flushDrag);
    });

    const finish = (event: PointerEvent): void => {
      if (!pending || event.pointerId !== pending.pointerId) return;
      const pointerId = pending.pointerId;
      pending = null;
      if (resizer.hasPointerCapture(pointerId)) resizer.releasePointerCapture(pointerId);
      if (dragging) {
        if (dragFrame !== null) {
          cancelAnimationFrame(dragFrame);
          flushDrag();
        }
        dragging = false;
        this.endResize(resizer);
        onEnd();
      }
    };

    resizer.addEventListener("pointerup", finish);
    resizer.addEventListener("pointercancel", finish);
    resizer.addEventListener("lostpointercapture", finish);
  }
}
