import { describe, expect, test } from "bun:test";
import { ExternalFileMonitor } from "../src/workspace/externalFileMonitor";

function fixture(check: () => Promise<unknown>) {
  const timers: Array<{ callback: () => void; delay: number; cancelled: boolean }> = [];
  const errors: unknown[] = [];
  const monitor = new ExternalFileMonitor(check, error => errors.push(error), (callback, delay) => {
    const timer = { callback, delay, cancelled: false };
    timers.push(timer);
    return () => { timer.cancelled = true; };
  });
  return { monitor, timers, errors };
}

describe("external source polling", () => {
  test("uses the configured interval and never overlaps a slow check", async () => {
    let finish!: () => void;
    let calls = 0;
    const f = fixture(() => { calls++; return new Promise<void>(resolve => { finish = resolve; }); });
    f.monitor.configure(1);
    expect(f.timers[0].delay).toBe(1000);
    f.timers[0].callback();
    expect(calls).toBe(1);
    expect(f.timers).toHaveLength(1);
    f.monitor.configure(2);
    expect(f.timers).toHaveLength(1);
    finish();
    await Promise.resolve();
    expect(f.timers).toHaveLength(2);
    expect(f.timers[1].delay).toBe(2000);
    f.monitor.stop();
    expect(f.timers[1].cancelled).toBe(true);
  });

  test("changing the interval replaces the waiting timer", () => {
    const f = fixture(async () => {});
    f.monitor.configure(1);
    f.monitor.configure(0.5);
    expect(f.timers[0].cancelled).toBe(true);
    expect(f.timers[1].delay).toBe(500);
    f.monitor.stop();
  });

  test("stopping during a read prevents another poll", async () => {
    let finish!: () => void;
    const f = fixture(() => new Promise<void>(resolve => { finish = resolve; }));
    f.monitor.configure(1);
    f.timers[0].callback();
    f.monitor.stop();
    finish();
    await Promise.resolve();
    expect(f.timers).toHaveLength(1);
  });

  test("a failed read is reported and the next check is still scheduled", async () => {
    const failure = new Error("unavailable");
    const f = fixture(async () => { throw failure; });
    f.monitor.configure(1);
    f.timers[0].callback();
    await Promise.resolve();
    expect(f.errors).toEqual([failure]);
    expect(f.timers).toHaveLength(2);
    f.monitor.stop();
  });
});
