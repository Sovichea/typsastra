import { describe, expect, test } from "bun:test";
import { SystemResumeMonitor } from "../src/platform/systemResume";

describe("system resume monitoring", () => {
  test("ignores ordinary timer drift", () => {
    const recoveries: number[] = [];
    const monitor = new SystemResumeMonitor(ms => recoveries.push(ms), 10_000, 1_000);
    const baseline = Date.now();

    expect(monitor.observe(baseline + 1_050)).toBe(false);
    expect(recoveries).toEqual([]);
  });

  test("reports a clock gap caused by suspension", () => {
    const recoveries: number[] = [];
    const monitor = new SystemResumeMonitor(ms => recoveries.push(ms), 10_000, 1_000);
    const baseline = Date.now();
    monitor.observe(baseline + 1_000);

    expect(monitor.observe(baseline + 31_000)).toBe(true);
    expect(recoveries).toEqual([29_000]);
  });
});
