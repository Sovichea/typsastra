import { describe, expect, test } from "bun:test";
import { allowsStandalonePreview, previewRefreshStyle, previewSessionIdentity } from "../src/preview/previewPolicy";

describe("preview policy", () => {
  test("only accepts the directive on the first line", () => {
    expect(allowsStandalonePreview("// @standalone-preview\n= Chapter")).toBe(true);
    expect(allowsStandalonePreview("\uFEFF// @standalone-preview\n= Chapter")).toBe(true);
    expect(allowsStandalonePreview("//@standalone-preview\n= Chapter")).toBe(true);
    expect(allowsStandalonePreview("\n// @standalone-preview\n= Chapter")).toBe(false);
    expect(allowsStandalonePreview("// @allow-preview\n= Legacy chapter")).toBe(false);
  });

  test("uses the selected refresh mode independently of preview roots", () => {
    expect(previewRefreshStyle("on-save")).toBe("on-save");
    expect(previewRefreshStyle("on-type")).toBe("on-type");
  });

  test("creates stable distinct task IDs for each refresh policy", () => {
    const live = previewSessionIdentity("C:\\docs\\main.typ", "on-type");
    const saved = previewSessionIdentity("C:\\docs\\main.typ", "on-save");
    expect(live).toEqual(previewSessionIdentity("C:\\docs\\main.typ", "on-type"));
    expect(live.taskId).not.toBe(saved.taskId);
  });
});
