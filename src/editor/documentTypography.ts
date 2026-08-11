export type DocumentScript = {
  id: string;
  label: string;
  unicodeProperty: string;
  iso15924: string;
  pattern: RegExp;
  preferredFamilies: readonly string[];
};

export type DocumentTypography = {
  baseSizePt: number;
  fonts: DocumentScriptFont[];
};

export type DocumentScriptFont = {
  script: string;
  family: string;
  scale: number;
  language: string | null;
  /** False prepares the scaled family without adding it to the default text fallback stack. */
  defaultText?: boolean;
};

export type DocumentLanguage = { script: string; language: string | null };

export type TypographyEdit = { from: number; to: number; insert: string };
export type TypographyScaleChange = "unchanged" | "apply" | "confirm";

export const TYPOGRAPHY_FINE_ADJUSTMENT_MIN = 0.9;
export const TYPOGRAPHY_FINE_ADJUSTMENT_MAX = 1.1;

/** Font families embedded by the local Typst compiler rather than installed by the OS. */
export const TYPST_INTERNAL_FONT_FAMILIES = [
  "Libertinus Serif",
  "New Computer Modern",
  "New Computer Modern Math",
  "DejaVu Sans Mono",
] as const;

function sameFontFamily(left: string, right: string): boolean {
  return left.localeCompare(right, undefined, { sensitivity: "accent" }) === 0;
}

export function isTypstInternalOnlyFont(family: string, systemFamilies: readonly string[]): boolean {
  return TYPST_INTERNAL_FONT_FAMILIES.some(candidate => sameFontFamily(candidate, family))
    && !systemFamilies.some(candidate => sameFontFamily(candidate, family));
}

export function unsupportedTypstInternalFontScales(
  fonts: readonly DocumentScriptFont[],
  systemFamilies: readonly string[],
): DocumentScriptFont[] {
  return fonts.filter(font => Math.abs(font.scale - 1) > 0.0001
    && isTypstInternalOnlyFont(font.family, systemFamilies));
}

export function typographyScaleExceedsFineAdjustment(scale: number): boolean {
  return scale < TYPOGRAPHY_FINE_ADJUSTMENT_MIN - 0.0001
    || scale > TYPOGRAPHY_FINE_ADJUSTMENT_MAX + 0.0001;
}

export function typographyScaleChange(previousScale: number, nextScale: number): TypographyScaleChange {
  if (Math.abs(previousScale - nextScale) <= 0.0001) return "unchanged";
  return Math.abs(nextScale - 1) <= 0.0001 ? "apply" : "confirm";
}

const blockStart = "// typsastra:typography:start";
const blockEnd = "// typsastra:typography:end";

export const latinDocumentScript: DocumentScript = {
  id: "latin",
  label: "Latin",
  unicodeProperty: "Latin",
  iso15924: "Latn",
  pattern: /\p{Script=Latin}/gu,
  preferredFamilies: ["Calibri", "MiSans Latin", "Noto Sans"]
};

export const documentScripts: readonly DocumentScript[] = [
  { id: "khmer", label: "Khmer", unicodeProperty: "Khmer", iso15924: "Khmr", pattern: /[\u1780-\u17ff\u19e0-\u19ff]/gu, preferredFamilies: ["MiSans Khmer", "Noto Sans Khmer"] },
  { id: "arabic", label: "Arabic", unicodeProperty: "Arabic", iso15924: "Arab", pattern: /[\u0600-\u06ff\u0750-\u077f\u08a0-\u08ff]/gu, preferredFamilies: ["MiSans Arabic", "Noto Sans Arabic"] },
  { id: "thai", label: "Thai", unicodeProperty: "Thai", iso15924: "Thai", pattern: /[\u0e00-\u0e7f]/gu, preferredFamilies: ["MiSans Thai", "Noto Sans Thai"] },
  { id: "lao", label: "Lao", unicodeProperty: "Lao", iso15924: "Laoo", pattern: /[\u0e80-\u0eff]/gu, preferredFamilies: ["MiSans Lao", "Noto Sans Lao"] },
  { id: "myanmar", label: "Myanmar", unicodeProperty: "Myanmar", iso15924: "Mymr", pattern: /[\u1000-\u109f\ua9e0-\ua9ff\uaa60-\uaa7f]/gu, preferredFamilies: ["MiSans Myanmar", "Noto Sans Myanmar"] },
  { id: "devanagari", label: "Devanagari", unicodeProperty: "Devanagari", iso15924: "Deva", pattern: /[\u0900-\u097f\ua8e0-\ua8ff]/gu, preferredFamilies: ["MiSans Devanagari", "Noto Sans Devanagari"] },
  { id: "bengali", label: "Bengali", unicodeProperty: "Bengali", iso15924: "Beng", pattern: /[\u0980-\u09ff]/gu, preferredFamilies: ["Noto Sans Bengali"] },
  { id: "gurmukhi", label: "Gurmukhi", unicodeProperty: "Gurmukhi", iso15924: "Guru", pattern: /[\u0a00-\u0a7f]/gu, preferredFamilies: ["MiSans Gurmukhi", "Noto Sans Gurmukhi"] },
  { id: "gujarati", label: "Gujarati", unicodeProperty: "Gujarati", iso15924: "Gujr", pattern: /[\u0a80-\u0aff]/gu, preferredFamilies: ["MiSans Gujarati", "Noto Sans Gujarati"] },
  { id: "tamil", label: "Tamil", unicodeProperty: "Tamil", iso15924: "Taml", pattern: /[\u0b80-\u0bff]/gu, preferredFamilies: ["Noto Sans Tamil"] },
  { id: "telugu", label: "Telugu", unicodeProperty: "Telugu", iso15924: "Telu", pattern: /[\u0c00-\u0c7f]/gu, preferredFamilies: ["Noto Sans Telugu"] },
  { id: "kannada", label: "Kannada", unicodeProperty: "Kannada", iso15924: "Knda", pattern: /[\u0c80-\u0cff]/gu, preferredFamilies: ["Noto Sans Kannada"] },
  { id: "malayalam", label: "Malayalam", unicodeProperty: "Malayalam", iso15924: "Mlym", pattern: /[\u0d00-\u0d7f]/gu, preferredFamilies: ["Noto Sans Malayalam"] },
  { id: "sinhala", label: "Sinhala", unicodeProperty: "Sinhala", iso15924: "Sinh", pattern: /[\u0d80-\u0dff]/gu, preferredFamilies: ["Noto Sans Sinhala"] },
  { id: "tibetan", label: "Tibetan", unicodeProperty: "Tibetan", iso15924: "Tibt", pattern: /[\u0f00-\u0fff]/gu, preferredFamilies: ["MiSans Tibetan", "Noto Sans Tibetan"] },
  { id: "hebrew", label: "Hebrew", unicodeProperty: "Hebrew", iso15924: "Hebr", pattern: /[\u0590-\u05ff]/gu, preferredFamilies: ["Noto Sans Hebrew"] },
  { id: "armenian", label: "Armenian", unicodeProperty: "Armenian", iso15924: "Armn", pattern: /[\u0530-\u058f]/gu, preferredFamilies: ["Noto Sans Armenian"] },
  { id: "georgian", label: "Georgian", unicodeProperty: "Georgian", iso15924: "Geor", pattern: /[\u10a0-\u10ff\u1c90-\u1cbf]/gu, preferredFamilies: ["Noto Sans Georgian"] },
  { id: "ethiopic", label: "Ethiopic", unicodeProperty: "Ethiopic", iso15924: "Ethi", pattern: /[\u1200-\u137f]/gu, preferredFamilies: ["Noto Sans Ethiopic"] },
  { id: "han", label: "Han", unicodeProperty: "Han", iso15924: "Hani", pattern: /[\u3400-\u4dbf\u4e00-\u9fff]/gu, preferredFamilies: ["Noto Sans SC", "Noto Sans CJK SC"] },
  { id: "hiragana", label: "Japanese", unicodeProperty: "Hiragana", iso15924: "Jpan", pattern: /[\u3040-\u30ff]/gu, preferredFamilies: ["Noto Sans JP"] },
  { id: "hangul", label: "Korean", unicodeProperty: "Hangul", iso15924: "Kore", pattern: /[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/gu, preferredFamilies: ["Noto Sans KR"] }
];

export const typographyScripts: readonly DocumentScript[] = [latinDocumentScript, ...documentScripts];

function countMatches(text: string, pattern: RegExp): number {
  pattern.lastIndex = 0;
  return [...text.matchAll(pattern)].length;
}

export function detectDocumentScript(text: string): DocumentScript | null {
  return detectDocumentScripts(text)[0] ?? null;
}

export function detectDocumentScripts(text: string): DocumentScript[] {
  return documentScripts
    .map(script => ({ script, count: countMatches(text, script.pattern) }))
    .filter(candidate => candidate.count > 0)
    .sort((left, right) => right.count - left.count)
    .map(candidate => candidate.script);
}

export function detectTypographyScripts(text: string): DocumentScript[] {
  return typographyScripts
    .map(script => ({ script, count: countMatches(text, script.pattern) }))
    .filter(candidate => candidate.count > 0)
    .sort((left, right) => right.count - left.count)
    .map(candidate => candidate.script);
}

export function preferredInstalledFamily(script: DocumentScript, families: readonly string[]): string | null {
  for (const preferred of script.preferredFamilies) {
    const match = families.find(family => family.localeCompare(preferred, undefined, { sensitivity: "accent" }) === 0);
    if (match) return match;
  }
  return null;
}

function escapeTypstString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function unescapeTypstString(value: string): string {
  return value.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}

function matchingDelimiter(text: string, start: number, open: string, close: string): number {
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') {
      quoted = true;
      continue;
    }
    if (character === open) depth += 1;
    else if (character === close && --depth === 0) return index;
  }
  return -1;
}

function splitTopLevel(value: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if ("([{<".includes(character)) depth += 1;
    else if (")]}>".includes(character)) depth = Math.max(0, depth - 1);
    else if (character === "," && depth === 0) {
      parts.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(value.slice(start).trim());
  return parts.filter(Boolean);
}

function quotedValue(value: string): string | null {
  const match = /^"((?:\\.|[^"])*)"$/.exec(value.trim());
  return match ? unescapeTypstString(match[1]) : null;
}

function managedFontFamilies(block: string): string[] {
  const rule = /(?:^|\n)\s*#?set\s+text\s*\(/g.exec(block);
  if (!rule) return [];
  const callStart = block.indexOf("(", rule.index);
  const callEnd = matchingDelimiter(block, callStart, "(", ")");
  if (callStart < 0 || callEnd < 0) return [];
  const argumentsText = block.slice(callStart + 1, callEnd);
  const fontArgument = splitTopLevel(argumentsText).find(argument => /^font\s*:/.test(argument));
  if (!fontArgument) return [];
  const value = fontArgument.slice(fontArgument.indexOf(":") + 1).trim();
  const single = quotedValue(value);
  if (single) return [single];
  if (!value.startsWith("(")) return [];
  const tupleEnd = matchingDelimiter(value, 0, "(", ")");
  if (tupleEnd < 0) return [];
  return splitTopLevel(value.slice(1, tupleEnd)).flatMap(entry => {
    const direct = quotedValue(entry);
    if (direct) return [direct];
    const named = /(?:^|[,({]\s*)name\s*:\s*"((?:\\.|[^"])*)"/.exec(entry);
    return named ? [unescapeTypstString(named[1])] : [];
  });
}

function decimal(value: number): string {
  return Number(value.toFixed(2)).toString();
}

function normalizeLanguageTag(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const [language, region, ...extra] = value.trim().replace(/_/g, "-").split("-");
  if (extra.length > 0 || !language || !/^[a-z]{2,3}$/i.test(language)) return null;
  if (region && !/^(?:[a-z]{2}|\d{3})$/i.test(region)) return null;
  return region
    ? `${language.toLowerCase()}-${/^\d{3}$/.test(region) ? region : region.toUpperCase()}`
    : language.toLowerCase();
}

export function renderTypographyBlock(config: DocumentTypography): string {
  const fonts = documentScriptMetadata(config.fonts);
  const languages = documentLanguageMetadata(config.fonts);
  const lines: string[] = [];
  if (languages.length > 0) lines.push(`// typsastra:document-languages ${JSON.stringify(languages)}`);
  if (fonts.length > 0) {
    const descriptors = fonts
      .filter(font => font.defaultText !== false)
      .map(font => `"${escapeTypstString(font.family)}"`);
    lines.push(
      "#set text(",
      ...(descriptors.length > 0 ? [
        "  font: (",
        ...descriptors.map(descriptor => `    ${descriptor},`),
        "  ),",
      ] : []),
      `  size: ${decimal(config.baseSizePt)}pt,`,
      ")"
    );
  }
  lines.push("");
  return lines.join("\n");
}

function documentLanguageMetadata(fonts: readonly Pick<DocumentScriptFont, "script" | "language">[]) {
  return fonts.flatMap(font => font.language ? [{ script: font.script, language: font.language }] : []);
}

export function documentLanguagesEdit(text: string, languages: readonly DocumentLanguage[]): TypographyEdit {
  const normalized = documentLanguageMetadata(languages);
  const directive = normalized.length > 0
    ? `// typsastra:document-languages ${JSON.stringify(normalized)}`
    : "";
  const existing = /\/\/ typsastra:document-languages \[[^\r\n]+\]/.exec(text);
  if (existing?.index !== undefined) {
    return { from: existing.index, to: existing.index + existing[0].length, insert: directive };
  }
  return { from: text.startsWith("\uFEFF") ? 1 : 0, to: text.startsWith("\uFEFF") ? 1 : 0, insert: directive ? `${directive}\n` : "" };
}

export function parseDocumentLanguages(text: string): DocumentLanguage[] {
  const match = /\/\/ typsastra:document-languages (\[[^\r\n]+\])/.exec(text);
  if (!match) return parseDocumentScripts(text).flatMap(font => font.language
    ? [{ script: font.script, language: font.language }]
    : []);
  try {
    const parsed: unknown = JSON.parse(match[1]);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap(item => {
      if (!item || typeof item !== "object") return [];
      const entry = item as Partial<DocumentLanguage>;
      const language = normalizeLanguageTag(entry.language);
      return typeof entry.script === "string"
        && typographyScripts.some(script => script.id === entry.script)
        && language
        ? [{ script: entry.script, language }]
        : [];
    });
  } catch { return []; }
}

function documentScriptMetadata(fonts: readonly DocumentScriptFont[]) {
  return fonts.map(font => ({
    family: font.family,
    script: font.script,
    scale: Math.max(0.5, Math.min(2, font.scale)),
    ...(font.language && font.defaultText !== false ? { language: font.language } : {}),
    ...(font.defaultText === false ? { defaultText: false } : {}),
  }));
}

export function documentScriptsEdit(text: string, fonts: readonly DocumentScriptFont[]): TypographyEdit {
  const directive = `// typsastra:document-scripts ${JSON.stringify(documentScriptMetadata(fonts))}`;
  const existing = /\/\/ typsastra:(?:document-scripts|script-fonts) \[[^\r\n]+\]/.exec(text);
  if (existing?.index !== undefined) {
    return { from: existing.index, to: existing.index + existing[0].length, insert: directive };
  }
  return { from: 0, to: 0, insert: `${directive}\n` };
}

export function parseDocumentScripts(text: string): DocumentScriptFont[] {
  const languages = parseDocumentLanguagesDirect(text);
  if (languages.length > 0) return languages.map(entry => ({
    script: entry.script, language: entry.language, family: "", scale: 1,
  }));
  const current = /\/\/ typsastra:document-scripts (\[[^\r\n]+\])/.exec(text);
  const legacy = /\/\/ typsastra:script-fonts (\[[^\r\n]+\])/.exec(text);
  const raw = current?.[1] ?? legacy?.[1];
  if (!raw) return [];
  const validScript = (script: unknown): script is string =>
    typeof script === "string" && typographyScripts.some(candidate => candidate.id === script);
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap(item => {
      if (!item || typeof item !== "object") return [];
      const candidate = item as Partial<DocumentScriptFont>;
      if (typeof candidate.family !== "string" || !validScript(candidate.script)) return [];
      const language = normalizeLanguageTag(candidate.language);
      return [{
        family: candidate.family,
        script: candidate.script,
        scale: typeof candidate.scale === "number" && Number.isFinite(candidate.scale)
          ? Math.max(0.5, Math.min(2, candidate.scale))
          : 1,
        language: candidate.defaultText === false ? null : language,
        ...(candidate.defaultText === false ? { defaultText: false } : {}),
      }];
    });
  } catch {
    return [];
  }
}

function parseDocumentLanguagesDirect(text: string): DocumentLanguage[] {
  const match = /\/\/ typsastra:document-languages (\[[^\r\n]+\])/.exec(text);
  if (!match) return [];
  try {
    const parsed: unknown = JSON.parse(match[1]);
    return Array.isArray(parsed) ? parsed.flatMap(item => {
      if (!item || typeof item !== "object") return [];
      const candidate = item as Partial<DocumentLanguage>;
      const language = normalizeLanguageTag(candidate.language);
      return typeof candidate.script === "string"
        && typographyScripts.some(script => script.id === candidate.script)
        && language ? [{ script: candidate.script, language }] : [];
    }) : [];
  } catch { return []; }
}

export function parseTypographyBlock(text: string): DocumentTypography | null {
  const start = text.indexOf(blockStart);
  const end = start >= 0 ? text.indexOf(blockEnd, start) : -1;
  const block = start >= 0 && end >= 0 ? text.slice(start, end) : text;
  const documentScriptMetadata = /\/\/ typsastra:document-scripts (\[[^\r\n]+\])/.exec(block);
  const scriptFontMetadata = /\/\/ typsastra:script-fonts (\[[^\r\n]+\])/.exec(block);
  const roleMetadata = /\/\/ typsastra:font-roles (\{[^\r\n]+\})/.exec(block);
  const metadata = /\/\/ typsastra:font-fallbacks (\[[^\r\n]+\])/.exec(block);
  const legacyMetadata = /\/\/ typsastra:complex-font (\{[^\r\n]+\})/.exec(block);
  const validScript = (script: unknown): script is string =>
    typeof script === "string" && typographyScripts.some(candidate => candidate.id === script);
  const parseFonts = (value: unknown): DocumentScriptFont[] => !Array.isArray(value) ? [] : value.flatMap(item => {
    if (!item || typeof item !== "object") return [];
    const candidate = item as Partial<DocumentScriptFont>;
    if (typeof candidate.family !== "string" || !validScript(candidate.script)) return [];
    const language = normalizeLanguageTag(candidate.language);
    return [{
      family: candidate.family,
      script: candidate.script,
      scale: typeof candidate.scale === "number" && Number.isFinite(candidate.scale)
        ? Math.max(0.5, Math.min(2, candidate.scale))
        : 1,
      language: candidate.defaultText === false ? null : language,
      ...(candidate.defaultText === false ? { defaultText: false } : {}),
    }];
  });
  let fonts: DocumentScriptFont[] = [];
  try {
    if (documentScriptMetadata || scriptFontMetadata) {
      fonts = parseDocumentScripts(block);
    } else if (roleMetadata) {
      const roles = JSON.parse(roleMetadata[1]) as { primary?: unknown; embedded?: unknown };
      if (roles.primary && typeof roles.primary === "object") {
        const candidate = roles.primary as Partial<DocumentScriptFont>;
        if (typeof candidate.family === "string" && validScript(candidate.script)) {
          fonts.push({ family: candidate.family, script: candidate.script, scale: 1, language: null });
        }
      }
      fonts.push(...parseFonts(roles.embedded));
    } else {
      const raw: unknown = metadata ? JSON.parse(metadata[1]) : legacyMetadata ? [JSON.parse(legacyMetadata[1])] : [];
      fonts = parseFonts(raw);
    }
  } catch { return null; }
  const legacyComplex = block.match(/#show regex\("\\p\{([^}]+)\}\+"\): set text\(font: "((?:\\.|[^"])*)", size: 1em ([+-]) (\d+(?:\.\d+)?)pt\)/);
  // Managed rules are written as `#set text` in a document, but lose the
  // leading `#` when they are installed inside a Typst template function.
  const managedTextRule = /(?:^|\n)\s*#?set text\(/.test(block);
  if (!managedTextRule && !legacyComplex) return null;
  const legacyScript = legacyComplex
    ? documentScripts.find(candidate => candidate.unicodeProperty === legacyComplex[1])
    : null;
  const size = /\bsize:\s*(-?\d+(?:\.\d+)?)pt/.exec(block);
  const baseSizePt = Number(size?.[1] ?? 11);
  const stackFonts = managedFontFamilies(block);
  if (!documentScriptMetadata && !scriptFontMetadata && !roleMetadata && fonts.length > 0 && stackFonts[0]
    && !fonts.some(font => font.family === stackFonts[0])) {
    fonts.unshift({ family: stackFonts[0], script: "latin", scale: 1, language: null });
  }
  const legacyAdjustment = legacyComplex
    ? Number(legacyComplex[4]) * (legacyComplex[3] === "-" ? -1 : 1)
    : 0;
  if (fonts.length === 0 && legacyComplex && legacyScript) {
    const firstFont = stackFonts[0] ?? null;
    if (firstFont) fonts.push({ family: firstFont, script: "latin", scale: 1, language: null });
    fonts.push({
      family: unescapeTypstString(legacyComplex[2]),
      script: legacyScript.id,
      scale: Math.max(0.5, Math.min(2, (baseSizePt + legacyAdjustment) / baseSizePt)),
      language: null
    });
  }
  if (fonts.length === 0) {
    const orderedFamilies = stackFonts.length > 0
      ? stackFonts
      : [];
    fonts = orderedFamilies.map((family, index) => ({
      family,
      script: index === 0 ? "latin" : documentScripts[Math.min(index - 1, documentScripts.length - 1)].id,
      scale: 1,
      language: null
    }));
  }
  const languages = parseDocumentLanguagesDirect(text);
  if (languages.length > 0) {
    fonts = fonts.map((font, index) => ({
      ...font,
      language: languages.find(language => language.script === font.script)?.language
        ?? languages[index]?.language
        ?? null,
    }));
  }
  const fallbackIndexes = fonts.flatMap((font, index) => font.defaultText === false ? [] : [index]);
  if (stackFonts.length > 0 && fallbackIndexes.length === stackFonts.length) {
    fonts = fonts.map((font, index) => {
      const fallbackIndex = fallbackIndexes.indexOf(index);
      return fallbackIndex >= 0 ? { ...font, family: stackFonts[fallbackIndex] } : font;
    });
  }
  if (fonts.length === 0) return null;
  return { baseSizePt, fonts };
}

export function typographyEdit(text: string, config: DocumentTypography): TypographyEdit {
  const legacyStart = text.indexOf(blockStart);
  let source = text;
  if (legacyStart >= 0) {
    const legacyEnd = text.indexOf(blockEnd, legacyStart);
    if (legacyEnd >= 0) {
      let to = legacyEnd + blockEnd.length;
      if (text.slice(to, to + 2) === "\r\n") to += 2;
      else if (text[to] === "\n") to += 1;
      source = text.slice(0, legacyStart) + text.slice(to);
    }
  }
  const legacyDirective = /\/\/ typsastra:(?:document-scripts|script-fonts) \[[^\r\n]+\]\r?\n?/g;
  source = source.replace(legacyDirective, "");
  const languageEdit = documentLanguagesEdit(source, config.fonts);
  source = source.slice(0, languageEdit.from) + languageEdit.insert + source.slice(languageEdit.to);

  const families = config.fonts.filter(font => font.defaultText !== false && font.family.trim()).map(font => font.family);
  const fontValue = families.length === 1
    ? `"${escapeTypstString(families[0]!)}"`
    : `(\n${families.map(family => `    "${escapeTypstString(family)}",`).join("\n")}\n  )`;
  const rules = [...source.matchAll(/(^|\n)(\s*)#set\s+text\s*\(/gm)];
  if (rules.length > 1) {
    throw new Error("Document Typography found multiple #set text rules. Keep one document-level rule or edit the intended rule directly.");
  }
  const rule = rules[0] ?? null;
  if (rule?.index !== undefined) {
    const callStart = source.indexOf("(", rule.index);
    const callEnd = matchingDelimiter(source, callStart, "(", ")");
    if (callEnd >= 0) {
      const args = splitTopLevel(source.slice(callStart + 1, callEnd));
      const retained = args.filter(argument => !/^(?:font|size)\s*:/.test(argument));
      const nextArgs = [`font: ${fontValue}`, `size: ${decimal(config.baseSizePt)}pt`, ...retained];
      source = source.slice(0, callStart + 1) + `\n  ${nextArgs.join(",\n  ")},\n` + source.slice(callEnd);
    }
  } else {
    const insertion = `#set text(\n  font: ${fontValue},\n  size: ${decimal(config.baseSizePt)}pt,\n)\n`;
    const directiveEnd = /\/\/ typsastra:document-languages \[[^\r\n]+\]\r?\n?/.exec(source);
    const at = directiveEnd?.index !== undefined ? directiveEnd.index + directiveEnd[0].length : (source.startsWith("\uFEFF") ? 1 : 0);
    source = source.slice(0, at) + insertion + source.slice(at);
  }

  let prefix = 0;
  while (prefix < text.length && prefix < source.length && text[prefix] === source[prefix]) prefix += 1;
  let oldSuffix = text.length;
  let newSuffix = source.length;
  while (oldSuffix > prefix && newSuffix > prefix && text[oldSuffix - 1] === source[newSuffix - 1]) {
    oldSuffix -= 1; newSuffix -= 1;
  }
  return { from: prefix, to: oldSuffix, insert: source.slice(prefix, newSuffix) };
}
