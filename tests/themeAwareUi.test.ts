import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const style = readFileSync(new URL("../src/style.css", import.meta.url), "utf8");
const controller = readFileSync(new URL("../src/appController.ts", import.meta.url), "utf8");
const previewWindowController = readFileSync(new URL("../src/preview/previewWindowController.ts", import.meta.url), "utf8");
const settingsRuntimeController = readFileSync(new URL("../src/settingsRuntimeController.ts", import.meta.url), "utf8");
const explorer = readFileSync(new URL("../src/components/explorer.ts", import.meta.url), "utf8");
const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const editorExtensions = readFileSync(new URL("../src/editor/extensions.ts", import.meta.url), "utf8");
const editorThemes = readFileSync(new URL("../src/editor/themes.ts", import.meta.url), "utf8");
const icons = readFileSync(new URL("../src/ui/icons.ts", import.meta.url), "utf8");
const settingsController = readFileSync(new URL("../src/settingsController.ts", import.meta.url), "utf8");

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

  test("shows only Settings in the welcome status bar and scopes render mode to projects", () => {
    expect(style).toMatch(
      /#status-bar\.welcome-screen-active > \*\s*\{[^}]*display:\s*none;[^}]*\}/s
    );
    expect(style).toMatch(
      /#status-bar\.welcome-screen-active > #settings-status-button\s*\{[^}]*display:\s*inline-flex;[^}]*\}/s
    );
    expect(settingsController).toContain(
      "previewRenderMode.disabled = preview.lowMemoryMode || this.workspacePreviewRenderMode === null"
    );
    expect(settingsController).toContain("Low memory mode limits preview rendering to explicit saves.");
    expect(settingsController).toContain(
      "Open a project to configure its preview render mode."
    );
  });

  test("uses the Typsastra textmark wording on the welcome screen", () => {
    expect(html).toContain("<h1>Typsastra</h1>");
    expect(html).toContain(
      'WRITE <span aria-hidden="true">•</span> COMPOSE <span aria-hidden="true">•</span> PUBLISH'
    );
    expect(html).not.toContain("The editor for what's next");
    expect(style).toMatch(
      /\.welcome-title-container p\s*\{[^}]*letter-spacing:\s*0\.2em;[^}]*color:\s*var\(--ui-accent-color\);/s
    );
  });

  test("uses shared accent variables for application controls", () => {
    expect(style).toContain("--ui-accent-foreground: var(--ui-bg)");
    expect(style).toContain("--ui-accent-hover: color-mix(");
    expect(html).toContain("background: var(--ui-accent-color)");
    expect(html).toContain("color: var(--ui-accent-foreground)");
    expect(explorer).toContain('input.style.border = "1px solid var(--ui-accent-color)"');
  });

  test("keeps compiler source snippets intact while containing horizontal scrolling", () => {
    expect(style).toMatch(
      /\.compiler-preview-error-content\s*\{[^}]*min-width:\s*0;[^}]*overflow-x:\s*hidden;[^}]*overflow-y:\s*auto;/s
    );
    expect(style).toMatch(/\.compiler-preview-diagnostic-snippet,[\s\S]*?white-space:\s*pre;[\s\S]*?overflow-x:\s*auto;/);
    expect(style).toContain(".compiler-preview-diagnostic-secondary");
    expect(style).toContain(".compiler-preview-diagnostic-raw");
  });

  test("applies and follows the active theme in the undocked preview", () => {
    expect(previewWindowController).toContain("await deps.loadSettings()");
    expect(previewWindowController).toContain("await applyUIThemeVariables(deps.theme())");
    expect(previewWindowController).toContain('await listen<ThemeName>("preview-theme-update"');
    expect(settingsRuntimeController).toContain('emit("preview-theme-update", appearance.theme)');
  });

  test("keeps warning icons consistent across themes and surfaces", () => {
    expect(style).toContain("--ui-warning-icon-color: #cca700;");
    expect(style).toMatch(/\.preview-image-warning-button\s*\{[\s\S]*?color:\s*var\(--ui-warning-icon-color\)/);
    expect(style).toMatch(/\.log-entry-warning \.log-entry-icon\s*\{[\s\S]*?color:\s*var\(--ui-warning-icon-color\)/);
    expect(style).toMatch(/\.cm-image-optimization-marker\s*\{[\s\S]*?color:\s*var\(--ui-warning-icon-color\)/);
    expect(style).toMatch(/\.settings-nav-warning\s*\{[\s\S]*?color:\s*var\(--ui-warning-icon-color\)/);
    expect(icons).toContain('replaceContents("#settings-storage-warning", "triangleAlert", 18)');
    expect(html).not.toMatch(/id="settings-storage-warning"[\s\S]*?>!<\/span>/);
  });

  test("uses a dedicated leftmost gutter for editor warnings", () => {
    const warnings = readFileSync(new URL("../src/editor/imageWarnings.ts", import.meta.url), "utf8");
    expect(editorExtensions.indexOf("imageOptimizationWarningsExtension")).toBeLessThan(
      editorExtensions.indexOf("lineNumbersCompartment.of(lineNumbers())")
    );
    expect(warnings).toContain('class: "cm-warningGutter"');
    expect(warnings).toContain("initialSpacer:");
    expect(warnings).not.toContain("lineNumberMarkers");
    expect(style).toMatch(/\.cm-warningGutter\s*\{[^}]*width:\s*28px[^}]*min-width:\s*28px/s);
    expect(style).toMatch(
      /\.cm-warningGutter \.cm-gutterElement\s*\{[^}]*width:\s*28px[^}]*padding:\s*0 5px/s
    );
    expect(style).toMatch(
      /\.cm-warningGutter \.cm-gutterElement\s*\{[^}]*align-items:\s*flex-start/s
    );
    expect(style).toMatch(
      /\.cm-warningGutter \.cm-lsp-error-marker\s*\{[^}]*height:\s*18px[^}]*margin-top:/s
    );
    expect(editorThemes).toMatch(
      /\.cm-foldGutter \.cm-gutterElement"[\s\S]*?width:\s*"28px"[\s\S]*?padding:\s*"0 5px !important"/
    );
    expect(editorThemes).toMatch(
      /\.cm-foldGutter \.cm-gutterElement > span"[\s\S]*?width:\s*"18px"[\s\S]*?height:\s*"18px"/
    );
  });

  test("uses color rather than font weight for active navigation state", () => {
    expect(editorThemes).toMatch(
      /\.cm-lineNumbers \.cm-activeLineGutter[\s\S]*?fontWeight:\s*"400 !important"/
    );
    expect(style).toMatch(/\.editor-tab\.active\s*\{[^}]*font-weight:\s*400/s);
    expect(style).toMatch(/\.tree-item\.pinned-main\s*\{[^}]*font-weight:\s*400/s);
    expect(style).toMatch(
      /\.editor-tab\.pinned-main-tab \.editor-tab-title\s*\{[^}]*font-weight:\s*400/s
    );
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
    expect(editorExtensions).toContain('color-mix(in srgb, var(--ui-accent-color) 58%, var(--ui-text))');
    expect(editorExtensions).toContain("activeThickness: 1");
    expect(editorExtensions).toContain("var(--ui-accent-color) 58%");
    expect(editorExtensions).toContain('"--ui-search-match-background"');
    expect(editorExtensions).toContain('${colors.brackets[3]} 30%, ${colors.bg}');
    expect(controller).toContain("visibleIndentationMarkers()");
    expect(editorThemes).toContain('".cm-indent-markers::before"');
    expect(editorThemes).toContain('left: "calc(13px - 0.7ch) !important"');
    expect(editorThemes).toContain('zIndex: "0 !important"');
  });

  test("keeps the caret distinct from matching bracket highlights", () => {
    const caret = editorThemes.slice(
      editorThemes.indexOf('".cm-cursor, .cm-dropCursor"'),
      editorThemes.indexOf('".cm-cursor::before, .cm-dropCursor::before"')
    );
    const brackets = editorThemes.slice(
      editorThemes.indexOf('".cm-matchingBracket"'),
      editorThemes.indexOf('".cm-nonmatchingBracket"')
    );

    expect(caret).toContain('borderLeftWidth: "0 !important"');
    expect(caret).toContain('zIndex: "200 !important"');
    expect(caret).not.toContain("height:");
    expect(caret).not.toContain("transform:");
    expect(editorThemes).toContain('".cm-cursor::before, .cm-dropCursor::before"');
    expect(editorThemes).toContain('height: "var(--editor-line-height-px, 23.8px)"');
    expect(editorThemes).toContain('transform: "translateY(-50%)"');
    expect(editorThemes).toContain(
      '"&.cm-has-selection .cm-activeLine, &.cm-has-selection .cm-activeLineGutter"',
    );
    expect(editorThemes).not.toContain(
      '".cm-activeLine.cm-indent-markers::before"',
    );
    expect(editorExtensions).toContain('EditorView.editorAttributes.compute(["selection"]');
    expect(editorExtensions).toContain('"cm-has-selection"');
    expect(editorExtensions).not.toContain('"typsastra-text-selection"');
    expect(editorThemes).toContain(
      '"& .cm-selectionLayer .cm-selectionBackground"',
    );
    expect(editorThemes).toContain(
      '"&.cm-focused .cm-selectionLayer .cm-selectionBackground"',
    );
    expect(editorThemes).toContain(
      'backgroundColor: "var(--ui-word-selection-focus-background, rgba(3, 102, 214, 0.52)) !important"',
    );
    const selectionLayerTheme = editorThemes.slice(
      editorThemes.indexOf('"& .cm-selectionLayer .cm-selectionBackground"'),
      editorThemes.indexOf('"& .cm-content .cm-line::selection'),
    );
    expect(selectionLayerTheme).toContain(
      'backgroundColor: "var(--ui-word-selection-background, rgba(3, 102, 214, 0.4)) !important"',
    );
    expect(selectionLayerTheme).not.toContain("::before");
    expect(selectionLayerTheme).not.toContain("translateY(-50%)");
    expect(editorThemes).not.toContain(".cm-content ::selection");
    expect(editorThemes).not.toContain("ui-word-selection-outline");
    expect(editorThemes).not.toContain('".typsastra-text-selection::before"');
    expect(brackets).toContain('backgroundColor: "transparent !important"');
    expect(brackets).toContain('boxShadow: "none !important"');
    expect(brackets).toContain('outline: "none !important"');
    expect(editorThemes).toContain('".cm-matchingBracket::before"');
    expect(editorThemes).toContain(
      'backgroundColor: "color-mix(in srgb, var(--editor-bracket-match-outline, #005cc5) 16%, transparent)"',
    );
    expect(brackets).not.toContain("inset 0 -2px");
    expect(brackets).not.toContain("1px solid");
  });
});
