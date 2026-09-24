import { describe, expect, test } from "bun:test";
import { clampCrop } from "../src/components/imageTools";

describe("image tool crop", () => {
  test("clamps crop rectangles to the source image bounds", () => {
    expect(clampCrop({ x: -5, y: -5, width: 200, height: 200 }, { width: 100, height: 50 }))
      .toEqual({ x: 0, y: 0, width: 100, height: 50 });
    expect(clampCrop({ x: 90, y: 40, width: 50, height: 50 }, { width: 100, height: 50 }))
      .toEqual({ x: 50, y: 0, width: 50, height: 50 });
    expect(clampCrop({ x: 10, y: 10, width: 0, height: 0 }, { width: 100, height: 50 }))
      .toEqual({ x: 10, y: 10, width: 1, height: 1 });
  });

  test("exposes crop controls in the Image Tools action pane", async () => {
    const source = await Bun.file(
      new URL("../src/components/imageTools.ts", import.meta.url),
    ).text();

    expect(source).toContain('data-action="crop-toggle"');
    expect(source).toContain('data-action="crop-reset"');
    expect(source).toContain('data-field="crop-x"');
    expect(source).toContain('data-field="crop-y"');
    expect(source).toContain('data-field="crop-w"');
    expect(source).toContain('data-field="crop-h"');
    expect(source).toContain("crop: this.effectiveCrop(image)");
    expect(source).toContain("this.cropOverlay.show(");
  });

  test("mounts the crop overlay on the interactive image viewer", async () => {
    const preview = await Bun.file(
      new URL("../src/preview/imagePreviewController.ts", import.meta.url),
    ).text();
    const controls = await Bun.file(
      new URL("../src/components/imageTools.ts", import.meta.url),
    ).text();
    const style = await Bun.file(new URL("../src/style.css", import.meta.url)).text();

    expect(preview).toContain("public showCropOverlay(");
    expect(preview).toContain("public clearCropOverlay(): void");
    expect(preview).toContain('overlay.id = "interactive-image-crop-overlay"');
    expect(preview).toContain("CROP_HANDLE_DIRECTIONS");
    expect(preview).toContain("image.getBoundingClientRect()");
    // Done keeps the selection as a non-interactive guide.
    expect(preview).toContain('overlay.classList.toggle("image-crop-overlay-locked", !interactive)');
    expect(preview).toContain("new MutationObserver(sync)");
    expect(controls).toContain("{ interactive: false }");
    expect(style).toContain(".image-crop-overlay-locked {");
  });

  test("keeps the saved replacement image selected when a concurrent refresh wins", async () => {
    const source = await Bun.file(
      new URL("../src/components/imageTools.ts", import.meta.url),
    ).text();

    // The workspace watcher can refresh the image list while the save is still
    // completing, discarding the save's preferred-path refresh. The pending
    // path lets whichever refresh wins still select the saved image.
    expect(source).toContain("private pendingPreferredImagePath: string | null = null;");
    expect(source).toContain("const preferred = preferredImagePath ?? this.pendingPreferredImagePath;");
    expect(source).toContain("if (preferred) this.pendingPreferredImagePath = null;");
    // The saved copy is selected whether or not static paths are replaced.
    expect(source).toContain("this.pendingPreferredImagePath = destination;");
    expect(source).toContain("await this.refresh(destination);");
    expect(source).toContain("this.pendingPreferredImagePath = replacementPath;");
    // A preferred image that is not indexed keeps the current selection.
    expect(source).toContain("const next = preferredNext ?? lookup(this.committed?.path);");
  });

  test("sends crop parameters to the native preview pipeline", async () => {
    const native = await Bun.file(new URL("../src-tauri/src/lib.rs", import.meta.url)).text();

    expect(native).toContain("struct ImageToolCrop {");
    expect(native).toContain("crop: Option<ImageToolCrop>");
    expect(native).toContain("decoded.crop_imm(crop.x, crop.y, crop.width, crop.height)");
    expect(native).toContain("Crop region {}x{} at ({}, {}) is outside the");
  });
});
