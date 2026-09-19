export type TypstPackageReference = {
  namespace: "preview" | "local";
  name: string;
  version: string;
  spec: string;
};

export type TypstSourceLocation = {
  filePath: string;
  line: number;
  column: number;
};

export type TypstPackageImport = TypstSourceLocation & {
  package: TypstPackageReference;
};

export type PreviewCompilerFailure = {
  message: string;
  location: TypstSourceLocation | null;
  package: TypstPackageReference | null;
  packageCacheRoot: string | null;
};

export type PreviewCompilerDiagnosticFrame = TypstSourceLocation & {
  kind: "primary" | "help" | "note";
  label: string | null;
  snippet: string;
};

export type PreviewCompilerDiagnostic = {
  summary: string;
  frames: PreviewCompilerDiagnosticFrame[];
  notes: string[];
  raw: string;
};

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/**
 * Preserve structured Tauri/LSP failures for UI and developer logs.
 *
 * `String(error)` turns Tauri command rejections into `[object Object]`, which
 * hides the only useful part of a failed background operation.
 */
export function previewErrorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  const value = record(error);
  const message = typeof value?.message === "string" ? value.message : "";
  const data = value?.data;
  const detail = typeof data === "string"
    ? data
    : data === undefined
      ? ""
      : JSON.stringify(data, null, 2);
  if (message && detail && detail !== message) return `${message}\n\n${detail}`;
  if (message || detail) return message || detail;
  try {
    return JSON.stringify(error, null, 2);
  } catch {
    return String(error);
  }
}

/** Decode the Rust debug-string form used for non-ASCII path characters. */
export function decodeRustUnicodeEscapes(value: string): string {
  return value.replace(/\\u\{([0-9a-fA-F]{1,6})\}/g, (match, digits: string) => {
    const codePoint = Number.parseInt(digits, 16);
    if (!Number.isFinite(codePoint) || codePoint > 0x10ffff) return match;
    try { return String.fromCodePoint(codePoint); } catch { return match; }
  });
}

function unwrapTinymistExportMessage(message: string): string {
  const clean = message.replace(/\u001b\[[0-9;]*m/g, "").trim();
  const marker = "document is not available for export:";
  const markerIndex = clean.indexOf(marker);
  if (markerIndex < 0) return decodeRustUnicodeEscapes(clean);
  const wrapped = clean.slice(markerIndex + marker.length).trim();
  if (wrapped.startsWith('"') && wrapped.endsWith('"')) {
    try {
      const parsed = JSON.parse(wrapped);
      if (typeof parsed === "string" && parsed.trim()) return decodeRustUnicodeEscapes(parsed.trim());
    } catch {
      return decodeRustUnicodeEscapes(wrapped.slice(1, -1).replace(/\\n/g, "\n").replace(/\\"/g, '"').trim());
    }
  }
  return decodeRustUnicodeEscapes(wrapped || clean);
}

export function parseTypstPackageReference(spec: string): TypstPackageReference | null {
  const match = /^@(preview|local)\/([^:/"']+):([^/"']+)$/.exec(spec.trim());
  if (!match) return null;
  return {
    namespace: match[1] as "preview" | "local",
    name: match[2],
    version: match[3],
    spec: `@${match[1]}/${match[2]}:${match[3]}`
  };
}

export function typstPackageImports(source: string, filePath: string): TypstPackageImport[] {
  const imports: TypstPackageImport[] = [];
  const expression = /\bimport\s+["'](@(?:preview|local)\/[^:"']+:[^"']+)["']/g;
  for (const match of source.matchAll(expression)) {
    const packageReference = parseTypstPackageReference(match[1]);
    if (!packageReference || match.index === undefined) continue;
    const prefix = source.slice(0, match.index);
    const lineStart = prefix.lastIndexOf("\n") + 1;
    imports.push({
      package: packageReference,
      filePath,
      line: prefix.split("\n").length,
      column: match.index - lineStart + 1
    });
  }
  return imports;
}

export function parsePreviewCompilerFailure(error: unknown): PreviewCompilerFailure {
  const message = unwrapTinymistExportMessage(previewErrorText(error));
  const locationMatch = /^[ \t]*[^\r\n]*?((?:[A-Za-z]:[\\/]|\/)[^\r\n]+):(\d+):(\d+)[ \t]*$/m.exec(message);
  const location = locationMatch
    ? {
        filePath: locationMatch[1].trim(),
        line: Number(locationMatch[2]),
        column: Number(locationMatch[3])
      }
    : null;
  const packageMatch = location?.filePath.match(
    /^(.*?[\\/]typst[\\/]packages)[\\/](preview|local)[\\/]([^\\/]+)[\\/]([^\\/]+)(?:[\\/]|$)/i
  ) ?? null;
  const packageReference = packageMatch
    ? parseTypstPackageReference(`@${packageMatch[2].toLowerCase()}/${packageMatch[3]}:${packageMatch[4]}`)
    : null;
  return {
    message,
    location,
    package: packageReference,
    packageCacheRoot: packageMatch?.[1] ?? null
  };
}

export function relocatePreviewCompilerFailureMessage(
  failure: PreviewCompilerFailure,
  displayedFilePath: string,
): string {
  if (!failure.location || failure.location.filePath === displayedFilePath) return failure.message;
  return failure.message.split(failure.location.filePath).join(displayedFilePath);
}

/** Relocate every source location in a compiler message, including call traces. */
export function relocatePreviewCompilerFailurePaths(
  message: string,
  relocatePath: (filePath: string) => string,
): string {
  return decodeRustUnicodeEscapes(message).replace(
    /((?:[A-Za-z]:[\\/]|\/)[^\r\n]*?)(?=:\d+:\d+(?:\s|$))/g,
    filePath => relocatePath(filePath.trim()),
  );
}

/** Split Typst's terminal-style diagnostic into readable source frames. */
export function parsePreviewCompilerDiagnostic(message: string): PreviewCompilerDiagnostic | null {
  const raw = decodeRustUnicodeEscapes(message).trim();
  const lines = raw.split(/\r?\n/);
  const pattern = /((?:[A-Za-z]:[\\/]|\/).+):(\d+):(\d+)\s*$/;
  const locations: Array<TypstSourceLocation & { index: number }> = [];
  lines.forEach((line, index) => {
    const match = pattern.exec(line);
    if (match) locations.push({ index, filePath: match[1].trim(), line: Number(match[2]), column: Number(match[3]) });
  });
  if (locations.length === 0) return null;

  const summary = lines.slice(0, locations[0].index).map(line => line.trim()).filter(Boolean)
    .join(" ").replace(/^error:\s*/i, "") || "Compilation failed";
  const frames: PreviewCompilerDiagnosticFrame[] = [];
  const notes: string[] = [];
  locations.forEach((location, index) => {
    const previousLocationLine = locations[index - 1]?.index ?? -1;
    let labelLine = location.index - 1;
    while (labelLine > previousLocationLine && !lines[labelLine].trim()) labelLine -= 1;
    const labelMatch = /^(help|note):\s*(.+)$/i.exec(lines[labelLine]?.trim() ?? "");
    const kind: PreviewCompilerDiagnosticFrame["kind"] = labelMatch?.[1].toLowerCase() === "help"
      ? "help" : labelMatch?.[1].toLowerCase() === "note" ? "note" : "primary";
    let bodyEnd = locations[index + 1]?.index ?? lines.length;
    if (index + 1 < locations.length) {
      let candidate = bodyEnd - 1;
      while (candidate > location.index && !lines[candidate].trim()) candidate -= 1;
      if (/^(help|note):/i.test(lines[candidate]?.trim() ?? "")) bodyEnd = candidate;
    }
    const body = lines.slice(location.index + 1, bodyEnd);
    while (body.length && (!body[0].trim() || /^[│|]+$/u.test(body[0].trim()))) body.shift();
    while (body.length && !body[body.length - 1].trim()) body.pop();
    const hintIndex = body.findIndex(line => /^Package compatibility hint\s*$/i.test(line.trim()));
    if (hintIndex >= 0) {
      const hint = body.splice(hintIndex).map(line => line.trim()).filter(Boolean).join("\n");
      if (hint) notes.push(hint);
    }
    frames.push({
      kind,
      label: labelMatch?.[2] ?? null,
      filePath: location.filePath,
      line: location.line,
      column: location.column,
      snippet: body.join("\n"),
    });
  });
  return { summary, frames, notes, raw };
}

export function typstPackageEntrypoint(manifest: string): string | null {
  return /^\s*entrypoint\s*=\s*["']([^"']+)["']\s*$/m.exec(manifest)?.[1] ?? null;
}
