export interface ImagePreviewControllerPort {
  setMessage(html: string): void;
  setError(title: string, detail: string): void;
  updateToolbar(path: string): void;
  updateZoomLabel(scale: number): void;
}

export type ImageCropRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type ImageCropSource = {
  width: number;
  height: number;
};

const CROP_HANDLE_DIRECTIONS = ["nw", "n", "ne", "e", "se", "s", "sw", "w"] as const;
type CropHandleDirection = typeof CROP_HANDLE_DIRECTIONS[number];

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
  private cropOverlayCleanup: (() => void) | null = null;

  constructor(private readonly port: ImagePreviewControllerPort) {}

  clear(): void {
    this.clearCropOverlay();
    this.cleanupAction?.();
    this.cleanupAction = null;
    this.zoomInAction = null;
    this.zoomOutAction = null;
    this.zoomToFitAction = null;
    this.zoomPercentAction = null;
    this.fitStateAction = null;
  }

  public clearCropOverlay(): void {
    this.cropOverlayCleanup?.();
    this.cropOverlayCleanup = null;
    document.getElementById("interactive-image-crop-overlay")?.remove();
  }

  /**
   * Overlays a draggable/resizable crop rectangle on the mounted image. The
   * caller owns the crop state; every interaction reports a clamped rect in
   * source pixels through `onInput`.
   */
  public showCropOverlay(
    rect: ImageCropRect,
    source: ImageCropSource,
    onInput: (rect: ImageCropRect) => void,
    options: { interactive?: boolean } = {},
  ): boolean {
    this.clearCropOverlay();
    const container = document.getElementById("interactive-image-container");
    const image = document.getElementById("interactive-image-el") as HTMLImageElement | null;
    if (!container || !image || !image.complete || image.naturalWidth <= 0) return false;

    const interactive = options.interactive ?? true;
    const overlay = document.createElement("div");
    overlay.id = "interactive-image-crop-overlay";
    overlay.className = "image-crop-overlay";
    overlay.classList.toggle("image-crop-overlay-locked", !interactive);
    const frame = document.createElement("div");
    frame.className = "image-crop-frame";
    for (const direction of CROP_HANDLE_DIRECTIONS) {
      const handle = document.createElement("span");
      handle.className = `image-crop-handle image-crop-handle-${direction}`;
      handle.dataset.cropHandle = direction;
      frame.appendChild(handle);
    }
    overlay.appendChild(frame);
    container.appendChild(overlay);

    let current: ImageCropRect = { ...rect };
    const clamp = (value: ImageCropRect): ImageCropRect => {
      const width = Math.max(1, Math.min(Math.round(value.width), source.width));
      const height = Math.max(1, Math.min(Math.round(value.height), source.height));
      const x = Math.max(0, Math.min(Math.round(value.x), source.width - width));
      const y = Math.max(0, Math.min(Math.round(value.y), source.height - height));
      return { x, y, width, height };
    };
    current = clamp(current);

    const imageMetrics = () => {
      const imageRect = image.getBoundingClientRect();
      return {
        left: imageRect.left,
        top: imageRect.top,
        scaleX: imageRect.width / source.width,
        scaleY: imageRect.height / source.height,
      };
    };
    const sync = () => {
      const metrics = imageMetrics();
      const containerRect = container.getBoundingClientRect();
      frame.style.left = `${metrics.left - containerRect.left + current.x * metrics.scaleX}px`;
      frame.style.top = `${metrics.top - containerRect.top + current.y * metrics.scaleY}px`;
      frame.style.width = `${current.width * metrics.scaleX}px`;
      frame.style.height = `${current.height * metrics.scaleY}px`;
    };
    const report = () => {
      current = clamp(current);
      sync();
      onInput({ ...current });
    };

    const toSource = (clientX: number, clientY: number) => {
      const metrics = imageMetrics();
      return {
        x: (clientX - metrics.left) / metrics.scaleX,
        y: (clientY - metrics.top) / metrics.scaleY,
      };
    };

    let drag: {
      mode: "move" | "resize" | "new";
      direction?: CropHandleDirection;
      origin: { x: number; y: number };
      start: ImageCropRect;
    } | null = null;

    const resize = (direction: CropHandleDirection, start: ImageCropRect, dx: number, dy: number): ImageCropRect => {
      let { x, y, width, height } = start;
      if (direction.includes("w")) {
        const nextX = start.x + dx;
        x = Math.min(nextX, start.x + start.width - 1);
        width = start.x + start.width - x;
      }
      if (direction.includes("e")) width = start.width + dx;
      if (direction.includes("n")) {
        const nextY = start.y + dy;
        y = Math.min(nextY, start.y + start.height - 1);
        height = start.y + start.height - y;
      }
      if (direction.includes("s")) height = start.height + dy;
      return { x, y, width, height };
    };

    const handlePointerDown = (event: PointerEvent) => {
      if (!interactive || event.button !== 0) return;
      const target = event.target as HTMLElement | null;
      const handleDirection = target?.dataset.cropHandle as CropHandleDirection | undefined;
      const insideFrame = target === frame || Boolean(target?.closest(".image-crop-frame"));
      const sourcePoint = toSource(event.clientX, event.clientY);
      drag = handleDirection
        ? { mode: "resize", direction: handleDirection, origin: sourcePoint, start: { ...current } }
        : insideFrame
          ? { mode: "move", origin: sourcePoint, start: { ...current } }
          : { mode: "new", origin: sourcePoint, start: { x: sourcePoint.x, y: sourcePoint.y, width: 1, height: 1 } };
      if (drag.mode === "new") current = clamp(drag.start);
      overlay.setPointerCapture(event.pointerId);
      event.preventDefault();
      event.stopPropagation();
    };

    const handlePointerMove = (event: PointerEvent) => {
      if (!drag) return;
      const point = toSource(event.clientX, event.clientY);
      const dx = point.x - drag.origin.x;
      const dy = point.y - drag.origin.y;
      if (drag.mode === "move") {
        current = { ...drag.start, x: drag.start.x + dx, y: drag.start.y + dy };
      } else if (drag.mode === "resize" && drag.direction) {
        current = resize(drag.direction, drag.start, dx, dy);
      } else {
        current = {
          x: Math.min(drag.origin.x, point.x),
          y: Math.min(drag.origin.y, point.y),
          width: Math.abs(point.x - drag.origin.x),
          height: Math.abs(point.y - drag.origin.y),
        };
      }
      report();
      event.preventDefault();
      event.stopPropagation();
    };

    const endDrag = (event: PointerEvent) => {
      if (!drag) return;
      const wasNew = drag.mode === "new";
      drag = null;
      if (wasNew && (current.width < 2 || current.height < 2)) {
        current = clamp({ ...rect });
      }
      report();
      if (overlay.hasPointerCapture?.(event.pointerId)) overlay.releasePointerCapture(event.pointerId);
    };

    const blockMouseDown = (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
    };
    const blockWheel = (event: WheelEvent) => {
      event.preventDefault();
      event.stopPropagation();
    };

    overlay.addEventListener("pointerdown", handlePointerDown);
    overlay.addEventListener("pointermove", handlePointerMove);
    overlay.addEventListener("pointerup", endDrag);
    overlay.addEventListener("pointercancel", endDrag);
    overlay.addEventListener("mousedown", blockMouseDown);
    overlay.addEventListener("wheel", blockWheel, { passive: false });

    const resizeObserver = new ResizeObserver(sync);
    resizeObserver.observe(container);
    // A locked (non-interactive) selection stays visible while the user
    // pans or zooms, so follow the image's transform updates too.
    const transformObserver = new MutationObserver(sync);
    transformObserver.observe(image, { attributes: true, attributeFilter: ["style"] });
    window.addEventListener("resize", sync);
    sync();

    this.cropOverlayCleanup = () => {
      resizeObserver.disconnect();
      transformObserver.disconnect();
      window.removeEventListener("resize", sync);
      overlay.removeEventListener("pointerdown", handlePointerDown);
      overlay.removeEventListener("pointermove", handlePointerMove);
      overlay.removeEventListener("pointerup", endDrag);
      overlay.removeEventListener("pointercancel", endDrag);
      overlay.removeEventListener("mousedown", blockMouseDown);
      overlay.removeEventListener("wheel", blockWheel);
    };
    return true;
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
