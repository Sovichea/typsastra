import { describe, expect, test } from "bun:test";
import { modalTabDestination } from "../src/ui/modalFocus";
import { dialogActionSlots } from "../src/ui/appDialog";

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

  test("lays out one, two, and three application-dialog actions consistently", () => {
    expect(dialogActionSlots(1)).toEqual([2]);
    expect(dialogActionSlots(2)).toEqual([0, 2]);
    expect(dialogActionSlots(3)).toEqual([0, 1, 2]);
  });

  test("ships document typography as an accessible dialog", async () => {
    const html = await Bun.file(new URL("../index.html", import.meta.url)).text();
    expect(html).toContain('id="toolbar-document-typography"');
    expect(html).toContain('aria-controls="document-typography-overlay"');
    expect(html).toContain('id="document-typography-overlay"');
    expect(html).toContain('aria-labelledby="document-typography-title"');
    expect(html).toContain('id="toolbar-typography-apply"');
    expect(html).toContain('id="document-typography-order-status"');
    const source = await Bun.file(new URL("../src/editor/toolbarController.ts", import.meta.url)).text();
    expect(source).toContain('data-typography-drag-handle');
    expect(source).toContain('event.key === "ArrowUp"');
    expect(source).toContain('window.addEventListener("pointermove", this.onTypographyPointerMove');
    expect(source).toContain('dragHandle.setAttribute("draggable", "false")');
    expect(source).toContain('dragHandle.addEventListener("dragstart", event => event.preventDefault())');
  });
});
