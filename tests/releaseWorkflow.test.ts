import { describe, expect, test } from "bun:test";

describe("release workflow publishing", () => {
  test("cancels overlapping runs for a tag without serializing platform builds", async () => {
    const workflow = await Bun.file(new URL("../.github/workflows/release.yml", import.meta.url)).text();

    expect(workflow).toContain("group: release-${{ github.event.inputs.release_tag || github.ref_name }}");
    expect(workflow).toContain("cancel-in-progress: true");
    expect(workflow).not.toContain("max-parallel: 1");
    expect(workflow).toContain("uses: tauri-apps/tauri-action@v0");
  });

  test("runs normal CI and contributor contracts before platform builds", async () => {
    const workflow = await Bun.file(new URL("../.github/workflows/release.yml", import.meta.url)).text();
    const ci = await Bun.file(new URL("../.github/workflows/ci.yml", import.meta.url)).text();
    const contracts = await Bun.file(
      new URL("../.github/workflows/contributor-contracts.yml", import.meta.url),
    ).text();

    expect(workflow).toContain("preflight-ci:");
    expect(workflow).toContain("uses: ./.github/workflows/ci.yml");
    expect(workflow).toContain("preflight-conformance:");
    expect(workflow).toContain("uses: ./.github/workflows/contributor-contracts.yml");
    expect(workflow).toContain("needs: [preflight-ci, preflight-conformance]");
    expect(ci).toContain("workflow_call:");
    expect(ci).toContain("ref: ${{ inputs.ref || github.ref }}");
    expect(contracts).toContain("workflow_call:");
    expect(contracts).toContain("ref: ${{ inputs.ref || github.ref }}");
  });

  test("rebuilds AppImage staging and verifies launcher permissions", async () => {
    const workflow = await Bun.file(new URL("../.github/workflows/release.yml", import.meta.url)).text();
    const packageJson = await Bun.file(new URL("../package.json", import.meta.url)).json() as {
      devDependencies?: Record<string, string>;
    };

    expect(packageJson.devDependencies?.["@tauri-apps/cli"]).toBe("~2.12.4");
    expect(workflow).toContain("Reset Linux AppImage Staging");
    expect(workflow).toContain("rm -rf src-tauri/target/release/bundle/appimage");
    expect(workflow).toContain("for entry in AppRun AppRun.wrapped; do");
    expect(workflow).toContain('${mode: -1}');
  });
});
