import type { EditorTab } from "../editor/editorTab";
import { fileExtension, isBinaryImagePath } from "../platform/fileTypes";
import { fileNameFromPath, filePathKey } from "../platform/paths";

export const UNTITLED_RECOVERY_DOCUMENT_PREFIX = "untitled:";

export function recoveryDocumentId(workspaceRoot: string | null, path: string): string {
  const root = workspaceRoot ? filePathKey(workspaceRoot) : "";
  return `file:${root}::${filePathKey(path)}`;
}

export function recoveryDocumentIdForTab(
  workspaceRoot: string | null,
  tab: Pick<EditorTab, "path" | "untitled" | "untitledId">,
): string {
  const untitledId = tab.untitledId?.trim();
  if (tab.untitled && untitledId) {
    return `${UNTITLED_RECOVERY_DOCUMENT_PREFIX}${untitledId}`;
  }
  return recoveryDocumentId(workspaceRoot, tab.path);
}

export function untitledIdFromRecoveryDocumentId(documentId: string): string | null {
  if (!documentId.startsWith(UNTITLED_RECOVERY_DOCUMENT_PREFIX)) return null;
  const id = documentId.slice(UNTITLED_RECOVERY_DOCUMENT_PREFIX.length).trim();
  return id || null;
}

export function recoveryTabName(tab: Pick<EditorTab, "path" | "title">): string {
  return tab.title?.trim() || fileNameFromPath(tab.path) || "Untitled";
}

export function canRecoverTab(tab: EditorTab): boolean {
  if (!tab.contentLoaded) return false;
  if (tab.untitled) return true;
  if (
    !tab.path
    || isBinaryImagePath(tab.path)
    || fileExtension(tab.path) === "pdf"
  ) {
    return false;
  }
  return true;
}

export async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join("");
}
