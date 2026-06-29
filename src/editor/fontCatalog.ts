export const codeEditorFonts = [
  { id: "Fira Mono", label: "Fira Mono", fontFamily: "Fira Mono", bundled: true }
] as const;

export type CodeEditorFontId = string;

export const unicodeEditorFonts = [
  { id: "mi-sans-arabic", label: "MiSans Arabic", language: "Arabic", fontFamily: "MiSans Arabic", pattern: /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/u, bundled: false },
  { id: "mi-sans-devanagari", label: "MiSans Devanagari", language: "Devanagari", fontFamily: "MiSans Devanagari", pattern: /[\u0900-\u097F\uA8E0-\uA8FF]/u, bundled: false },
  { id: "mi-sans-gurmukhi", label: "MiSans Gurmukhi", language: "Gurmukhi", fontFamily: "MiSans Gurmukhi", pattern: /[\u0A00-\u0A7F]/u, bundled: false },
  { id: "mi-sans-gujarati", label: "MiSans Gujarati", language: "Gujarati", fontFamily: "MiSans Gujarati", pattern: /[\u0A80-\u0AFF]/u, bundled: false },
  { id: "mi-sans-thai", label: "MiSans Thai", language: "Thai", fontFamily: "MiSans Thai", pattern: /[\u0E00-\u0E7F]/u, bundled: false },
  { id: "mi-sans-lao", label: "MiSans Lao", language: "Lao", fontFamily: "MiSans Lao", pattern: /[\u0E80-\u0EFF]/u, bundled: false },
  { id: "mi-sans-tibetan", label: "MiSans Tibetan", language: "Tibetan", fontFamily: "MiSans Tibetan", pattern: /[\u0F00-\u0FFF]/u, bundled: false },
  { id: "mi-sans-myanmar", label: "MiSans Myanmar", language: "Myanmar", fontFamily: "MiSans Myanmar", pattern: /[\u1000-\u109F\uA9E0-\uA9FF\uAA60-\uAA7F]/u, bundled: false },
  { id: "mi-sans-khmer", label: "MiSans Khmer", language: "Khmer", fontFamily: "MiSans Khmer", pattern: /[\u1780-\u17FF\u19E0-\u19FF]/u, bundled: false },
  { id: "noto-sans-hebrew", label: "Noto Sans Hebrew", language: "Hebrew", fontFamily: "Noto Sans Hebrew", pattern: /[\u0590-\u05FF]/u, bundled: false },
  { id: "noto-sans-armenian", label: "Noto Sans Armenian", language: "Armenian", fontFamily: "Noto Sans Armenian", pattern: /[\u0530-\u058F]/u, bundled: false },
  { id: "noto-sans-bengali", label: "Noto Sans Bengali", language: "Bengali", fontFamily: "Noto Sans Bengali", pattern: /[\u0980-\u09FF]/u, bundled: false },
  { id: "noto-sans-oriya", label: "Noto Sans Oriya", language: "Odia", fontFamily: "Noto Sans Oriya", pattern: /[\u0B00-\u0B7F]/u, bundled: false },
  { id: "noto-sans-tamil", label: "Noto Sans Tamil", language: "Tamil", fontFamily: "Noto Sans Tamil", pattern: /[\u0B80-\u0BFF]/u, bundled: false },
  { id: "noto-sans-telugu", label: "Noto Sans Telugu", language: "Telugu", fontFamily: "Noto Sans Telugu", pattern: /[\u0C00-\u0C7F]/u, bundled: false },
  { id: "noto-sans-kannada", label: "Noto Sans Kannada", language: "Kannada", fontFamily: "Noto Sans Kannada", pattern: /[\u0C80-\u0CFF]/u, bundled: false },
  { id: "noto-sans-malayalam", label: "Noto Sans Malayalam", language: "Malayalam", fontFamily: "Noto Sans Malayalam", pattern: /[\u0D00-\u0D7F]/u, bundled: false },
  { id: "noto-sans-sinhala", label: "Noto Sans Sinhala", language: "Sinhala", fontFamily: "Noto Sans Sinhala", pattern: /[\u0D80-\u0DFF]/u, bundled: false },
  { id: "noto-sans-georgian", label: "Noto Sans Georgian", language: "Georgian", fontFamily: "Noto Sans Georgian", pattern: /[\u10A0-\u10FF\u1C90-\u1CBF]/u, bundled: false },
  { id: "noto-sans-ethiopic", label: "Noto Sans Ethiopic", language: "Ethiopic", fontFamily: "Noto Sans Ethiopic", pattern: /[\u1200-\u137F]/u, bundled: false },
  { id: "noto-sans-jp", label: "Noto Sans JP", language: "Japanese", fontFamily: "Noto Sans JP", pattern: /[\u3040-\u30FF\u31F0-\u31FF]/u, bundled: false },
  { id: "noto-sans-kr", label: "Noto Sans KR", language: "Korean", fontFamily: "Noto Sans KR", pattern: /[\u1100-\u11FF\u3130-\u318F\uAC00-\uD7AF]/u, bundled: false },
  { id: "mi-sans-latin", label: "MiSans Latin", language: "Greek and Cyrillic", fontFamily: "MiSans Latin", pattern: /[\u0370-\u052F\u1C80-\u1C8F\u1D00-\u1D7F\u1F00-\u1FFF\u2C60-\u2C7F\u2DE0-\u2DFF\uA640-\uA69F\uAB30-\uAB6F]/u, bundled: true },
  { id: "mi-sans", label: "MiSans", language: "Chinese", fontFamily: "MiSans", pattern: /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u{20000}-\u{3134F}]/u, bundled: false }
] as const;

export type UnicodeEditorFontId = typeof unicodeEditorFonts[number]["id"];
export type UnicodeFontPreference = string;

export const unicodeFontPreferenceOptions: ReadonlyArray<{ id: UnicodeFontPreference; label: string }> = [
  { id: "auto", label: "Automatic (ask when a script is detected)" },
  { id: "none", label: "No additional fallback" }
];

function validFamily(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 200 && !/[\u0000-\u001F\u007F]/.test(value);
}

const legacyCodeFonts: Record<string, string> = {
  "fira-mono": "Fira Mono",
  "dejavu-sans-mono": "DejaVu Sans Mono",
  "system-monospace": "monospace"
};

export function normalizeCodeEditorFont(value: unknown): CodeEditorFontId {
  if (!validFamily(value)) return "Fira Mono";
  if (value === "MiSans Latin") return "Fira Mono";
  return legacyCodeFonts[value] ?? value;
}

export function normalizeUnicodeFontPreference(value: unknown): UnicodeFontPreference {
  if (!validFamily(value)) return "auto";
  if (value === "auto" || value === "none") return value;
  const legacy = unicodeEditorFonts.find(font => font.id === value);
  return legacy?.fontFamily ?? value;
}

function quoteFamily(family: string): string {
  return `"${family.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function codeEditorFontStack(id: CodeEditorFontId, unicodeFamily?: string): string {
  const selected = normalizeCodeEditorFont(id);
  const families = [
    selected === "monospace" ? selected : quoteFamily(selected),
    unicodeFamily ? quoteFamily(unicodeFamily) : null,
    "ui-monospace",
    "SFMono-Regular",
    "Consolas",
    '"Liberation Mono"',
    "monospace"
  ];
  return [...new Set(families.filter((family): family is string => !!family))].join(", ");
}

export function detectUnicodeEditorFont(text: string) {
  return unicodeEditorFonts.find(font => font.pattern.test(text)) ?? null;
}
