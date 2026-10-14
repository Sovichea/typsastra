import { describe, expect, test } from "bun:test";

describe("release workflow publishing", () => {
  test("serializes draft release asset updates and cancels stale tag runs", async () => {
    const workflow = await Bun.file(new URL("../.github/workflows/release.yml", import.meta.url)).text();

    expect(workflow).toContain("group: release-${{ github.event.inputs.release_tag || github.ref_name }}");
    expect(workflow).toContain("cancel-in-progress: true");
    expect(workflow).toContain("max-parallel: 1");
    expect(workflow).toContain("uses: tauri-apps/tauri-action@v0");
  });
});
