import { describe, expect, test } from "bun:test";
import { previewLinkModifierPressed, previewLinkTarget } from "../src/preview/previewLinks";

describe("PDF preview links", () => {
  test("recognizes external and internal PDF link annotations", () => {
    expect(previewLinkTarget({ subtype: "Link", url: "https://typst.app" })).toEqual({
      kind: "external",
      url: "https://typst.app"
    });
    expect(previewLinkTarget({ subtype: "Link", dest: "chapter-two" })).toEqual({
      kind: "destination",
      destination: "chapter-two"
    });
    expect(previewLinkTarget({ subtype: "Text", dest: "chapter-two" })).toBeNull();
  });

  test("uses the platform command modifier", () => {
    expect(previewLinkModifierPressed({ ctrlKey: true, metaKey: false })).toBeTrue();
    expect(previewLinkModifierPressed({ ctrlKey: false, metaKey: true })).toBeTrue();
    expect(previewLinkModifierPressed({ ctrlKey: false, metaKey: false })).toBeFalse();
  });
});
