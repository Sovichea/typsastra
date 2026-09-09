import { describe, expect, test } from "bun:test";
import { detectDocumentScript, detectDocumentScripts, detectTypographyScripts, documentScriptsEdit, isTypstInternalOnlyFont, parseDocumentScripts, parseLegacyDocumentLanguages, parseTypographyBlock, renderTypographyBlock, typographyEdit, typographyScaleChange, typographyScaleExceedsFineAdjustment, TYPST_INTERNAL_FONT_FAMILIES, unsupportedTypstInternalFontScales } from "../src/editor/documentTypography";

describe("document typography", () => {
  test("distinguishes compiler-only fonts from locally installed copies", () => {
    expect(TYPST_INTERNAL_FONT_FAMILIES).toContain("New Computer Modern");
    expect(isTypstInternalOnlyFont("New Computer Modern", ["Arial"])).toBe(true);
    expect(isTypstInternalOnlyFont("New Computer Modern", ["New Computer Modern"])).toBe(false);
    expect(isTypstInternalOnlyFont("MiSans Latin", ["MiSans Latin"])).toBe(false);
  });

  test("rejects non-unit scales for compiler-only fonts", () => {
    const fonts = [
      { family: "New Computer Modern", script: "latin", scale: 1.05 },
      { family: "MiSans Khmer", script: "khmer", scale: 0.95 },
    ];
    expect(unsupportedTypstInternalFontScales(fonts, ["MiSans Khmer"]))
      .toEqual([fonts[0]]);
    expect(unsupportedTypstInternalFontScales(fonts, ["New Computer Modern", "MiSans Khmer"]))
      .toEqual([]);
    expect(unsupportedTypstInternalFontScales([{ ...fonts[0], scale: 1 }], []))
      .toEqual([]);
  });

  test("confirms only manual changes to a non-unit font scale", () => {
    expect(typographyScaleChange(1, 1)).toBe("unchanged");
    expect(typographyScaleChange(1.2, 1)).toBe("apply");
    expect(typographyScaleChange(1, 1.2)).toBe("confirm");
    expect(typographyScaleChange(1.2, 1.3)).toBe("confirm");
  });

  test("warns only beyond the ten-percent fine-adjustment range", () => {
    expect(typographyScaleExceedsFineAdjustment(0.89)).toBe(true);
    expect(typographyScaleExceedsFineAdjustment(0.9)).toBe(false);
    expect(typographyScaleExceedsFineAdjustment(1)).toBe(false);
    expect(typographyScaleExceedsFineAdjustment(1.1)).toBe(false);
    expect(typographyScaleExceedsFineAdjustment(1.11)).toBe(true);
  });
  const config = {
    baseSizePt: 11,
    fonts: [
      { family: "Calibri", script: "latin", scale: 1 },
      { family: "MiSans Khmer", script: "khmer", scale: 1.05 },
      { family: "MiSans Lao", script: "lao", scale: 1 }
    ]
  };

  test("uses ordinary Typst fallback order by default", () => {
    expect(renderTypographyBlock(config)).toContain('    "Calibri",');
    expect(renderTypographyBlock(config)).toContain('    "MiSans Khmer",');
    expect(renderTypographyBlock(config)).not.toContain("covers:");
    expect(renderTypographyBlock(config)).toContain('// typsastra:document-scripts [{"family":"Calibri","script":"latin","scale":1},{"family":"MiSans Khmer","script":"khmer","scale":1.05},{"family":"MiSans Lao","script":"lao","scale":1}]');
    expect(renderTypographyBlock(config)).not.toContain("#show regex(");
    expect(renderTypographyBlock(config)).not.toContain("show raw");
    expect(parseTypographyBlock(renderTypographyBlock(config))).toEqual(config);
  });

  test("treats manually edited set-text fonts as the current typography values", () => {
    const edited = renderTypographyBlock(config)
      .replace('    "Calibri",', '    "Aptos",')
      .replace('    "MiSans Khmer",', '    "Khmer OS Content",');
    expect(parseTypographyBlock(edited)?.fonts).toEqual([
      { family: "Aptos", script: "latin", scale: 1 },
      { family: "Khmer OS Content", script: "khmer", scale: 1.05 },
      { family: "MiSans Lao", script: "lao", scale: 1 },
    ]);
  });

  test("reads manually edited named font rules without treating regex strings as fonts", () => {
    const source = [
      "// typsastra:typography:start",
      '// typsastra:document-scripts [{"family":"Old Khmer","script":"khmer","scale":1},{"family":"Old Latin","script":"latin","scale":1}]',
      "#set text(",
      "  font: (",
      '    (name: "Khmer OS", covers: regex("[\\p{scx=Khmer}]")),',
      '    (name: "Aptos", covers: regex("[\\p{scx=Latin}]")),',
      "  ),",
      "  size: 12pt,",
      ")",
      "// typsastra:typography:end",
    ].join("\n");
    expect(parseTypographyBlock(source)).toEqual({
      baseSizePt: 12,
      fonts: [
        { family: "Khmer OS", script: "khmer", scale: 1 },
        { family: "Aptos", script: "latin", scale: 1 },
      ],
    });
  });

  test("keeps legacy language metadata separate from document typography", () => {
    const legacy = '// typsastra:document-scripts [{"family":"Latin","script":"latin","scale":1,"language":"fr-FR"}]\n#import "template.typ"';
    expect(parseDocumentScripts(legacy))
      .toEqual([{ family: "Latin", script: "latin", scale: 1 }]);
    expect(parseLegacyDocumentLanguages(legacy))
      .toEqual([{ script: "Latn", languageTag: "fr-FR" }]);
    expect(parseDocumentScripts('// typsastra:script-fonts [{"family":"Khmer","script":"khmer","scale":1}]'))
      .toEqual([{ family: "Khmer", script: "khmer", scale: 1 }]);
    expect(parseDocumentScripts('// typsastra:document-scripts [{"family":"Latin","script":"latin","scale":1,"common":true},{"family":"Khmer","script":"khmer","scale":1,"common":true}]'))
      .toEqual([
        { family: "Latin", script: "latin", scale: 1 },
        { family: "Khmer", script: "khmer", scale: 1 }
      ]);
  });

  test("adds document-script metadata to a main file without rewriting its Typst content", () => {
    const source = '#import "template.typ"\n= Article\n';
    const edit = documentScriptsEdit(source, config.fonts);
    const updated = source.slice(0, edit.from) + edit.insert + source.slice(edit.to);
    expect(updated).toStartWith("// typsastra:document-scripts ");
    expect(updated).toEndWith(source);
  });

  test("migrates the former regex size adjustment to a uniform scale", () => {
    const legacy = [
      "// typsastra:typography:start",
      '#set text(font: "Calibri", size: 10pt)',
      '#show regex("\\p{Khmer}+"): set text(font: "MiSans Khmer", size: 1em + 0.5pt)',
      "// typsastra:typography:end",
      ""
    ].join("\n");
    expect(parseTypographyBlock(legacy)).toEqual({
      baseSizePt: 10,
      fonts: [
        { family: "Calibri", script: "latin", scale: 1 },
        { family: "MiSans Khmer", script: "khmer", scale: 1.05 }
      ]
    });
  });

  test("parses the previous single-fallback metadata", () => {
    const legacy = [
      "// typsastra:typography:start",
      '// typsastra:complex-font {"family":"MiSans Khmer","script":"khmer","scale":1.1}',
      '#set text(font: ("Calibri", "MiSans Khmer"), size: 11pt)',
      "// typsastra:typography:end",
      ""
    ].join("\n");
    expect(parseTypographyBlock(legacy)).toEqual({
      baseSizePt: 11,
      fonts: [
        { family: "Calibri", script: "latin", scale: 1 },
        { family: "MiSans Khmer", script: "khmer", scale: 1.1 }
      ]
    });
  });

  test("migrates primary and embedded role metadata to equal script assignments", () => {
    const legacy = [
      "// typsastra:typography:start",
      '// typsastra:font-roles {"primary":{"family":"MiSans Khmer","script":"khmer"},"embedded":[{"family":"MiSans Latin","script":"latin","scale":1.1}]}',
      '#set text(font: ("MiSans Khmer", "MiSans Latin"), size: 11pt)',
      "// typsastra:typography:end",
      ""
    ].join("\n");
    expect(parseTypographyBlock(legacy)).toEqual({
      baseSizePt: 11,
      fonts: [
        { family: "MiSans Khmer", script: "khmer", scale: 1 },
        { family: "MiSans Latin", script: "latin", scale: 1.1 }
      ]
    });
  });

  test("supports arbitrary fallback order and single-script documents", () => {
    const khmerFirst = {
      baseSizePt: 11,
      fonts: [
        { family: "MiSans Khmer", script: "khmer", scale: 0.95 },
        { family: "Calibri", script: "latin", scale: 1.1 }
      ]
    };
    const complexBlock = renderTypographyBlock(khmerFirst);
    expect(complexBlock.indexOf('"MiSans Khmer"')).toBeLessThan(complexBlock.indexOf('"Calibri"'));
    expect(complexBlock).not.toContain("covers:");
    expect(parseTypographyBlock(complexBlock)).toEqual(khmerFirst);

    const latinOnly = { baseSizePt: 11, fonts: [{ family: "Calibri", script: "latin", scale: 1 }] };
    const latinBlock = renderTypographyBlock(latinOnly);
    expect(latinBlock).toContain('"Calibri",');
    expect(latinBlock).not.toContain("covers:");
    expect(latinBlock).not.toContain("#show regex(");
    expect(parseTypographyBlock(latinBlock)).toEqual(latinOnly);
  });

  test("prepares additional scaled fonts without adding them to default text fallback", () => {
    const typography = {
      baseSizePt: 11,
      fonts: [
        { family: "Khmer OS", script: "khmer", scale: 0.95 },
        { family: "Moul", script: "khmer", scale: 1.08, defaultText: false },
        { family: "Calibri", script: "latin", scale: 1 },
      ],
    };
    const block = renderTypographyBlock(typography);
    expect(block).toContain('"family":"Moul","script":"khmer","scale":1.08,"defaultText":false');
    expect(block).toContain('    "Khmer OS",');
    expect(block).toContain('    "Calibri",');
    expect(block).not.toContain('    "Moul",');
    expect(parseTypographyBlock(block)).toEqual(typography);
  });

  test("always renders ordinary fallback and drops retired shared-mark metadata", () => {
    const formerOverride = {
      baseSizePt: 11,
      fonts: [
        { family: "Siemreap", script: "khmer", scale: 1 },
        { family: "Calibri", script: "latin", scale: 1, common: true }
      ]
    };
    const block = renderTypographyBlock(formerOverride);
    expect(block).toContain('    "Siemreap",');
    expect(block).toContain('    "Calibri",');
    expect(block).not.toContain("covers:");
    expect(block).not.toContain('"common":true');
    expect(parseTypographyBlock(block)).toEqual({
      baseSizePt: 11,
      fonts: [
        { family: "Siemreap", script: "khmer", scale: 1 },
        { family: "Calibri", script: "latin", scale: 1 }
      ]
    });
  });

  test("reads the former coverage format but rewrites it as ordinary fallback", () => {
    const legacy = [
      "// typsastra:typography:start",
      '// typsastra:document-scripts [{"family":"Khmer","script":"khmer","scale":1},{"family":"Latin","script":"latin","scale":1}]',
      "#set text(",
      "  font: (",
      '    (name: "Khmer", covers: regex("[\\p{scx=Khmer}\\p{scx=Common}]")),',
      '    (name: "Latin", covers: regex("[\\p{scx=Latin}\\p{scx=Common}]")),',
      "  ),",
      "  size: 11pt,",
      ")",
      "// typsastra:typography:end"
    ].join("\n");
    const parsed = parseTypographyBlock(legacy);
    expect(parsed?.fonts).toEqual([
      { family: "Khmer", script: "khmer", scale: 1 },
      { family: "Latin", script: "latin", scale: 1 }
    ]);
    expect(renderTypographyBlock(parsed!)).toContain('    "Khmer",');
    expect(renderTypographyBlock(parsed!)).not.toContain("covers:");
  });

  test("supports disabling managed typography", () => {
    const disabledBoth = { baseSizePt: 11, fonts: [] };
    const disabledBlock = renderTypographyBlock(disabledBoth);
    expect(disabledBlock).not.toContain("#set text(");
    expect(disabledBlock).not.toContain("#show regex(");
    expect(parseTypographyBlock(disabledBlock)).toBeNull();
  });

  test("updates one managed block and preserves the preview directive", () => {
    const original = "// legacy preview directive\n= Chapter\n";
    const first = typographyEdit(original, config);
    const withBlock = original.slice(0, first.from) + first.insert + original.slice(first.to);
    expect(withBlock.startsWith("// typsastra:typography:start")).toBe(true);

    const second = typographyEdit(withBlock, {
      ...config,
      fonts: config.fonts.map(font => font.script === "latin" ? { ...font, family: "MiSans Latin" } : font)
    });
    const updated = withBlock.slice(0, second.from) + second.insert + withBlock.slice(second.to);
    expect(updated.match(/typsastra:typography:start/g)?.length).toBe(1);
    expect(updated).toContain('"MiSans Latin",');
  });

  test("detects the dominant complex script", () => {
    expect(detectDocumentScript("Latin ខ្មែរ ខ្មែរ")?.id).toBe("khmer");
    expect(detectDocumentScript("Latin only")).toBeNull();
  });

  test("detects every script in dominance order", () => {
    expect(detectDocumentScripts("ខ្មែរ ខ្មែរ ລາວ العربية").map(script => script.id)).toEqual(["khmer", "arabic", "lao"]);
  });

  test("detects typography scripts in dominance order", () => {
    expect(detectTypographyScripts("English English English ខ្មែរ العربية").map(script => script.id))
      .toEqual(["latin", "arabic", "khmer"]);
    expect(detectTypographyScripts("ខ្មែរ ខ្មែរ English").map(script => script.id))
      .toEqual(["khmer", "latin"]);
  });
});
