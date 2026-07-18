import { fileExtension, isBinaryImagePath, isSupportedInAppPath } from "../platform/fileTypes";

export const LARGE_TEXT_FILE_BYTES = 512 * 1024;
export const LARGE_TEXT_FILE_LINES = 10_000;
export const LARGE_PDF_FILE_BYTES = 20 * 1024 * 1024;

export type LargeFileOpeningNotice = {
  kind: "text" | "pdf";
  sizeBytes: number;
  lineCount?: number;
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

export function formatFileSize(sizeBytes: number): string {
  const mib = sizeBytes / 1024 / 1024;
  if (mib >= 10) return `${mib.toFixed(0)} MB`;
  if (mib >= 1) return `${mib.toFixed(1)} MB`;
  return `${Math.max(1, Math.round(sizeBytes / 1024))} KB`;
}
