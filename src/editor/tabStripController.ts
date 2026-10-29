export function tabStripWheelDelta(
  event: Pick<WheelEvent, "deltaX" | "deltaY" | "deltaMode">,
  pageWidth: number
): number {
  const dominantDelta = Math.abs(event.deltaX) > Math.abs(event.deltaY)
    ? event.deltaX
    : event.deltaY;
  const scale = event.deltaMode === 1
    ? 16
    : event.deltaMode === 2
      ? Math.max(1, pageWidth)
      : 1;
  return dominantDelta * scale;
}

/** Owns wheel/trackpad scrolling and active-tab reveal for the tab strip. */
export class TabStripController {
  private readonly resizeObserver = new ResizeObserver(() => this.scheduleUpdate());
  private readonly mutationObserver = new MutationObserver(() => this.scheduleUpdate(true));
  private updateFrame: number | null = null;

  constructor(private readonly strip: HTMLElement) {}

  public initialize(): void {
    this.strip.addEventListener("wheel", event => {
      const maxScroll = Math.max(0, this.strip.scrollWidth - this.strip.clientWidth);
      if (maxScroll <= 1) return;
      const delta = tabStripWheelDelta(event, this.strip.clientWidth);
      if (Math.abs(delta) < 0.01) return;

      // Apply wheel and trackpad deltas directly so native gesture momentum is
      // preserved. Smooth scrolling here would queue animations behind the
      // incoming gesture and make the tab strip feel delayed.
      this.strip.scrollLeft = Math.max(0, Math.min(maxScroll, this.strip.scrollLeft + delta));
      event.preventDefault();
    }, { passive: false });
    this.resizeObserver.observe(this.strip);
    this.mutationObserver.observe(this.strip, { childList: true });
    this.scheduleUpdate(true);
  }

  private scheduleUpdate(revealActive = false): void {
    if (this.updateFrame !== null) cancelAnimationFrame(this.updateFrame);
    this.updateFrame = requestAnimationFrame(() => {
      this.updateFrame = null;
      if (!revealActive) return;
      const activeTab = this.strip.querySelector<HTMLElement>(".editor-tab.active");
      if (!activeTab) return;
      const pinnedTab = this.strip.querySelector<HTMLElement>(".editor-tab.pinned-main-tab");
      const pinnedWidth = pinnedTab ? pinnedTab.offsetWidth : 0;

      const rect = activeTab.getBoundingClientRect();
      const stripRect = this.strip.getBoundingClientRect();
      const tabLeft = rect.left - stripRect.left + this.strip.scrollLeft;
      const tabRight = tabLeft + rect.width;

      const viewLeft = this.strip.scrollLeft + pinnedWidth;
      const viewRight = this.strip.scrollLeft + this.strip.clientWidth;

      if (tabLeft < viewLeft) {
        this.strip.scrollLeft = tabLeft - pinnedWidth;
      } else if (tabRight > viewRight) {
        this.strip.scrollLeft = tabRight - this.strip.clientWidth;
      }
    });
  }
}
