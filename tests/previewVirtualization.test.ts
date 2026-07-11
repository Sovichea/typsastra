import { describe, expect, test } from "bun:test";
import { pagesToEvict } from "../src/preview/virtualization";

describe("PDF preview virtualization", () => {
  test("keeps the focused page and its nearest neighbors resident", () => {
    const rendered = Array.from({ length: 20 }, (_, index) => index + 1);
    const evicted = new Set(pagesToEvict(rendered, 10, 7));
    const retained = rendered.filter(page => !evicted.has(page));
    expect(retained).toEqual([7, 8, 9, 10, 11, 12, 13]);
  });

  test("does not evict a visible window already under budget", () => {
    expect(pagesToEvict([4, 5, 6], 5, 7)).toEqual([]);
  });
});
