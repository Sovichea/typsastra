import { describe, expect, test } from "bun:test";
import { shortcutFor } from "../src/platform/shortcutRegistry";

const html = await Bun.file(new URL("../index.html", import.meta.url)).text();
const app = await Bun.file(new URL("../src/appController.ts", import.meta.url)).text();
const controller = await Bun.file(new URL("../src/search/projectSearchController.ts", import.meta.url)).text();
const worker = await Bun.file(new URL("../src/search/projectSearchWorker.ts", import.meta.url)).text();
const styles = await Bun.file(new URL("../src/style.css", import.meta.url)).text();

describe("project search sidebar", () => {
  test("adds Search to the activity bar and the Edit menu", () => {
    expect(html).toContain('id="sidebar-search-button"');
    expect(html).toContain('id="project-search-sidebar-content"');
    expect(html).toContain('id="project-search-input"');
    expect(html).toContain('id="project-search-mode"');
    expect(html).toContain('id="project-search-main-only" type="checkbox" checked');
    expect(html).toContain('id="project-search-results"');
    expect(html).toContain('id="action-search-project"');
    expect(html).toContain('id="action-replace-project"');
    expect(html).toContain('data-shortcut="Mod+Shift+F"');
    expect(html).toContain('data-shortcut="Mod+Shift+H"');
  });

  test("registers configurable Search Project and Replace in Project commands", () => {
    expect(shortcutFor("action-search-project", {}, false)).toBe("Mod-Shift-F");
    expect(shortcutFor("action-replace-project", {}, false)).toBe("Mod-Shift-H");
  });

  test("keeps filter checkboxes aligned with their labels", () => {
    expect(html).toContain('<label class="project-search-filter-field">Include globs');
    expect(html).toContain('<label class="project-search-toggle" title="Search only');
    expect(styles).toContain(".project-search-filter-field {");
    expect(styles).toContain(".project-search-filters .project-search-toggle { margin-top: 6px; }");
    expect(styles).toContain("justify-content: flex-start;");
    expect(styles).not.toContain(".project-search-filters label {");
  });

  test("opens search as a sidebar tool without replacing the editor or preview", () => {
    expect(app).toContain("private openProjectSearch(replace = false)");
    expect(app).toContain('this.sidebarController.setTool("search")');
    expect(app).toContain("new ProjectSearchController");
    expect(app).toContain("navigateToProjectSearchResult");
    expect(app).toContain("private readonly projectSearchController");
  });

  test("runs matching in a worker with debounce, caps, and regex watchdog", () => {
    expect(controller).toContain('new Worker(new URL("./projectSearchWorker.ts", import.meta.url)');
    expect(controller).toContain("PROJECT_SEARCH_DEBOUNCE_MS");
    expect(controller).toContain("PROJECT_SEARCH_MAX_RESULTS");
    expect(controller).toContain("PROJECT_SEARCH_REGEX_TIMEOUT_MS");
    expect(controller).toContain("startRegexWatchdog");
    expect(controller).toContain("textRevisionToken");
    expect(controller).toContain("mainDocumentOnly: this.mainDocumentOnlyCheckbox()?.checked ?? true");
    expect(controller).toContain("relatedFiles(mainPath)");
    expect(controller).toContain("for (const range of match.ranges)");
    expect(controller).toContain("anchor.from - 24");
    expect(controller).toContain("anchor.to + 36");
    expect(worker).toContain("matchProjectSearchFile");
    expect(worker).toContain('type: "file-result"');
    expect(worker).toContain('type: "done"');
  });
});
