import { describe, expect, test } from "bun:test";

describe("welcome project actions", () => {
  test("offers the same Typsastra project import entry point as the File menu", async () => {
    const html = await Bun.file(new URL("../index.html", import.meta.url)).text();
    expect(html).toContain('id="action-import-project"');
    expect(html).toContain('id="welcome-import-project"');
    expect(html).toContain("Import Typsastra Project");
    expect(html).toContain(".typsastra");
  });

  test("provides shared recent-project surfaces", async () => {
    const html = await Bun.file(new URL("../index.html", import.meta.url)).text();
    expect(html).toContain('id="welcome-recent-projects"');
    expect(html).toContain('id="recent-projects-submenu"');
    expect(html).toContain('id="recent-projects-overlay"');
    expect(html).toContain('id="recent-projects-search"');
  });

  test("keeps every getting-started action inside its welcome section", async () => {
    const html = await Bun.file(new URL("../index.html", import.meta.url)).text();
    const gettingStarted = html.slice(
      html.indexOf('<div class="welcome-section">'),
      html.indexOf('<div class="welcome-section" id="welcome-recent-projects">')
    );
    expect(gettingStarted).toContain('id="welcome-create-project"');
    expect(gettingStarted).toContain('id="welcome-open-project"');
    expect(gettingStarted).toContain('id="welcome-import-project"');
    expect(gettingStarted).toContain('id="welcome-open-examples"');
    expect(gettingStarted.match(/<button\b/g)).toHaveLength(4);
    expect(gettingStarted.match(/<\/button>/g)).toHaveLength(4);
  });

  test("shares the Create New Project shortcut with the File menu", async () => {
    const html = await Bun.file(new URL("../index.html", import.meta.url)).text();
    const bindings = await Bun.file(
      new URL("../src/ui/appEventBindings.ts", import.meta.url),
    ).text();

    expect(html).toContain('id="action-new-project"');
    expect(html.match(/data-shortcut="Mod\+Shift\+N"/g)).toHaveLength(2);
    expect(html).toContain('data-shortcut="Mod+Shift+N">Ctrl+Shift+N<');
    expect(bindings).toContain(
      'getElementById("action-new-project")?.addEventListener("click", () => void actions.createProjectFromTemplate());',
    );
  });

  test("exposes the create-new-project template browser", async () => {
    const html = await Bun.file(new URL("../index.html", import.meta.url)).text();
    expect(html).toContain('id="welcome-create-project"');
    expect(html).toContain('id="project-template-overlay"');
    expect(html).toContain('data-template-tab="all"');
    expect(html).toContain('data-template-tab="offline"');
    expect(html).toContain('data-template-tab="user"');
    expect(html).toContain('id="project-template-search"');
    expect(html).toContain('id="project-template-universe"');
    expect(html).toContain('id="project-template-refresh"');
    expect(html).toContain('id="project-template-add"');
    expect(html).toContain('id="project-template-list"');
    expect(html).toContain('id="project-template-name"');
    expect(html).toContain('id="project-template-location"');
  });
});
