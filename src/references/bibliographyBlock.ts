import { relativeDocumentAssetPath } from "../editor/imageDrop";
import { filePathKey, relativeFilePath } from "../platform/paths";

export type BibliographyInsertRequest = {
  mainPath: string;
  sources: readonly string[];
  style: string;
};

export type BibliographyLocation = {
  path: string;
  relativePath: string;
  fromUtf16: number;
  toUtf16: number;
  sources: string[];
  style: string;
};

export type BibliographyInsertResult =
  | { ok: true; call: BibliographyLocation; revealed?: boolean }
  | { ok: false; message: string };

export type BibliographyInsertion = {
  /** Text to insert at the end of the main document. */
  text: string;
  /** Start of the insertion in the existing document. */
  from: number;
  /** Caret position after the insertion. */
  to: number;
  /** Start of the block in the resulting document. */
  blockFrom: number;
  /** End of the block in the resulting document. */
  blockTo: number;
};

/** Paths are relative to the document that owns the bibliography call. */
export function bibliographySourcesRelativeTo(
  workspaceRoot: string,
  documentPath: string,
  sourcePaths: readonly string[],
): string[] {
  const seen = new Set<string>();
  const sources: string[] = [];
  for (const sourcePath of sourcePaths) {
    const relative = relativeDocumentAssetPath(workspaceRoot, documentPath, sourcePath)
      ?? rootRelativePath(workspaceRoot, sourcePath);
    if (!relative) continue;
    const key = filePathKey(relative);
    if (seen.has(key)) continue;
    seen.add(key);
    sources.push(relative);
  }
  return sources;
}

export function bibliographyBlockText(style: string, sources: readonly string[]): string {
  const quoted = sources.map(source => `"${escapeTypstString(source)}"`);
  const argument = quoted.length === 1 ? quoted[0] : `(${quoted.join(", ")})`;
  return `#bibliography(${argument}, style: "${escapeTypstString(style)}")`;
}

/** Appends the bibliography after any existing main-document content. */
export function bibliographyInsertion(
  existingText: string,
  style: string,
  sources: readonly string[],
): BibliographyInsertion {
  const block = bibliographyBlockText(style, sources);
  const prefix = existingText.length === 0
    ? ""
    : existingText.endsWith("\n\n")
      ? ""
      : existingText.endsWith("\n")
        ? "\n"
        : "\n\n";
  const from = existingText.length;
  const text = `${prefix}${block}\n`;
  return {
    text,
    from,
    to: from + text.length,
    blockFrom: from + prefix.length,
    blockTo: from + prefix.length + block.length,
  };
}

export function escapeTypstString(value: string): string {
  return value.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"');
}

function rootRelativePath(workspaceRoot: string, path: string): string | null {
  const relative = relativeFilePath(workspaceRoot, path);
  return relative && relative.length > 0 ? `/${relative.replace(/\\/gu, "/")}` : null;
}
