import { invoke } from "@tauri-apps/api/core";
import { khmerWordBoundaryAtOffset, type GraphemeBoundary } from "./grapheme";
import type { AnalyzeResponse } from "./spellcheck";

/** Ask the same Khmer provider used by spellcheck for its actual word tokens. */
export async function analyzeKhmerWordAt(
  text: string,
  offset: number,
  contentMode: "plainText" | "typstSource" = "plainText",
): Promise<GraphemeBoundary | null> {
  const newlineBefore = text.lastIndexOf("\n", Math.max(0, offset - 1));
  const from = newlineBefore + 1;
  const newlineAfter = text.indexOf("\n", offset);
  const to = newlineAfter < 0 ? text.length : newlineAfter;
  const line = text.slice(from, to);
  const cluster = khmerWordBoundaryAtOffset(line, offset - from, 1);
  if (!cluster) return null;

  try {
    const response = await invoke<AnalyzeResponse>("analyze_language_ranges", {
      request: {
        chunks: [{ text: line, startUtf16: 0, provider: "khmer-segmenter", contentMode }],
        userDictionary: [],
      },
    });
    const token = response.tokens.find(candidate => candidate.provider === "khmer-segmenter"
      && candidate.sourceFromUtf16 <= cluster.from && cluster.to <= candidate.sourceToUtf16
      && line.slice(candidate.sourceFromUtf16, candidate.sourceToUtf16) === candidate.sourceText);
    const word = khmerWordBoundaryAtOffset(line, cluster.from, 1, token
      ? { from: token.sourceFromUtf16, to: token.sourceToUtf16 } : null);
    return word ? { from: from + word.from, to: from + word.to } : null;
  } catch {
    // Never replace the user's selection with a browser-guessed Khmer run.
    return { from: from + cluster.from, to: from + cluster.to };
  }
}
