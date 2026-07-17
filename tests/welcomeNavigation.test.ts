import { describe, expect, test } from "bun:test";
import { welcomeNavigationIndex } from "../src/workspace/welcomeNavigation";

describe("welcome keyboard navigation", () => {
  test("moves between getting-started and recent-project actions", () => {
    expect(welcomeNavigationIndex(0, 8, "ArrowDown")).toBe(1);
    expect(welcomeNavigationIndex(3, 8, "ArrowRight")).toBe(4);
    expect(welcomeNavigationIndex(5, 8, "ArrowUp")).toBe(4);
    expect(welcomeNavigationIndex(5, 8, "ArrowLeft")).toBe(4);
  });

  test("supports list edges and direct Home/End navigation", () => {
    expect(welcomeNavigationIndex(0, 8, "ArrowUp")).toBe(0);
    expect(welcomeNavigationIndex(7, 8, "ArrowDown")).toBe(7);
    expect(welcomeNavigationIndex(4, 8, "Home")).toBe(0);
    expect(welcomeNavigationIndex(4, 8, "End")).toBe(7);
    expect(welcomeNavigationIndex(0, 0, "ArrowDown")).toBeNull();
  });
});
