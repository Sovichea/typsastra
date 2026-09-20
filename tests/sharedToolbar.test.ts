import { describe, expect, test } from "bun:test";

describe("shared toolbar", () => {
  test("builds toggles, selects, and dropdown menus behind one API", async () => {
    const source = await Bun.file(new URL("../src/ui/toolbar.ts", import.meta.url)).text();

    expect(source).toContain("export function createToolbar(");
    expect(source).toContain("export type ToolbarEntry");
    expect(source).toContain("export type ToolbarMenuEntry");
    expect(source).toContain('kind: "toggle"');
    expect(source).toContain('kind: "select"');
    expect(source).toContain('kind: "menu"');
    expect(source).toContain("setActive(id: string, active: boolean)");
    expect(source).toContain("setDisabled(id: string, disabled: boolean)");
    expect(source).toContain("setSelectValue(id: string, value: string)");
    expect(source).toContain("openMenuAt(");
    // Toolbar dropdowns stay open after a pick and rebuild their state, while
    // a context menu is a one-time action that closes.
    expect(source).toContain("entry.onSelect();");
    expect(source).toContain("afterSelect();");
    expect(source).toContain("showMenu({ left: rect.left, top: rect.bottom + 4 }, entry.entries, button, false);");
    expect(source).toContain("showMenu(position, entries, null, true);");
  });

  test("table editor consumes the shared toolbar with only its own entries", async () => {
    const source = await Bun.file(
      new URL("../src/components/tableTool.ts", import.meta.url),
    ).text();

    expect(source).toContain('from "../ui/toolbar"');
    expect(source).toContain("this.toolbar = createToolbar({");
    expect(source).toContain("this.toolbar?.setSelectValue(");
    expect(source).toContain("this.toolbar?.setActive(");
    expect(source).toContain("this.toolbar?.openMenuAt(");
    // The hand-rolled menu machinery now lives in the shared module.
    expect(source).not.toContain("private appendMenuItem(");
    expect(source).not.toContain("private openTableMenu(");
    expect(source).not.toContain("private refreshTableMenu(");
  });
});
