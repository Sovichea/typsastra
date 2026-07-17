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
    expect(gettingStarted).toContain('id="welcome-open-project"');
    expect(gettingStarted).toContain('id="welcome-import-project"');
    expect(gettingStarted).toContain('id="welcome-open-examples"');
    expect(gettingStarted.match(/<button\b/g)).toHaveLength(3);
    expect(gettingStarted.match(/<\/button>/g)).toHaveLength(3);
  });
});
