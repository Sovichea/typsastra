import { describe, expect, test } from "bun:test";
import { resolveRuntimeTitlebar } from "../src/platform/runtimeTitlebar";

describe("runtime titlebar selection", () => {
  test("uses native traffic lights on macOS", () => {
    expect(resolveRuntimeTitlebar({ platform: "MacIntel" })).toEqual({
      mode: "native-macos",
      simulated: false,
    });
  });

  test("enables the macOS layout simulation only in development", () => {
    expect(resolveRuntimeTitlebar({
      platform: "Win32",
      search: "?test-platform=macos-titlebar",
      dev: true,
    })).toEqual({
      mode: "native-macos",
      simulated: true,
    });
  });

  test("does not allow the simulation flag in production", () => {
    expect(resolveRuntimeTitlebar({
      platform: "Win32",
      search: "?test-platform=macos-titlebar",
      dev: false,
    })).toEqual({
      mode: "custom",
      simulated: false,
    });
  });
});
