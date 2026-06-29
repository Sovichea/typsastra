import { describe, expect, test } from "bun:test";
import {
  codeEditorFonts,
  codeEditorFontStack,
  detectUnicodeEditorFont,
  unicodeEditorFonts
} from "../src/editor/fontCatalog";

describe("editor font catalog", () => {
  test("defaults to bundled Fira Mono and contains no UI fonts", () => {
    expect(codeEditorFonts[0].id).toBe("Fira Mono");
    expect(codeEditorFonts.every(font => font.fontFamily !== "MiSans Latin")).toBe(true);
    expect(codeEditorFontStack("fira-mono").startsWith('"Fira Mono"')).toBe(true);
  });

  test("recommends registered Unicode fonts for matching scripts", () => {
    expect(detectUnicodeEditorFont("\u1780\u17D2\u1798\u17C2\u179A")?.id).toBe("mi-sans-khmer");
    expect(detectUnicodeEditorFont("\u0395\u03BB\u03BB\u03B7\u03BD\u03B9\u03BA\u03AC")?.id).toBe("mi-sans-latin");
    expect(detectUnicodeEditorFont("\u041A\u0438\u0440\u0438\u043B\u043B\u0438\u0446\u0430")?.id).toBe("mi-sans-latin");
    expect(detectUnicodeEditorFont("\u0627\u0644\u0639\u0631\u0628\u064A\u0629")?.id).toBe("mi-sans-arabic");
    expect(detectUnicodeEditorFont("\u0E44\u0E17\u0E22")?.id).toBe("mi-sans-thai");
    expect(detectUnicodeEditorFont("fran\u00E7ais")).toBeNull();
    expect(unicodeEditorFonts.find(font => font.id === "mi-sans-khmer")?.bundled).toBe(false);
    expect(unicodeEditorFonts.find(font => font.id === "mi-sans-latin")?.bundled).toBe(true);
  });

  test("places an explicit Unicode fallback after the selected code font", () => {
    expect(codeEditorFontStack("Fira Mono", "MiSans Khmer").startsWith('"Fira Mono", "MiSans Khmer"')).toBe(true);
  });

  test("recommends Noto Sans when MiSans has no matching script family", () => {
    expect(detectUnicodeEditorFont("\u65E5\u672C\u8A9E\u30AB\u30CA")?.id).toBe("noto-sans-jp");
    expect(detectUnicodeEditorFont("\uD55C\uAE00")?.id).toBe("noto-sans-kr");
    expect(detectUnicodeEditorFont("\u05E2\u05D1\u05E8\u05D9\u05EA")?.id).toBe("noto-sans-hebrew");
  });
});
