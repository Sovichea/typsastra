import { exists, mkdir, readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { dirname } from "@tauri-apps/api/path";
import type { LanguageTerminologyEntry, TerminologyEntry } from "./settings";

export const USER_DICTIONARY_FILE = "user_dict.txt";
export const TERMINOLOGY_FILE = "terminology.txt";
export const PROJECT_TERMINOLOGY_FILE = TERMINOLOGY_FILE;

export type TerminologyFileContents = {
  global: TerminologyEntry[];
  language: LanguageTerminologyEntry[];
};

export function parseUserDictionary(text: string): string[] {
  const words = text
    .split(/\r?\n/u)
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith("#"));
  return [...new Set(words)];
}

export function formatUserDictionary(words: readonly string[]): string {
  const unique = [...new Set(words.map(word => word.trim()).filter(Boolean))];
  return unique.length > 0 ? `${unique.join("\n")}\n` : "";
}

export function parseTerminology(text: string): TerminologyFileContents {
  const global = new Map<string, TerminologyEntry>();
  const language = new Map<string, LanguageTerminologyEntry>();
  let languageFamily: string | null = null;

  for (const raw of text.split(/\r?\n/u)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("[") && line.endsWith("]")) {
      const section = line.slice(1, -1).trim();
      languageFamily = !section || section.toLowerCase() === "global" ? null : section;
      continue;
    }
    const exactCase = !line.startsWith("~");
    const term = (exactCase ? line : line.slice(1)).trim();
    if (!term) continue;
    const key = `${exactCase ? "exact" : "fold"}:${term}`;
    if (languageFamily) {
      language.set(`${languageFamily}:${key}`, { term, exactCase, languageFamily });
    } else {
      global.set(key, { term, exactCase });
    }
  }

  return {
    global: [...global.values()],
    language: [...language.values()],
  };
}

export function formatTerminology(
  global: readonly TerminologyEntry[],
  language: readonly LanguageTerminologyEntry[],
): string {
  const lines = global.map(entry => `${entry.exactCase ? "" : "~"}${entry.term}`);
  const families = new Map<string, TerminologyEntry[]>();
  for (const entry of language) {
    const entries = families.get(entry.languageFamily) ?? [];
    entries.push({ term: entry.term, exactCase: entry.exactCase });
    families.set(entry.languageFamily, entries);
  }
  for (const family of [...families.keys()].sort()) {
    if (lines.length > 0) lines.push("");
    lines.push(`[${family}]`);
    for (const entry of families.get(family) ?? []) {
      lines.push(`${entry.exactCase ? "" : "~"}${entry.term}`);
    }
  }
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

export async function readTextFileIfPresent(path: string): Promise<string | null> {
  return await exists(path) ? await readTextFile(path) : null;
}

export async function writeTextFileEnsuringParent(path: string, text: string): Promise<void> {
  await mkdir(await dirname(path), { recursive: true });
  await writeTextFile(path, text);
}
