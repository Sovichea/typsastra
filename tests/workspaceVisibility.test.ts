import { describe, expect, test } from "bun:test";
import { workspaceViewportState } from "../src/workspace/workspaceVisibility";

describe("workspace viewport visibility", () => {
  test("shows welcome only after the project and active file are both cleared", () => {
    expect(workspaceViewportState(null, null)).toEqual({
      showWelcome: true,
      showEditor: false,
      showWorkspaceChrome: false
    });
  });

  test("does not show an empty editor for a workspace without an active tab", () => {
    expect(workspaceViewportState(null, "C:/project")).toEqual({
      showWelcome: false,
      showEditor: false,
      showWorkspaceChrome: true
    });
  });

  test("shows the editor for an active project file", () => {
    expect(workspaceViewportState("C:/project/main.typ", "C:/project")).toEqual({
      showWelcome: false,
      showEditor: true,
      showWorkspaceChrome: true
    });
  });
});
