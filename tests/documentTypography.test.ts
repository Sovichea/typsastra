import { describe, expect, test } from "bun:test";
import { detectDocumentScript, parseTypographyBlock, renderTypographyBlock, typographyEdit } from "../src/editor/documentTypography";

describe("document typography", () => {
  const config = {
    latinFont: "Calibri",
    latinSizePt: 11,
    complexFont: "MiSans Khmer",
    complexScript: "khmer",
    complexSizeAdjustmentPt: -0.5
  };

  test("renders reliable Typst font rules", () => {
    expect(renderTypographyBlock(config)).toContain('#set text(font: "Calibri", size: 11pt)');
    expect(renderTypographyBlock(config)).toContain('#show regex("\\p{Khmer}+"): set text(font: "MiSans Khmer", size: 1em - 0.5pt)');
    expect(parseTypographyBlock(renderTypographyBlock(config))).toEqual(config);
  });

  test("supports independent Latin and complex-script rules", () => {
    const complexOnly = { ...config, latinFont: null };
    const complexBlock = renderTypographyBlock(complexOnly);
    expect(complexBlock).not.toContain("#set text(");
    expect(complexBlock).toContain('#show regex("\\p{Khmer}+")');
    expect(parseTypographyBlock(complexBlock)).toEqual({ ...complexOnly, latinSizePt: 11 });

    const latinOnly = { ...config, complexFont: null };
    const latinBlock = renderTypographyBlock(latinOnly);
    expect(latinBlock).toContain('#set text(font: "Calibri", size: 11pt)');
    expect(latinBlock).not.toContain("#show regex(");
    expect(parseTypographyBlock(latinBlock)).toEqual({
      ...latinOnly,
      complexScript: "khmer",
      complexSizeAdjustmentPt: 0
    });
  });

  test("supports disabling both Latin and complex-script rules", () => {
    const disabledBoth = { ...config, latinFont: null, complexFont: null };
    const disabledBlock = renderTypographyBlock(disabledBoth);
    expect(disabledBlock).not.toContain("#set text(");
    expect(disabledBlock).not.toContain("#show regex(");
    expect(parseTypographyBlock(disabledBlock)).toBeNull();
  });

  test("updates one managed block and preserves the preview directive", () => {
    const original = "// @standalone-preview\n= Chapter\n";
    const first = typographyEdit(original, config);
    const withBlock = original.slice(0, first.from) + first.insert + original.slice(first.to);
    expect(withBlock.startsWith("// @standalone-preview\n// typstry:typography:start")).toBe(true);

    const second = typographyEdit(withBlock, { ...config, latinFont: "MiSans Latin" });
    const updated = withBlock.slice(0, second.from) + second.insert + withBlock.slice(second.to);
    expect(updated.match(/typstry:typography:start/g)?.length).toBe(1);
    expect(updated).toContain('font: "MiSans Latin"');
  });

  test("detects the dominant complex script", () => {
    expect(detectDocumentScript("Latin ខ្មែរ ខ្មែរ")?.id).toBe("khmer");
    expect(detectDocumentScript("Latin only")).toBeNull();
  });
});
