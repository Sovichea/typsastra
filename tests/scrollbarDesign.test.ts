import { describe, expect, test } from "bun:test";

describe("cross-platform scrollbar design", () => {
  test("styles application scrollbars while preserving the hidden tab strip", async () => {
    const css = await Bun.file(new URL("../src/style.css", import.meta.url)).text();
    expect(css).toContain("--ui-scrollbar-thumb");
    expect(css).toContain("--ui-scrollbar-track: transparent");
    expect(css).toContain("*::-webkit-scrollbar");
    expect(css).toContain("border-radius: 0");
    expect(css).toContain("@supports not selector(::-webkit-scrollbar)");
    expect(css).toContain("scrollbar-color: var(--ui-scrollbar-thumb) var(--ui-scrollbar-track)");
    expect(css).toContain(".editor-tab-bar::-webkit-scrollbar");
    expect(css).toContain("scrollbar-width: none");
  });

  test("applies matching custom geometry inside the isolated PDF iframe", async () => {
    const source = await Bun.file(new URL("../src/preview/previewFrame.ts", import.meta.url)).text();
    expect(source).toMatch(/\*::\-webkit-scrollbar\{width:\d+px;height:\d+px\}/);
    expect(source).toContain("@supports not selector(::-webkit-scrollbar)");
    expect(source).toContain("scrollbar-color:var(--scrollbar-thumb) var(--scrollbar-track)");
    expect(source).toContain("border-radius:0");
    expect(source).toContain('copy("--ui-accent-color", "--preview-ui-accent"');
    expect(source).toContain("var(--preview-ui-accent)");
  });
});
