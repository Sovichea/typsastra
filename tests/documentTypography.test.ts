import { describe, expect, test } from "bun:test";
import {
  detectDocumentScript,
  detectDocumentScripts,
  detectTypographyScripts,
  documentLanguagesEdit,
  isTypstInternalOnlyFont,
  parseDocumentLanguages,
  parseDocumentScripts,
  parseTypographyBlock,
  renderTypographyBlock,
  typographyEdit,
  typographyScaleChange,
  typographyScaleExceedsFineAdjustment,
  TYPST_INTERNAL_FONT_FAMILIES,
  unsupportedTypstInternalFontScales,
} from "../src/editor/documentTypography";

const config = {
  baseSizePt: 11,
  fonts: [
    { family: "Calibri", script: "latin", scale: 1, language: "en-US" },
    { family: "MiSans Khmer 105", script: "khmer", scale: 1, language: "km" },
    { family: "MiSans Lao", script: "lao", scale: 1, language: null },
  ],
};

function apply(text: string, edit: { from: number; to: number; insert: string }): string {
  return text.slice(0, edit.from) + edit.insert + text.slice(edit.to);
}

describe("document typography", () => {
  test("distinguishes compiler-only fonts from locally installed copies", () => {
    expect(TYPST_INTERNAL_FONT_FAMILIES).toContain("New Computer Modern");
    expect(isTypstInternalOnlyFont("New Computer Modern", ["Arial"])).toBe(true);
    expect(isTypstInternalOnlyFont("New Computer Modern", ["New Computer Modern"])).toBe(false);
  });

  test("keeps legacy scale validation available for migration", () => {
    const fonts = [
      { family: "New Computer Modern", script: "latin", scale: 1.05, language: "en-US" },
      { family: "MiSans Khmer", script: "khmer", scale: 0.95, language: "km" },
    ];
    expect(unsupportedTypstInternalFontScales(fonts, ["MiSans Khmer"])).toEqual([fonts[0]]);
    expect(typographyScaleChange(1, 1.2)).toBe("confirm");
    expect(typographyScaleExceedsFineAdjustment(1.11)).toBe(true);
  });

  test("writes portable Typst plus language-only metadata", () => {
    const source = renderTypographyBlock(config);
    expect(source).toContain('// typsastra:document-languages [{"script":"latin","language":"en-US"},{"script":"khmer","language":"km"}]');
    expect(source).toContain('    "Calibri",');
    expect(source).toContain('    "MiSans Khmer 105",');
    expect(source).not.toContain("document-scripts");
    expect(source).not.toContain("typography:start");
    expect(source).not.toContain("scale");
    expect(source).not.toContain("covers:");
  });

  test("reads ordinary set-text values and language routing", () => {
    const parsed = parseTypographyBlock(renderTypographyBlock(config));
    expect(parsed?.baseSizePt).toBe(11);
    expect(parsed?.fonts.map(font => font.family)).toEqual(["Calibri", "MiSans Khmer 105", "MiSans Lao"]);
    expect(parsed?.fonts[0]?.language).toBe("en-US");
    expect(parsed?.fonts[1]?.language).toBe("km");
    expect(parsed?.fonts.every(font => font.scale === 1)).toBe(true);
  });

  test("updates language metadata without rewriting Typst content", () => {
    const source = '#set text(font: "Calibri")\n= Article\n';
    const updated = apply(source, documentLanguagesEdit(source, [
      { script: "latin", language: "fr-FR" },
      { script: "khmer", language: null },
    ]));
    expect(updated).toStartWith('// typsastra:document-languages [{"script":"latin","language":"fr-FR"}]\n');
    expect(updated).toEndWith(source);
    expect(parseDocumentLanguages(updated)).toEqual([{ script: "latin", language: "fr-FR" }]);
  });

  test("preserves unrelated text arguments", () => {
    const source = '#set text(font: "Old", size: 9pt, fill: red, tracking: 0.2pt)\n= Article\n';
    const updated = apply(source, typographyEdit(source, config));
    expect(updated).toContain("fill: red");
    expect(updated).toContain("tracking: 0.2pt");
    expect(updated).toContain("size: 11pt");
    expect(updated).toContain('"MiSans Khmer 105"');
  });

  test("guards ambiguous multiple document text rules", () => {
    const source = '#set text(font: "A")\n#set text(size: 12pt)\n';
    expect(() => typographyEdit(source, config)).toThrow("multiple #set text rules");
  });

  test("migrates legacy managed metadata to the portable form", () => {
    const legacy = [
      "// typsastra:typography:start",
      '// typsastra:document-scripts [{"family":"Calibri","script":"latin","scale":1,"language":"en-US"},{"family":"MiSans Khmer","script":"khmer","scale":1.05,"language":"km"}]',
      '#set text(font: ("Calibri", "MiSans Khmer"), size: 10pt)',
      "// typsastra:typography:end",
      "= Article",
    ].join("\n");
    const parsed = parseTypographyBlock(legacy)!;
    const updated = apply(legacy, typographyEdit(legacy, {
      baseSizePt: parsed.baseSizePt,
      fonts: parsed.fonts.map(font => ({ ...font, family: font.scale === 1 ? font.family : `${font.family} 105`, scale: 1 })),
    }));
    expect(updated).not.toContain("typography:start");
    expect(updated).not.toContain("document-scripts");
    expect(updated).toContain("document-languages");
    expect(updated).toContain('"MiSans Khmer 105"');
  });

  test("continues to read legacy document script metadata", () => {
    expect(parseDocumentScripts('// typsastra:document-scripts [{"family":"Latin","script":"latin","scale":1,"language":"fr-FR"}]'))
      .toEqual([{ family: "Latin", script: "latin", scale: 1, language: "fr-FR" }]);
  });

  test("supports disabling document typography", () => {
    expect(renderTypographyBlock({ baseSizePt: 11, fonts: [] })).not.toContain("#set text");
    expect(parseTypographyBlock("")).toBeNull();
  });

  test("detects document scripts", () => {
    expect(detectDocumentScript("Latin ខ្មែរ ខ្មែរ")?.id).toBe("khmer");
    expect(detectDocumentScripts("ខ្មែរ ខ្មែរ ລາວ العربية").map(script => script.id)).toEqual(["khmer", "arabic", "lao"]);
    expect(detectTypographyScripts("English English ខ្មែរ العربية").map(script => script.id)).toEqual(["latin", "arabic", "khmer"]);
  });
});
