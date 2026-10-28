import { renderPreviewFreshnessBanner, type PreviewFreshness } from "./previewFreshnessController";
import { setCtrlWheelZoomStepPercent } from "./previewZoomGestures";
import { invoke } from "@tauri-apps/api/core";
import { initializePreviewGenerationSession, releasePreviewGeneration } from "./previewGenerationLease";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { applyUIThemeVariables } from "../editor/extensions";
import type { PreviewColorMode, ThemeName } from "../settings";
import type { PdfUpdatePayload } from "./pdfPreviewRenderController";
import type { DraftPreviewController } from "./draftPreviewController";
import type { PdfiumOutlineItem } from "./pdfiumDocument";
import { PreviewOutlineNavigator, type PreviewSourceOutlineItem } from "./previewOutlineNavigator";
import type { PreviewFrame } from "./previewFrame";
import type { PreviewViewportAnchor } from "./previewViewportAnchor";
import type { StoredUndockedPreviewWindow } from "../workspace/workspaceStateStore";

const DEFAULT_UNDOCKED_PREVIEW_WIDTH = 800;
const DEFAULT_UNDOCKED_PREVIEW_HEIGHT = 600;
const MIN_UNDOCKED_PREVIEW_WIDTH = 320;
const MIN_UNDOCKED_PREVIEW_HEIGHT = 240;
const MAX_UNDOCKED_PREVIEW_SIZE = 8192;

export function undockedPreviewWindowStateFromQuery(
  search: string,
): StoredUndockedPreviewWindow {
  const params = new URLSearchParams(search);
  const dimension = (value: string | null, fallback: number, minimum: number): number => {
    if (value === null) return fallback;
    const parsed = Number(value);
    return Number.isFinite(parsed)
      ? Math.max(minimum, Math.min(MAX_UNDOCKED_PREVIEW_SIZE, Math.round(parsed)))
      : fallback;
  };
  return {
    width: dimension(params.get("previewWidth"), DEFAULT_UNDOCKED_PREVIEW_WIDTH, MIN_UNDOCKED_PREVIEW_WIDTH),
    height: dimension(params.get("previewHeight"), DEFAULT_UNDOCKED_PREVIEW_HEIGHT, MIN_UNDOCKED_PREVIEW_HEIGHT),
    maximized: params.get("previewMaximized") === "1",
  };
}

export type UndockedPreviewAction = "export-pdf" | "open-external" | "recompile";

export interface PreviewScrollPositionPayload {
  sessionKey: string;
  scrollTop: number;
  viewportAnchor: PreviewViewportAnchor | null;
}

export interface PreviewWindowDependencies {
  loadSettings(): Promise<void>;
  theme(): ThemeName;
  previewColorMode(): PreviewColorMode;
  setPreviewColorMode(mode: PreviewColorMode): void;
  previewFrame: PreviewFrame;
  draftPreview: DraftPreviewController;
  zoomIn(): void;
  zoomOut(): void;
  zoomToFit(): void;
  initializePreviewPageControls(): void;
  sourceMapRootPath(): string | null;
  previewRootPath(): string | null;
  setWorkspaceRootPath(path: string | null): void;
  undockedOutlineVisible(): boolean;
  setUndockedOutlineVisible(visible: boolean): void;
  loadPdfPath(path: string, identity: string, sessionKey: string, surface: PdfUpdatePayload["surface"]): Promise<unknown>;
}

export class PreviewWindowController {
  private outlineNavigator: PreviewOutlineNavigator | null = null;
  private previewSurface: "live" | "pdf" = "live";
  private previewWindowNormalSize = {
    width: DEFAULT_UNDOCKED_PREVIEW_WIDTH,
    height: DEFAULT_UNDOCKED_PREVIEW_HEIGHT,
  };
  private previewWindowStateTimer: number | null = null;

  constructor(private readonly deps: PreviewWindowDependencies) {}

  isPreviewOnlyWindow(): boolean {
    return new URLSearchParams(window.location.search).get("mode") === "preview";
  }

  async bootstrap(): Promise<void> {
    const deps = this.deps;
    await initializePreviewGenerationSession();
    document.documentElement.classList.add("preview-only-mode");
    document.body.classList.add("preview-only-mode");

    await deps.loadSettings();
    await applyUIThemeVariables(deps.theme());
    deps.previewFrame.setColorMode(deps.previewColorMode());
    deps.previewFrame.syncTheme();

    document.getElementById("preview-zoom-in-btn")?.addEventListener("click", () => deps.zoomIn());
    document.getElementById("preview-zoom-out-btn")?.addEventListener("click", () => deps.zoomOut());
    document.getElementById("preview-zoom-fit-btn")?.addEventListener("click", () => deps.zoomToFit());
    document.getElementById("preview-search-btn")?.classList.remove("hidden");
    document.getElementById("preview-search-btn")?.addEventListener("click", () => deps.previewFrame.openStandalonePdfSearch());
    deps.initializePreviewPageControls();

    const undockBtn = document.getElementById("undock-preview-btn");
    if (undockBtn) {
      undockBtn.title = "Dock Preview";
      undockBtn.addEventListener("click", () => {
        void Promise.all([
          this.publishCurrentScrollPosition(),
          this.publishPreviewWindowState(),
        ]).catch(error => {
          console.error("Failed to publish the final undocked preview state", error);
        }).finally(() => getCurrentWindow().close());
      });
    }

    const previewWrapper = document.getElementById("preview-container-wrapper");
    if (previewWrapper) {
      previewWrapper.classList.remove("hidden");
      previewWrapper.style.display = "flex";
      previewWrapper.style.width = "100%";
      previewWrapper.style.height = "100%";
    }

    const previewPane = document.getElementById("preview-render-pane");
    if (previewPane) {
      this.outlineNavigator = new PreviewOutlineNavigator({
        host: previewPane,
        navigateBookmark: bookmarkIndex => {
          void deps.previewFrame.scrollToOutlineBookmark(bookmarkIndex);
        },
        navigateDestination: destination => {
          void deps.previewFrame.revealDocumentPosition({
            page_no: destination.pageNo,
            x: destination.x ?? 0,
            y: destination.y ?? 0,
          }, { ripple: true });
        },
        navigatePosition: position => {
          void deps.previewFrame.revealDocumentPosition(position, { ripple: true });
        },
      });
      this.outlineNavigator.setVisible(deps.undockedOutlineVisible());
    }

    await getCurrentWindow().show();
    const initialWindowState = undockedPreviewWindowStateFromQuery(window.location.search);
    this.previewWindowNormalSize = {
      width: initialWindowState.width,
      height: initialWindowState.height,
    };
    await this.initializePreviewWindowStateTracking();

    const { listen, emit } = await import("@tauri-apps/api/event");
    this.initializeOptions(
      action => emit("preview-window-action", action),
      mode => emit("preview-color-mode-request", mode),
    );
    document.getElementById("preview-recompile-btn")?.addEventListener("click", () => {
      void this.publishCurrentScrollPosition()
        .then(() => emit("preview-window-action", "recompile"))
        .catch(error => console.error("Failed to request preview compilation", error));
    });

    document.getElementById("preview-content-mode-toggle")?.addEventListener("click", () => {
      const requestedMode = deps.draftPreview.mode === "draft" ? "normal" : "draft";
      deps.draftPreview.setMode(requestedMode);
      deps.draftPreview.updateControl(true);
      void emit("preview-content-mode-request", requestedMode);
    });

    await listen<ThemeName>("preview-theme-update", event => {
      void applyUIThemeVariables(event.payload).then(() => deps.previewFrame.syncTheme());
    });

    await listen<number>("preview-ctrl-wheel-zoom-step-update", event => {
      setCtrlWheelZoomStepPercent(event.payload);
    });

    await listen<number>("preview-landscape-scale-update", event => {
      deps.previewFrame.setLandscapeScalePercent(event.payload);
    });

    await listen<PreviewColorMode>("preview-color-mode-update", event => {
      deps.setPreviewColorMode(event.payload);
      deps.previewFrame.setColorMode(event.payload);
    });

    await listen<readonly PreviewSourceOutlineItem[]>("preview-outline-update", event => {
      this.setSourceOutline(event.payload);
    });

    await listen<string | PdfUpdatePayload>("pdf-update", async event => {
      const fallbackIdentity = deps.sourceMapRootPath() ?? deps.previewRootPath() ?? "preview";
      const update = typeof event.payload === "string"
        ? { path: event.payload, identity: fallbackIdentity, sessionKey: fallbackIdentity, surface: "live" as const }
        : event.payload;
      this.previewSurface = update.surface;
      try {
        document.getElementById("preview-container-wrapper")?.setAttribute(
          "data-preview-status-enabled", String(update.surface === "live"),
        );
        if (update.freshness) renderPreviewFreshnessBanner(update.freshness);
        if (update.previewColorMode) {
          deps.setPreviewColorMode(update.previewColorMode);
          deps.previewFrame.setColorMode(update.previewColorMode);
        }
        deps.draftPreview.installPresentedState({
          mode: update.contentMode ?? "normal",
          assets: update.draftAssets ?? [],
          assetRootPath: update.draftAssetRootPath ?? null,
          generation: update.draftThumbnailGeneration ?? 0,
        });
        deps.setWorkspaceRootPath(update.draftAssetRootPath ?? null);
        if (update.viewportAnchor) {
          deps.previewFrame.queueViewportAnchor(update.viewportAnchor);
        } else if (typeof update.scrollTop === "number" && Number.isFinite(update.scrollTop)) {
          deps.previewFrame.queueTabScrollPosition(update.scrollTop);
        }
        const toggle = document.getElementById("preview-content-mode-toggle") as HTMLButtonElement | null;
        toggle?.classList.remove("hidden");
        if (!update.reuseMounted || !deps.previewFrame.retainMountedLivePreview(update.identity, update.sessionKey)) {
          await deps.loadPdfPath(update.path, update.identity, update.sessionKey, update.surface);
        }
      } finally {
        await releasePreviewGeneration(update.generationLease);
      }
      void emit("preview-outline-request");
    });

    await listen<{ page_no: number; x: number; y: number }>("pdf-forward-sync", event => {
      void deps.previewFrame.revealDocumentPosition(event.payload);
    });

    await listen<PreviewFreshness>("preview-freshness-update", event => {
      renderPreviewFreshnessBanner(event.payload);
    });
    await listen<boolean>("preview-error-panel-update", event => {
      deps.previewFrame.setCompilerErrorPanelEnabled(event.payload);
    });

    // Do not allocate handoff readers before this window has an update listener.
    await invoke("ready_preview_generation_window");
    void emit("preview-window-ready");
  }

  public setSourceOutline(items: readonly PreviewSourceOutlineItem[]): void {
    if (this.previewSurface === "pdf") return;
    this.outlineNavigator?.setSourceOutline(items);
  }

  public setStandalonePdfOutline(items: readonly PdfiumOutlineItem[] | null): void {
    if (items !== null) this.previewSurface = "pdf";
    this.outlineNavigator?.setStandalonePdfOutline(items);
  }

  private setOutlineVisible(visible: boolean): void {
    this.deps.setUndockedOutlineVisible(visible);
    this.outlineNavigator?.setVisible(visible);
    void import("@tauri-apps/api/event")
      .then(({ emit }) => emit("preview-outline-visible-request", visible))
      .catch(error => console.error("Failed to synchronize undocked outline visibility", error));
  }

  private async initializePreviewWindowStateTracking(): Promise<void> {
    const previewWindow = getCurrentWindow();
    const schedule = () => {
      if (this.previewWindowStateTimer !== null) {
        window.clearTimeout(this.previewWindowStateTimer);
      }
      this.previewWindowStateTimer = window.setTimeout(() => {
        this.previewWindowStateTimer = null;
        void this.publishPreviewWindowState();
      }, 150);
    };
    await previewWindow.onResized(schedule);
    window.addEventListener("resize", schedule);
    void previewWindow.onCloseRequested(() => {
      void this.publishPreviewWindowState();
    });
  }

  private async publishPreviewWindowState(): Promise<void> {
    const previewWindow = getCurrentWindow();
    if (await previewWindow.isMinimized()) return;
    const maximized = await previewWindow.isMaximized();
    if (!maximized) {
      const scale = await previewWindow.scaleFactor();
      const size = (await previewWindow.innerSize()).toLogical(scale);
      if (size.width >= MIN_UNDOCKED_PREVIEW_WIDTH && size.height >= MIN_UNDOCKED_PREVIEW_HEIGHT) {
        this.previewWindowNormalSize = {
          width: Math.round(size.width),
          height: Math.round(size.height),
        };
      }
    }
    const { emit } = await import("@tauri-apps/api/event");
    await emit("preview-window-state-changed", {
      ...this.previewWindowNormalSize,
      maximized,
    } satisfies StoredUndockedPreviewWindow);
  }

  publishScrollPosition(scrollTop: number): void {
    const sessionKey = this.deps.previewFrame.currentSessionKey;
    if (!sessionKey || !Number.isFinite(scrollTop)) return;
    void import("@tauri-apps/api/event")
      .then(({ emit }) => emit("preview-scroll-position-changed", {
        sessionKey,
        scrollTop: Math.max(0, scrollTop),
        viewportAnchor: this.deps.previewFrame.currentViewportAnchor,
      } satisfies PreviewScrollPositionPayload))
      .catch(error => console.error("Failed to publish undocked preview position", error));
  }

  private async publishCurrentScrollPosition(): Promise<void> {
    const sessionKey = this.deps.previewFrame.currentSessionKey;
    if (!sessionKey) return;
    const { emit } = await import("@tauri-apps/api/event");
    await emit("preview-scroll-position-changed", {
      sessionKey,
      scrollTop: this.deps.previewFrame.currentScrollTop,
      viewportAnchor: this.deps.previewFrame.currentViewportAnchor,
    } satisfies PreviewScrollPositionPayload);
  }

  private initializeOptions(
    requestMainWindowAction: (action: UndockedPreviewAction) => Promise<void>,
    requestColorMode: (mode: PreviewColorMode) => Promise<void>,
  ): void {
    const deps = this.deps;
    const button = document.getElementById("preview-menu-btn");
    const menu = document.getElementById("context-menu");
    if (!button || !menu) return;

    const hide = () => {
      menu.style.display = "none";
      delete menu.dataset.menuKind;
    };
    const show = () => {
      const colorMode = deps.previewColorMode();
      const outlineVisible = deps.undockedOutlineVisible();
      const colorItem = (mode: PreviewColorMode, label: string) => `
        <div class="dropdown-item preview-color-mode-item" data-preview-color-mode="${mode}" role="menuitemradio" aria-checked="${colorMode === mode}">
          <span>${label}</span><span class="preview-color-mode-check" aria-hidden="true">${colorMode === mode ? "✓" : ""}</span>
        </div>`;
      menu.innerHTML = `
        <div class="dropdown-item" data-preview-action="zoom-out">Zoom Out</div>
        <div class="dropdown-item" data-preview-action="zoom-fit">Fit to Width</div>
        <div class="dropdown-item" data-preview-action="zoom-in">Zoom In</div>
        <div class="dropdown-separator"></div>
        <div class="dropdown-submenu">
          <div class="dropdown-item dropdown-submenu-trigger" role="menuitem" tabindex="0" aria-haspopup="menu" aria-expanded="false">
            <span>Preview colors</span><span class="dropdown-submenu-arrow" aria-hidden="true">›</span>
          </div>
          <div class="dropdown-submenu-menu dropdown-submenu-menu-left context-preview-color-submenu-menu" role="menu">
            ${colorItem("document", "Document colors")}
            ${colorItem("dark", "Dark preview")}
            ${colorItem("inverted", "Inverted preview (experimental)")}
          </div>
        </div>
        <div class="dropdown-separator"></div>
        <div class="dropdown-item" data-preview-action="toggle-outline" role="menuitemcheckbox" aria-checked="${outlineVisible}">
          <span>Outline panel</span><span class="preview-color-mode-check" aria-hidden="true">${outlineVisible ? "✓" : ""}</span>
        </div>
        <div class="dropdown-separator"></div>
        <div class="dropdown-item" data-preview-action="export-pdf">Export PDF</div>
        <div class="dropdown-item" data-preview-action="open-external">Open in External Viewer</div>
        <div class="dropdown-separator"></div>
        <div class="dropdown-item" data-preview-action="dock">Dock Preview</div>`;
      menu.dataset.menuKind = "preview";
      menu.style.display = "block";
      const buttonRect = button.getBoundingClientRect();
      const menuRect = menu.getBoundingClientRect();
      menu.style.left = `${Math.max(0, Math.min(buttonRect.right - menuRect.width, window.innerWidth - menuRect.width))}px`;
      menu.style.top = `${Math.max(0, Math.min(buttonRect.bottom + 4, window.innerHeight - menuRect.height))}px`;
    };

    button.addEventListener("click", event => {
      event.stopPropagation();
      if (menu.style.display === "block" && menu.dataset.menuKind === "preview") hide();
      else show();
    });
    menu.addEventListener("click", event => {
      const trigger = (event.target as HTMLElement).closest<HTMLElement>(".dropdown-submenu-trigger");
      if (trigger) {
        event.preventDefault();
        event.stopPropagation();
        const submenu = trigger.nextElementSibling as HTMLElement | null;
        const expanded = !submenu?.classList.contains("submenu-open");
        submenu?.classList.toggle("submenu-open", expanded);
        trigger.setAttribute("aria-expanded", String(expanded));
        return;
      }
      const colorMode = (event.target as HTMLElement)
        .closest<HTMLElement>("[data-preview-color-mode]")?.dataset.previewColorMode as PreviewColorMode | undefined;
      if (colorMode) {
        deps.setPreviewColorMode(colorMode);
        void requestColorMode(colorMode);
        hide();
        return;
      }
      const action = (event.target as HTMLElement).closest<HTMLElement>("[data-preview-action]")?.dataset.previewAction;
      if (!action) return;
      hide();
      if (action === "zoom-out") deps.zoomOut();
      else if (action === "zoom-fit") deps.zoomToFit();
      else if (action === "zoom-in") deps.zoomIn();
      else if (action === "toggle-outline") this.setOutlineVisible(!deps.undockedOutlineVisible());
      else if (action === "dock") document.getElementById("undock-preview-btn")?.click();
      else if (action === "export-pdf" || action === "open-external") void requestMainWindowAction(action);
    });
    document.addEventListener("click", hide);
    window.addEventListener("blur", hide);
    window.addEventListener("message", event => {
      const type = (event.data as { type?: unknown } | null)?.type;
      if (type === "HIDE_CONTEXT_MENU" || type === "SHOW_PREVIEW_CONTEXT_MENU") hide();
    });
  }
}
