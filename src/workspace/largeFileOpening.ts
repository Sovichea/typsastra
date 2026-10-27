import { fileExtension, isBinaryImagePath, isSupportedInAppPath } from "../platform/fileTypes";

export const LARGE_TEXT_FILE_BYTES = 512 * 1024;
export const LARGE_TEXT_FILE_LINES = 10_000;
export const LARGE_PDF_FILE_BYTES = 20 * 1024 * 1024;

export type LargeFileOpeningNotice = {
  kind: "text" | "pdf" | "main-preview";
  sizeBytes: number;
  lineCount?: number;
  previewRootPath?: string;
  previewSourceFiles?: number;
};

export function largeFileOpeningNotice(path: string, sizeBytes: number, lineCount?: number): LargeFileOpeningNotice | null {
  if (!Number.isFinite(sizeBytes) || sizeBytes < 0) return null;
  if (fileExtension(path) === "pdf") {
    return sizeBytes >= LARGE_PDF_FILE_BYTES ? { kind: "pdf", sizeBytes } : null;
  }
  const isText = isSupportedInAppPath(path) && !isBinaryImagePath(path);
  if (!isText || (sizeBytes < LARGE_TEXT_FILE_BYTES && (lineCount ?? 0) < LARGE_TEXT_FILE_LINES)) return null;
  return lineCount === undefined
    ? { kind: "text", sizeBytes }
    : { kind: "text", sizeBytes, lineCount };
}

export function largeMainPreviewOpeningNotice(
  previewRootPath: string,
  sizeBytes: number,
  lineCount?: number,
  previewSourceFiles?: number,
): LargeFileOpeningNotice | null {
  if (fileExtension(previewRootPath) !== "typ") return null;
  const sourceNotice = largeFileOpeningNotice(previewRootPath, sizeBytes, lineCount);
  if (sourceNotice?.kind !== "text") return null;
  return {
    kind: "main-preview",
    sizeBytes: sourceNotice.sizeBytes,
    lineCount: sourceNotice.lineCount,
    previewRootPath,
    previewSourceFiles,
  };
}

export function formatFileSize(sizeBytes: number): string {
  const mib = sizeBytes / 1024 / 1024;
  if (mib >= 10) return `${mib.toFixed(0)} MB`;
  if (mib >= 1) return `${mib.toFixed(1)} MB`;
  return `${Math.max(1, Math.round(sizeBytes / 1024))} KB`;
}

/** Only reuse a bounded prefix when it contains the complete UTF-8 file. */
export function completeSourcePrefix(prefix: string, sizeBytes: number): { content: string; lineCount: number } | null {
  if (new TextEncoder().encode(prefix).length !== sizeBytes) return null;
  let lineCount = 0;
  for (let index = 0; index < prefix.length; index++) {
    if (prefix.charCodeAt(index) === 10) lineCount++;
  }
  if (prefix.length > 0 && !prefix.endsWith("\n")) lineCount++;
  return { content: prefix, lineCount };
}
