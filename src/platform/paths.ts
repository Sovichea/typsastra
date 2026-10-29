function encodePath(path: string): string {
  return path
    .split("/")
    .map((part, index) => index === 0 && /^[A-Za-z]:$/.test(part) ? part : encodeURIComponent(part))
    .join("/");
}

export function filePathToUri(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const uncMatch = normalized.match(/^\/\/([^/]+)(\/.*)?$/);
  if (uncMatch) {
    return `file://${uncMatch[1]}${encodePath(uncMatch[2] ?? "/")}`;
  }
  if (/^[A-Za-z]:\//.test(normalized)) {
    const capitalized = normalized.charAt(0).toUpperCase() + normalized.slice(1);
    return `file:///${encodePath(capitalized)}`;
  }
  if (normalized.startsWith("/")) {
    return `file://${encodePath(normalized)}`;
  }
  return `file:///${encodePath(normalized)}`;
}

export function filePathFromUri(uri: string): string {
  if (!uri.startsWith("file://")) return uri;

  const parsed = new URL(uri);
  const pathname = decodeURIComponent(parsed.pathname);
  if (parsed.hostname) {
    return `//${parsed.hostname}${pathname}`;
  }
  return /^\/[A-Za-z]:\//.test(pathname) ? pathname.slice(1) : pathname;
}

export const UNTITLED_DOCUMENT_PATH_PREFIX = "untitled:";

export function untitledDocumentPath(id: string): string {
  return `${UNTITLED_DOCUMENT_PATH_PREFIX}${id}.typ`;
}

export function isUntitledDocumentPath(path: string): boolean {
  return path.startsWith(UNTITLED_DOCUMENT_PATH_PREFIX);
}

export function filePathKey(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/$/, "");
  const isWindowsPath = /^[A-Za-z]:\//.test(normalized) || normalized.startsWith("//");
  return isWindowsPath ? normalized.toLowerCase() : normalized;
}

export function nativeFilePath(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  if (/^[A-Za-z]:\//.test(normalized) || normalized.startsWith("//")) {
    return normalized.replace(/\//g, "\\");
  }
  return normalized;
}

export function fileNameFromPath(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || path;
}

export function relativeFilePath(root: string, path: string): string | null {
  const normalizedRoot = root.replace(/\\/g, "/").replace(/\/$/, "");
  const normalizedPath = path.replace(/\\/g, "/");
  const rootKey = filePathKey(normalizedRoot);
  const pathKey = filePathKey(normalizedPath);
  if (pathKey === rootKey) return "";
  if (!pathKey.startsWith(`${rootKey}/`)) return null;
  return normalizedPath.slice(normalizedRoot.length + 1);
}

/** Remap a path when a file or one of its parent directories is renamed. */
export function remapFilePath(path: string, oldPath: string, newPath: string): string {
  const relative = relativeFilePath(oldPath, path);
  if (relative === null) return path;
  if (relative === "") return newPath;

  const separator = newPath.includes("\\") && !newPath.includes("/") ? "\\" : "/";
  const base = newPath.replace(/[\\/]+$/, "");
  return `${base}${separator}${relative.replace(/[\\/]/g, separator)}`;
}
