import { describe, expect, test } from "bun:test";
import { releaseSummaryForVersion, shouldShowReleaseSummary } from "../src/releaseNotes";

describe("release summary", () => {
  test("registers release notes for the packaged application version", async () => {
    const manifest = await Bun.file(new URL("../package.json", import.meta.url)).json() as { version: string };
    const summary = releaseSummaryForVersion(manifest.version);
    expect(summary?.version).toBe(manifest.version);
    expect(summary?.detailsUrl).toContain(`/releases/tag/v${manifest.version}`);
  });

  test("shows a known release only once for that version", () => {
    expect(shouldShowReleaseSummary("0.5.1", null)).toBe(true);
    expect(shouldShowReleaseSummary("0.5.1", "0.5.0")).toBe(true);
    expect(shouldShowReleaseSummary("0.5.1", "0.5.1")).toBe(false);
  });

  test("does not show an empty summary for an unregistered version", () => {
    expect(releaseSummaryForVersion("9.9.9")).toBeNull();
    expect(shouldShowReleaseSummary("9.9.9", null)).toBe(false);
  });

  test("ships an accessible release-summary dialog", async () => {
    const html = await Bun.file(new URL("../index.html", import.meta.url)).text();
    expect(html).toContain('id="release-summary-overlay"');
    expect(html).toContain('aria-labelledby="release-summary-title"');
    expect(html).toContain('id="release-summary-details"');
  });
});
