import { describe, expect, test } from "bun:test";
import { tauriArgumentsFor } from "../scripts/run-tauri-with-fallback";

describe("toolchain startup", () => {
  test("shows a titlebar setup badge instead of a blocking startup modal", async () => {
    const html = await Bun.file(new URL("../index.html", import.meta.url)).text();
    expect(html).toContain('id="toolchain-required-badge"');
    expect(html).toContain("Tinymist required");
    const controller = await Bun.file(new URL("../src/appController.ts", import.meta.url)).text();
    expect(controller).not.toContain("showToolchainSetupDialog");
    expect(controller).toContain("openToolchainSettings");
  });

  test("adds the fresh app-data config for dev runs", () => {
    expect(tauriArgumentsFor("dev", ["--config", "src-tauri/tauri.dev.conf.json", "--fresh"]))
      .toEqual([
        "dev",
        "--config",
        "src-tauri/tauri.dev.conf.json",
        "--config",
        "src-tauri/tauri.fresh.conf.json",
      ]);
  });

  test("leaves ordinary dev arguments unchanged", () => {
    expect(tauriArgumentsFor("dev", ["--config", "src-tauri/tauri.dev.conf.json"]))
      .toEqual(["dev", "--config", "src-tauri/tauri.dev.conf.json"]);
  });
});
