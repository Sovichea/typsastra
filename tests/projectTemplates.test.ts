import { describe, expect, test } from "bun:test";
import {
  TEMPLATE_TABS,
  UNIVERSE_TEMPLATES_URL,
  filterTemplates,
  findDownloadedTemplate,
  localTemplateKey,
  templateCatalogStatus,
  type LocalTemplate,
} from "../src/projectTemplates";

const templates = [
  { name: "charged-ieee", description: "IEEE paper", authors: ["Typst"], keywords: ["paper"] },
  { name: "basic-resume", description: "A clean resume", authors: ["Jane"], keywords: ["cv"] },
  { name: "ieee-report", description: "Report layout", authors: [], keywords: [] },
  { name: "paper-kit", description: "Generic kit", authors: [], keywords: [] },
];

describe("project template helpers", () => {
  test("links to the Typst Universe template search", () => {
    expect(UNIVERSE_TEMPLATES_URL).toBe("https://typst.app/universe/search/?kind=templates");
  });

  test("exposes the three template tabs", () => {
    expect(TEMPLATE_TABS.map(tab => tab.id)).toEqual(["all", "offline", "user"]);
  });

  test("returns every template for an empty query", () => {
    const result = filterTemplates(templates, "   ");
    expect(result).toHaveLength(4);
    expect(result).not.toBe(templates);
  });

  test("matches across name, description, authors, and keywords", () => {
    expect(filterTemplates(templates, "resume").map(item => item.name)).toEqual(["basic-resume"]);
    expect(filterTemplates(templates, "cv").map(item => item.name)).toEqual(["basic-resume"]);
    expect(filterTemplates(templates, "jane").map(item => item.name)).toEqual(["basic-resume"]);
    expect(filterTemplates(templates, "ieee").map(item => item.name).sort())
      .toEqual(["charged-ieee", "ieee-report"]);
  });

  test("ranks name matches before description matches", () => {
    // "paper-kit" matches by name; "charged-ieee" only by its description/keyword.
    const result = filterTemplates(templates, "paper");
    expect(result[0].name).toBe("paper-kit");
    expect(result).toContainEqual(expect.objectContaining({ name: "charged-ieee" }));
  });

  test("requires every term to match", () => {
    expect(filterTemplates(templates, "ieee paper").map(item => item.name)).toEqual(["charged-ieee"]);
    expect(filterTemplates(templates, "ieee nonexistent")).toEqual([]);
  });

  test("explains an offline catalog with a cache date", () => {
    const status = templateCatalogStatus({
      templates: [],
      cachedAt: 1_700_000_000,
      fromCache: true,
      offline: true,
    });
    expect(status).toContain("offline");
    expect(status).toContain("Downloaded templates still work");
  });

  test("stays quiet for a fresh online catalog", () => {
    expect(templateCatalogStatus({ templates: templates.map(() => ({} as never)), cachedAt: 1, fromCache: false, offline: false })).toBe("");
  });

  test("prompts to connect when nothing is cached", () => {
    const status = templateCatalogStatus({ templates: [], cachedAt: null, fromCache: true, offline: false });
    expect(status).toContain("Connect to the internet");
  });
});

describe("local template helpers", () => {
  const offline: LocalTemplate[] = [
    {
      id: "charged-ieee-0.1.4",
      name: "charged-ieee",
      version: "0.1.4",
      description: "",
      authors: [],
      categories: [],
      source: "universe",
      archive: "charged-ieee-0.1.4.typsastra",
      thumbnail: "charged-ieee-0.1.4.webp",
    },
  ];

  test("builds a stable key from source and id", () => {
    expect(localTemplateKey("user", "abc")).toBe("user:abc");
  });

  test("finds a downloaded template by name and version", () => {
    expect(findDownloadedTemplate(offline, "charged-ieee", "0.1.4")?.id).toBe("charged-ieee-0.1.4");
    expect(findDownloadedTemplate(offline, "charged-ieee", "9.9.9")).toBeNull();
  });
});
