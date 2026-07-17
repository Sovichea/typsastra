import { describe, expect, test } from "bun:test";
import { filterRecentProjects, normalizeRecentProjects, recentProjectNavigationIndex, recentProjectShortcutIndex } from "../src/workspace/recentProjectsController";

describe("recent project shortcuts", () => {
  const event = (code: string, modifiers: Partial<KeyboardEvent> = {}) => ({
    code,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...modifiers
  }) as KeyboardEvent;

  test("maps command digits to the five visible recent-project slots", () => {
    expect(recentProjectShortcutIndex(event("Digit1", { ctrlKey: true }))).toBe(0);
    expect(recentProjectShortcutIndex(event("Digit5", { metaKey: true }))).toBe(4);
    expect(recentProjectShortcutIndex(event("Digit6", { ctrlKey: true }))).toBeNull();
    expect(recentProjectShortcutIndex(event("Digit1", { ctrlKey: true, shiftKey: true }))).toBeNull();
    expect(recentProjectShortcutIndex(event("Digit1"))).toBeNull();
  });

  test("stores at most 32 unique projects in recency order", () => {
    const projects = Array.from({ length: 40 }, (_, index) => `C:\\Work\\Project ${index}`);
    const normalized = normalizeRecentProjects([
      projects[0],
      "c:/work/project 0",
      ...projects.slice(1),
      "",
      null
    ]);

    expect(normalized).toHaveLength(32);
    expect(normalized[0]).toBe(projects[0]);
    expect(normalized[31]).toBe(projects[31]);
  });

  test("fuzzy-ranks recent projects by name before full path", () => {
    const projects = [
      "C:\\Archive\\Khmer Book Notes",
      "C:\\Research\\Khmer Book",
      "C:\\Clients\\Annual Report",
      "/home/writer/notes"
    ];

    expect(filterRecentProjects(projects, "kmrbk")).toEqual([projects[1], projects[0]]);
    expect(filterRecentProjects(projects, "CLIENTS")).toEqual([projects[2]]);
    expect(filterRecentProjects(projects, "annual rpt")).toEqual([projects[2]]);
    expect(filterRecentProjects(projects, "missing")).toEqual([]);
    expect(filterRecentProjects(projects, "  ")).toEqual(projects);
  });

  test("moves the fuzzy-result selection without leaving the list", () => {
    expect(recentProjectNavigationIndex(0, 4, "ArrowDown")).toBe(1);
    expect(recentProjectNavigationIndex(3, 4, "ArrowDown")).toBe(3);
    expect(recentProjectNavigationIndex(2, 4, "ArrowUp")).toBe(1);
    expect(recentProjectNavigationIndex(0, 4, "ArrowUp")).toBe(0);
    expect(recentProjectNavigationIndex(0, 0, "ArrowDown")).toBeNull();
  });
});
