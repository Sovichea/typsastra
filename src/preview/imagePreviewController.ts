export interface ImagePreviewControllerPort {
  setMessage(html: string): void;
  setError(title: string, detail: string): void;
  updateToolbar(path: string): void;
  updateZoomLabel(scale: number): void;
}

export function imagePreviewFitScale(
  containerWidth: number,
  containerHeight: number,
  imageWidth: number,
  imageHeight: number,
): number | null {
  if (containerWidth <= 0 || containerHeight <= 0 || imageWidth <= 0 || imageHeight <= 0) {
    return null;
  }
  return Math.min(containerWidth / imageWidth, containerHeight / imageHeight, 20);
}

/** Owns the interactive image preview's transient zoom, pan, and fit state. */
export class ImagePreviewController {
  private zoomInAction: (() => void) | null = null;
  private zoomOutAction: (() => void) | null = null;
  private zoomToFitAction: (() => void) | null = null;
  private zoomPercentAction: (() => number) | null = null;
  private fitStateAction: (() => boolean) | null = null;
  private cleanupAction: (() => void) | null = null;

  constructor(private readonly port: ImagePreviewControllerPort) {}

  clear(): void {
    this.cleanupAction?.();
    this.cleanupAction = null;
    this.zoomInAction = null;
    this.zoomOutAction = null;
    this.zoomToFitAction = null;
    this.zoomPercentAction = null;
    this.fitStateAction = null;
  }

  get zoomPercent(): number | null {
    return this.zoomPercentAction?.() ?? null;
  }

  get isFit(): boolean | null {
    return this.fitStateAction?.() ?? null;
  }

  zoomIn(): boolean {
    if (!this.zoomInAction) return false;
    this.zoomInAction();
    return true;
  }

  zoomOut(): boolean {
    if (!this.zoomOutAction) return false;
    this.zoomOutAction();
    return true;
  }

  zoomToFit(): boolean {
    if (!this.zoomToFitAction) return false;
    this.zoomToFitAction();
    return true;
  }

  render(src: string, previewPath: string): void {
    this.clear();
    this.port.updateToolbar(previewPath);
    this.port.setMessage(
      `<div id="interactive-image-container" style="position:relative;width:100%;height:100%;background:var(--ui-bg);overflow:hidden;display:flex;align-items:center;justify-content:center;user-select:none;box-sizing:border-box;">` +
      `<div id="interactive-image-loading" class="preview-loading-placeholder" role="status" aria-live="polite">` +
      `<div class="preview-loading-spinner" aria-hidden="true"></div>` +
      `<div class="preview-loading-message">Preparing image preview…</div>` +
      `</div>` +
      `<img id="interactive-image-el" alt="Image preview" draggable="false" style="max-width:none;max-height:none;position:absolute;cursor:grab;user-select:none;will-change:transform;visibility:hidden;" />` +
      `</div>`,
    );

    const container = document.getElementById("interactive-image-container");
    const image = document.getElementById("interactive-image-el") as HTMLImageElement | null;
    if (!container || !image) return;

    let scale = 1;
    let x = 0;
    let y = 0;
    let dragging = false;
    let startX = 0;
    let startY = 0;
    let fit = true;
    let resizeFrame: number | null = null;

    const updateTransform = () => {
      image.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
    };
    const resetToFit = () => {
      const nextScale = imagePreviewFitScale(
        container.clientWidth,
        container.clientHeight,
        image.naturalWidth,
        image.naturalHeight,
      );
      if (nextScale === null) return;
      scale = nextScale;
      x = 0;
      y = 0;
      updateTransform();
      image.style.visibility = "visible";
    };
    const updateZoom = () => this.port.updateZoomLabel(scale);
    const refitAfterResize = () => {
      if (!fit || !image.complete || image.naturalWidth <= 0) return;
      if (resizeFrame !== null) cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(() => {
        resizeFrame = null;
        if (!fit) return;
        resetToFit();
        updateZoom();
      });
    };

    this.zoomInAction = () => {
      scale = Math.min(scale * 1.2, 20);
      fit = false;
      updateTransform();
      updateZoom();
    };
    this.zoomOutAction = () => {
      scale = Math.max(scale / 1.2, 0.05);
      fit = false;
      updateTransform();
      updateZoom();
    };
    this.zoomToFitAction = () => {
      resetToFit();
      fit = true;
      updateZoom();
    };
    this.zoomPercentAction = () => scale;
    this.fitStateAction = () => fit;

    image.onload = () => {
      requestAnimationFrame(() => {
        resetToFit();
        fit = true;
        updateZoom();
        document.getElementById("interactive-image-loading")?.remove();
      });
    };
    image.onerror = () => {
      document.getElementById("interactive-image-loading")?.remove();
      this.port.setError(
        "Image preview unavailable",
        "Typsastra could not decode this image.",
      );
    };
    image.src = src;

    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = container.getBoundingClientRect();
      const mouseX = event.clientX - rect.left - rect.width / 2;
      const mouseY = event.clientY - rect.top - rect.height / 2;
      const previousScale = scale;
      scale = event.deltaY < 0
        ? Math.min(scale * 1.1, 20)
        : Math.max(scale / 1.1, 0.05);
      x = mouseX - (mouseX - x) * (scale / previousScale);
      y = mouseY - (mouseY - y) * (scale / previousScale);
      fit = false;
      updateTransform();
      updateZoom();
    };

    const handleMouseDown = (event: MouseEvent) => {
      if (event.button !== 0) return;
      dragging = true;
      image.style.cursor = "grabbing";
      startX = event.clientX - x;
      startY = event.clientY - y;
      event.preventDefault();
    };
    const handleMouseMove = (event: MouseEvent) => {
      if (!dragging) return;
      x = event.clientX - startX;
      y = event.clientY - startY;
      updateTransform();
    };
    const handleMouseUp = () => {
      if (!dragging) return;
      dragging = false;
      image.style.cursor = "grab";
    };
    container.addEventListener("wheel", handleWheel, { passive: false });
    container.addEventListener("mousedown", handleMouseDown);
    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);

    const resizeObserver = new ResizeObserver(refitAfterResize);
    resizeObserver.observe(container);
    this.cleanupAction = () => {
      resizeObserver.disconnect();
      if (resizeFrame !== null) cancelAnimationFrame(resizeFrame);
      container.removeEventListener("wheel", handleWheel);
      container.removeEventListener("mousedown", handleMouseDown);
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
      image.onload = null;
      image.onerror = null;
    };
  }
}
