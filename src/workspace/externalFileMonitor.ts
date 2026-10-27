/** Serial polling prevents a slow disk read from overlapping the next check. */
export class ExternalFileMonitor {
  private cancelTimer: (() => void) | null = null;
  private intervalMs = 1000;
  private stopped = true;
  private running = false;

  constructor(
    private readonly check: () => Promise<unknown>,
    private readonly onError: (error: unknown) => void,
    private readonly scheduleTimer: (callback: () => void, delayMs: number) => () => void = (callback, delayMs) => {
      const timer = setTimeout(callback, delayMs);
      return () => clearTimeout(timer);
    },
  ) {}

  configure(intervalSeconds: number): void {
    this.intervalMs = intervalSeconds * 1000;
    this.stopped = false;
    this.cancelTimer?.();
    this.cancelTimer = null;
    if (!this.running) this.schedule();
  }

  stop(): void {
    this.stopped = true;
    this.cancelTimer?.();
    this.cancelTimer = null;
  }

  private schedule(): void {
    if (this.stopped) return;
    this.cancelTimer = this.scheduleTimer(() => void this.tick(), this.intervalMs);
  }

  private async tick(): Promise<void> {
    this.cancelTimer = null;
    this.running = true;
    try {
      await this.check();
    } catch (error) {
      this.onError(error);
    } finally {
      this.running = false;
      this.schedule();
    }
  }
}
