import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const style = readFileSync(new URL("../src/style.css", import.meta.url), "utf8");
const controller = readFileSync(new URL("../src/appController.ts", import.meta.url), "utf8");
const explorer = readFileSync(new URL("../src/components/explorer.ts", import.meta.url), "utf8");
const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const editorExtensions = readFileSync(new URL("../src/editor/extensions.ts", import.meta.url), "utf8");

describe("theme-aware application accents", () => {
  test("uses the shared UI typography for log-console actions", async () => {
    const css = await Bun.file(new URL("../src/style.css", import.meta.url)).text();
    const actions = css.slice(
      css.indexOf(".log-console-actions button"),
      css.indexOf(".log-console-actions button:hover")
    );
    expect(actions).toContain("font: 11px var(--font-family-sans)");
  });

  test("uses the active theme for the no-main-file placeholder", () => {
    expect(controller).toContain("preview-disabled-title preview-accent-title");
    expect(controller).not.toContain("color:#3db489");
    expect(style).toMatch(/\.preview-disabled-title\.preview-accent-title\s*\{[^}]*var\(--ui-accent-color\)/s);
  });

  test("uses shared accent variables for application controls", () => {
    expect(style).toContain("--ui-accent-foreground: var(--ui-bg)");
    expect(style).toContain("--ui-accent-hover: color-mix(");
    expect(html).toContain("background: var(--ui-accent-color)");
    expect(html).toContain("color: var(--ui-accent-foreground)");
    expect(explorer).toContain('input.style.border = "1px solid var(--ui-accent-color)"');
  });

  test("does not use the cursor color as a generic UI accent", () => {
    expect(style).not.toMatch(/\.log-console-tab\.active\s*\{[^}]*editor-cursor-color/s);
    expect(style).toMatch(/\.workspace-loading-spinner\s*\{[^}]*var\(--ui-accent-color\)/s);
  });

  test("draws pane focus indicators above opaque pane headers", () => {
    const focusRule = style.slice(
      style.indexOf(".workspace-explorer-section:focus-within"),
      style.indexOf(".tree-chevron", style.indexOf(".workspace-explorer-section:focus-within"))
    );
    expect(focusRule).toContain("outline: 1px solid color-mix(in srgb, var(--ui-accent-color) 42%, transparent)");
    expect(focusRule).toContain("outline-offset: -1px");
    expect(focusRule).not.toContain("box-shadow:");
  });

  test("keeps indentation guides visible across editor themes", () => {
    expect(editorExtensions).toContain('color-mix(in srgb, var(--ui-text) 38%, transparent)');
    expect(editorExtensions).toContain('color-mix(in srgb, var(--ui-accent-color) 72%, var(--ui-text))');
    expect(editorExtensions).toContain("activeThickness: 2");
    expect(controller).toContain("visibleIndentationMarkers()");
  });
});
