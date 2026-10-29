import type { EditorTab } from "../editor/editorTab";
import { fileExtension, isBinaryImagePath } from "../platform/fileTypes";
import { filePathKey } from "../platform/paths";

export function recoveryDocumentId(workspaceRoot: string | null, path: string): string {
  const root = workspaceRoot ? filePathKey(workspaceRoot) : "";
  return `file:${root}::${filePathKey(path)}`;
}

export function canRecoverTab(tab: EditorTab): boolean {
  if (
    !tab.path
    || !tab.contentLoaded
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
