import { describe, expect, test } from "bun:test";
import { modalTabDestination } from "../src/ui/modalFocus";

describe("modal focus navigation", () => {
  test("cycles forward and backward without leaving the modal", () => {
    expect(modalTabDestination(0, 3, false)).toBe(1);
    expect(modalTabDestination(2, 3, false)).toBe(0);
    expect(modalTabDestination(2, 3, true)).toBe(1);
    expect(modalTabDestination(0, 3, true)).toBe(2);
  });

  test("enters the modal at the appropriate edge", () => {
    expect(modalTabDestination(-1, 3, false)).toBe(0);
    expect(modalTabDestination(-1, 3, true)).toBe(2);
    expect(modalTabDestination(-1, 0, false)).toBeNull();
  });
});
