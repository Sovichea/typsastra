export type PreviewZoomGesture = { factor: number; clientX: number; clientY: number; deltaPercent?: number; ensureStep?: boolean };

export function snapGestureZoom(percent: number, minimum = 5, maximum = 2000): number {
  return Math.max(minimum, Math.min(maximum, Math.round(percent / 5) * 5));
}

export function buttonZoomPercent(percent: number, direction: 1 | -1, minimum = 5, maximum = 2000): number {
  return snapGestureZoom(percent + direction * 25, minimum, maximum);
}

/** Retain sub-step movement so small pinch deltas eventually cross a 5% step. */
export class GestureZoomSteps {
  private raw: number | null = null;
  constructor(private readonly minimum = 5, private readonly maximum = 2000) {}
  reset(): void { this.raw = null; }
  next(currentPercent: number, factor: number, deltaPercent = 0, ensureStep = false): number {
    const previous = this.raw ?? currentPercent;
    this.raw = Math.max(this.minimum, Math.min(this.maximum,
      (deltaPercent !== 0 ? currentPercent : previous) * factor + deltaPercent));
    if (!ensureStep) return snapGestureZoom(this.raw, this.minimum, this.maximum);
    // Precision touchpads may emit only one or two +/-1 pixel wheel events.
    // Round in the direction of movement so a short pinch is not rounded
    // away, while retaining the raw value for subsequent input in this pinch.
    const percent = this.raw > previous ? Math.ceil(this.raw / 5) * 5
      : this.raw < previous ? Math.floor(this.raw / 5) * 5
      : currentPercent;
    return Math.max(this.minimum, Math.min(this.maximum, percent));
  }
}

export function wheelZoomFactor(deltaY: number, deltaMode = 0, pageHeight = 800): number {
  const pixels = deltaY * (deltaMode === 1 ? 16 : deltaMode === 2 ? pageHeight : 1);
  return Math.exp(-Math.max(-200, Math.min(200, pixels)) * 0.005);
}

/** Shared input handling for previews in the main document and PDF iframes. */
export function installPreviewZoomGestures(
  target: HTMLElement | Document,
  onZoom: (gesture: PreviewZoomGesture) => void,
  options: { enabled?: () => boolean; onStart?: () => void; onEnd?: () => void; onCancel?: () => void; onInput?: (message: string) => void } = {},
): () => void {
  let frame: number | null = null;
  let endTimer: ReturnType<typeof setTimeout> | null = null;
  let pending: PreviewZoomGesture | null = null;
  let active = false;
  let zoomDispatchLogged = false;
  let distance: number | null = null;
  let nativeScale: number | null = null;
  const enabled = () => options.enabled?.() !== false;
  const flush = () => {
    frame = null;
    const gesture = pending;
    pending = null;
    if (gesture && enabled()) {
      onZoom(gesture);
      if (!zoomDispatchLogged) {
        options.onInput?.(`[zoom-input] ZOOM DISPATCHED; factor=${gesture.factor.toFixed(4)}; step=${gesture.deltaPercent ?? 0}%.`);
        zoomDispatchLogged = true;
      }
    }
  };
  const finish = () => {
    if (endTimer !== null) clearTimeout(endTimer);
    endTimer = null;
    if (frame !== null) cancelAnimationFrame(frame);
    flush();
    if (active) {
      options.onEnd?.();
      options.onInput?.("[zoom-input] ZOOM SEQUENCE ENDED");
    }
    active = false;
  };
  const begin = () => { if (!active) { active = true; zoomDispatchLogged = false; options.onStart?.(); } };
  const enqueue = (factor: number, clientX: number, clientY: number, deltaPercent = 0, ensureStep = false) => {
    if (!Number.isFinite(factor) || factor <= 0 || (factor === 1 && deltaPercent === 0)) return;
    begin();
    const rect = (target as HTMLElement).getBoundingClientRect?.();
    const view = (target as Document).defaultView;
    pending = {
      factor: (pending?.factor ?? 1) * factor,
      deltaPercent: (pending?.deltaPercent ?? 0) * factor + deltaPercent,
      ensureStep: Boolean(pending?.ensureStep || ensureStep),
      clientX: Number.isFinite(clientX) ? clientX : rect ? rect.left + rect.width / 2 : (view?.innerWidth ?? 0) / 2,
      clientY: Number.isFinite(clientY) ? clientY : rect ? rect.top + rect.height / 2 : (view?.innerHeight ?? 0) / 2,
    };
    if (frame === null) frame = requestAnimationFrame(flush);
    if (endTimer !== null) clearTimeout(endTimer);
    endTimer = setTimeout(finish, 180);
  };
  const claim = (event: Event) => { event.preventDefault(); event.stopPropagation(); };
  const wheel = (event: WheelEvent) => {
    if (!enabled() || event.defaultPrevented || (!event.ctrlKey && !event.metaKey)) return;
    if (!Number.isFinite(event.deltaY) || event.deltaY === 0) return;
    claim(event);
    // Safari may emit both gesture and wheel events for one native pinch.
    if (nativeScale !== null || distance !== null) return;
    // Mouse-wheel notches are much larger than precision touchpad pinch deltas.
    // Each notch should advance 5%, rather than causing a large exponential jump.
    if (event.deltaMode !== 0 || Math.abs(event.deltaY) >= 40) {
      enqueue(1, event.clientX, event.clientY, event.deltaY < 0 ? 5 : -5);
    } else {
      enqueue(wheelZoomFactor(event.deltaY, event.deltaMode), event.clientX, event.clientY, 0, true);
    }
  };
  const touchGeometry = (event: TouchEvent) => {
    if (event.touches.length < 2) return null;
    const first = event.touches[0], second = event.touches[1];
    return { distance: Math.hypot(second.clientX - first.clientX, second.clientY - first.clientY),
      x: (first.clientX + second.clientX) / 2, y: (first.clientY + second.clientY) / 2 };
  };
  const touchStart = (event: TouchEvent) => {
    if (!enabled()) return;
    const point = touchGeometry(event);
    if (!point) return;
    claim(event);
    begin();
    distance = point.distance;
  };
  const touchMove = (event: TouchEvent) => {
    if (!enabled() || distance === null) return;
    const point = touchGeometry(event);
    if (!point) return;
    claim(event);
    if (distance > 0 && point.distance > 0) enqueue(point.distance / distance, point.x, point.y);
    distance = point.distance;
  };
  const touchEnd = (event: TouchEvent) => {
    if (event.touches.length >= 2) { distance = touchGeometry(event)?.distance ?? null; return; }
    if (distance !== null) { distance = null; finish(); }
  };
  type NativeGesture = Event & { scale: number; clientX: number; clientY: number };
  const gestureStart = (event: NativeGesture) => {
    if (!enabled()) return;
    claim(event);
    begin();
    nativeScale = event.scale > 0 ? event.scale : 1;
  };
  const gestureChange = (event: NativeGesture) => {
    if (!enabled() || nativeScale === null || !Number.isFinite(event.scale) || event.scale <= 0) return;
    claim(event);
    enqueue(event.scale / nativeScale, event.clientX, event.clientY, 0, true);
    nativeScale = event.scale;
  };
  const gestureEnd = (event: Event) => {
    if (nativeScale === null) return;
    claim(event);
    nativeScale = null;
    finish();
  };
  // Native pinch gestures can target the iframe window rather than its DOM.
  const eventTarget = (target as Document).defaultView ?? target;
  let lastInputLog = 0;
  let disposed = false;
  const touchPointers = new Set<number>();
  const diagnostic = (message: string) => options.onInput?.(`[zoom-input] ${message}`);
  if (options.onInput) queueMicrotask(() => {
    if (disposed) return;
    const doc = (target as HTMLElement).ownerDocument ?? target as Document;
    const view = doc.defaultView;
    diagnostic(`LISTENING; touchpadPinch=unsupported; surface=${(target as HTMLElement).tagName ?? "PDF iframe"}; enabled=${enabled()}; maxTouchPoints=${view?.navigator?.maxTouchPoints ?? 0}; touchEvents=${Boolean(view && "TouchEvent" in view)}; pointerEvents=${Boolean(view && "PointerEvent" in view)}.`);
  });
  const reportInput = (event: Event) => {
    if (!options.onInput) return;
    const input = event as WheelEvent & TouchEvent & PointerEvent;
    const pointer = event.type.startsWith("pointer");
    if (pointer) {
      if (input.pointerType !== "touch") return;
      if (event.type === "pointerdown") touchPointers.add(input.pointerId);
      if (event.type === "pointerup" || event.type === "pointercancel") touchPointers.delete(input.pointerId);
    }
    const now = Date.now();
    if (now - lastInputLog < 300 && ["wheel", "touchmove", "pointermove"].includes(event.type)) return;
    lastInputLog = now;
    const label = event.type.startsWith("gesture") ? "PINCH DETECTED (native gesture)"
      : (input.touches?.length ?? 0) >= 2 ? "PINCH DETECTED (touchscreen)"
      : touchPointers.size >= 2 ? "PINCH SIGNAL (touch pointers)"
      : event.type === "wheel" && (input.ctrlKey || input.metaKey) ? "ZOOM CANDIDATE (Ctrl-wheel or touchpad pinch)"
      : event.type === "wheel" ? "SCROLL ONLY (no pinch modifier)" : "RAW TOUCH INPUT";
    diagnostic(`${label}; type=${event.type}; enabled=${enabled()}; ctrl=${Boolean(input.ctrlKey)}; meta=${Boolean(input.metaKey)}; deltaY=${input.deltaY ?? 0}; deltaX=${input.deltaX ?? 0}; deltaZ=${input.deltaZ ?? 0}; mode=${input.deltaMode ?? 0}; touches=${input.touches?.length ?? 0}; touchPointers=${touchPointers.size}; prevented=${event.defaultPrevented}.`);
  };
  const handlers: Array<[string, EventListener]> = [
    ["wheel", wheel as EventListener], ["touchstart", touchStart as EventListener],
    ["touchmove", touchMove as EventListener], ["touchend", touchEnd as EventListener],
    ["touchcancel", touchEnd as EventListener], ["gesturestart", gestureStart as EventListener],
    ["gesturechange", gestureChange as EventListener], ["gestureend", gestureEnd],
    ["pointerdown", () => {}], ["pointermove", () => {}], ["pointerup", () => {}], ["pointercancel", () => {}],
  ];
  const listeners: Array<[string, EventListener]> = handlers.map(([name, handler]) => [name, event => { reportInput(event); handler(event); }]);
  for (const [name, listener] of listeners) eventTarget.addEventListener(name, listener, { passive: false, capture: true });
  return () => {
    disposed = true;
    for (const [name, listener] of listeners) eventTarget.removeEventListener(name, listener, true);
    if (frame !== null) cancelAnimationFrame(frame);
    if (endTimer !== null) clearTimeout(endTimer);
    pending = null;
    if (active) options.onCancel?.();
    active = false;
  };
}

/** Preserve the document point under the gesture when CSS zoom changes. */
export function zoomPreviewElementAtPoint(
  container: HTMLElement, element: HTMLElement | SVGSVGElement, previousScale: number, nextScale: number,
  point: { clientX: number; clientY: number }, apply: () => void,
): void {
  const before = element.getBoundingClientRect();
  const x = (point.clientX - before.left) / previousScale;
  const y = (point.clientY - before.top) / previousScale;
  apply();
  const after = element.getBoundingClientRect();
  container.scrollLeft += after.left + x * nextScale - point.clientX;
  container.scrollTop += after.top + y * nextScale - point.clientY;
}
