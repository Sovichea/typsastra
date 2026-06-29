export class TabStripController {
  private readonly resizeObserver = new ResizeObserver(() => this.scheduleUpdate());
  private readonly mutationObserver = new MutationObserver(() => this.scheduleUpdate(true));
  private updateFrame: number | null = null;

  constructor(
    private readonly strip: HTMLElement,
    private readonly previousButton: HTMLButtonElement,
    private readonly nextButton: HTMLButtonElement
  ) {}

  public initialize(): void {
    this.previousButton.addEventListener("click", () => this.scroll(-1));
    this.nextButton.addEventListener("click", () => this.scroll(1));
    this.strip.addEventListener("scroll", () => this.scheduleUpdate(), { passive: true });
    this.resizeObserver.observe(this.strip);
    this.mutationObserver.observe(this.strip, { childList: true });
    this.scheduleUpdate();
  }

  private scroll(direction: -1 | 1): void {
    this.strip.scrollBy({
      left: direction * Math.max(160, this.strip.clientWidth * 0.65),
      behavior: "smooth"
    });
  }

  private scheduleUpdate(revealActive = false): void {
    if (this.updateFrame !== null) cancelAnimationFrame(this.updateFrame);
    this.updateFrame = requestAnimationFrame(() => {
      this.updateFrame = null;
      if (revealActive) {
        this.strip.querySelector<HTMLElement>(".editor-tab.active")?.scrollIntoView({
          block: "nearest",
          inline: "nearest"
        });
      }
      const maxScroll = Math.max(0, this.strip.scrollWidth - this.strip.clientWidth);
      const overflowing = maxScroll > 1;
      this.previousButton.classList.toggle("hidden", !overflowing);
      this.nextButton.classList.toggle("hidden", !overflowing);
      this.previousButton.disabled = !overflowing || this.strip.scrollLeft <= 1;
      this.nextButton.disabled = !overflowing || this.strip.scrollLeft >= maxScroll - 1;
    });
  }
}
