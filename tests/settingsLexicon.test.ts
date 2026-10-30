import { describe, expect, test } from "bun:test";
import {
  formatTerminology,
  formatUserDictionary,
  parseTerminology,
  parseUserDictionary,
} from "../src/settingsLexicon";

describe("plain-text spelling stores", () => {
  test("parses one user dictionary word per line and preserves case", () => {
    expect(parseUserDictionary("# personal words\nLaTeX\nNASA\n\nlatex\nLaTeX\n"))
      .toEqual(["LaTeX", "NASA", "latex"]);
  });

  test("writes and rereads user dictionary entries", () => {
    const words = ["LaTeX", "NASA", "Typsastra"];
    expect(parseUserDictionary(formatUserDictionary(words))).toEqual(words);
  });

  test("parses global, case-insensitive, and language terminology", () => {
    const parsed = parseTerminology([
      "# Global terms",
      "LaTeX",
      "~typsastra",
      "",
      "[en]",
      "NASA",
      "~latex",
      "[de]",
      "~Haus",
      "",
    ].join("\n"));

    expect(parsed.global).toEqual([
      { term: "LaTeX", exactCase: true },
      { term: "typsastra", exactCase: false },
    ]);
    expect(parsed.language).toEqual([
      { term: "NASA", exactCase: true, languageFamily: "en" },
      { term: "latex", exactCase: false, languageFamily: "en" },
      { term: "Haus", exactCase: false, languageFamily: "de" },
    ]);
  });

  test("round-trips terminology files", () => {
    const global = [
      { term: "LaTeX", exactCase: true },
      { term: "Typsastra", exactCase: false },
    ];
    const language = [
      { term: "NASA", exactCase: true, languageFamily: "en" },
      { term: "Haus", exactCase: false, languageFamily: "de" },
    ];
    const text = formatTerminology(global, language);

    expect(text).toContain("LaTeX");
    expect(text).toContain("~Typsastra");
    expect(text).toContain("[en]");
    expect(text).toContain("[de]");
    expect(parseTerminology(text)).toEqual({
      global,
      language: [
        { term: "Haus", exactCase: false, languageFamily: "de" },
        { term: "NASA", exactCase: true, languageFamily: "en" },
      ],
    });
  });
});
