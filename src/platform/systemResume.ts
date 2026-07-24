const DEFAULT_RESUME_GAP_MS = 10_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;

export class SystemResumeMonitor {
  private lastObservedAt = Date.now();
  private timer: number | null = null;
  private readonly observeFocus = () => {
    this.observe();
  };

  public constructor(
    private readonly onResume: (suspendedMs: number) => void,
    private readonly resumeGapMs = DEFAULT_RESUME_GAP_MS,
    private readonly pollIntervalMs = DEFAULT_POLL_INTERVAL_MS
  ) {}

  public start(): void {
    if (this.timer !== null) return;
    this.lastObservedAt = Date.now();
    this.timer = window.setInterval(() => this.observe(), this.pollIntervalMs);
    window.addEventListener("focus", this.observeFocus);
  }

  public stop(): void {
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
    window.removeEventListener("focus", this.observeFocus);
  }

  public observe = (observedAt = Date.now()): boolean => {
    const elapsed = observedAt - this.lastObservedAt;
    this.lastObservedAt = observedAt;
    const suspendedMs = elapsed - this.pollIntervalMs;
    if (suspendedMs < this.resumeGapMs) return false;
    this.onResume(suspendedMs);
    return true;
  };
}
