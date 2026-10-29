export type TextDiffLineType = "context" | "add" | "remove";

export type TextDiffLine = {
  type: TextDiffLineType;
  text: string;
  oldLine: number | null;
  newLine: number | null;
};

export type TextDiffHunk = {
  header: string;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: TextDiffLine[];
};

export type TextDiffResult = {
  hunks: TextDiffHunk[];
  truncated: boolean;
  totalLines: number;
  shownLines: number;
  lineEndingOnly: boolean;
};

export type TextDiffSegment = {
  text: string;
  changed: boolean;
};

export type TextDiffSide = {
  text: string;
  line: number | null;
  segments: TextDiffSegment[];
};

export type TextDiffRow = {
  type: "context" | "change";
  old: TextDiffSide;
  new: TextDiffSide;
};

const MAX_TOKEN_DIFF_CELLS = 200_000;

function tokenize(value: string): string[] {
  return value.match(/\s+|\S+/g) ?? [];
}

function mergedSegments(tokens: readonly string[], changed: readonly boolean[]): TextDiffSegment[] {
  const segments: TextDiffSegment[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const previous = segments[segments.length - 1];
    if (previous && previous.changed === changed[index]) {
      previous.text += tokens[index];
    } else {
      segments.push({ text: tokens[index], changed: changed[index] });
    }
  }
  return segments;
}

/** Word-level highlight used when split-view lines are paired. */
export function diffLineSegments(
  oldLine: string,
  newLine: string,
): { old: TextDiffSegment[]; new: TextDiffSegment[] } {
  const oldTokens = tokenize(oldLine);
  const newTokens = tokenize(newLine);
  const oldChanged = oldTokens.map(() => false);
  const newChanged = newTokens.map(() => false);
  if (oldTokens.length * newTokens.length <= MAX_TOKEN_DIFF_CELLS) {
    const width = newTokens.length + 1;
    const table = new Uint32Array((oldTokens.length + 1) * width);
    for (let oldIndex = oldTokens.length - 1; oldIndex >= 0; oldIndex -= 1) {
      for (let newIndex = newTokens.length - 1; newIndex >= 0; newIndex -= 1) {
        const cell = oldIndex * width + newIndex;
        table[cell] = oldTokens[oldIndex] === newTokens[newIndex]
          ? table[(oldIndex + 1) * width + newIndex + 1] + 1
          : Math.max(table[(oldIndex + 1) * width + newIndex], table[oldIndex * width + newIndex + 1]);
      }
    }
    let oldIndex = 0;
    let newIndex = 0;
    while (oldIndex < oldTokens.length && newIndex < newTokens.length) {
      if (oldTokens[oldIndex] === newTokens[newIndex]) {
        oldIndex += 1;
        newIndex += 1;
      } else if (
        table[(oldIndex + 1) * width + newIndex]
        >= table[oldIndex * width + newIndex + 1]
      ) {
        oldChanged[oldIndex] = true;
        oldIndex += 1;
      } else {
        newChanged[newIndex] = true;
        newIndex += 1;
      }
    }
    while (oldIndex < oldTokens.length) oldChanged[oldIndex++] = true;
    while (newIndex < newTokens.length) newChanged[newIndex++] = true;
  } else {
    let prefix = 0;
    while (
      prefix < oldTokens.length
      && prefix < newTokens.length
      && oldTokens[prefix] === newTokens[prefix]
    ) prefix += 1;
    let suffix = 0;
    while (
      suffix < oldTokens.length - prefix
      && suffix < newTokens.length - prefix
      && oldTokens[oldTokens.length - 1 - suffix] === newTokens[newTokens.length - 1 - suffix]
    ) suffix += 1;
    for (let index = prefix; index < oldTokens.length - suffix; index += 1) {
      oldChanged[index] = true;
    }
    for (let index = prefix; index < newTokens.length - suffix; index += 1) {
      newChanged[index] = true;
    }
  }
  return {
    old: mergedSegments(oldTokens, oldChanged),
    new: mergedSegments(newTokens, newChanged),
  };
}

function side(
  line: TextDiffLine | null,
  segments?: TextDiffSegment[],
): TextDiffSide {
  return line === null
    ? { text: "", line: null, segments: [] }
    : {
      text: line.text,
      line: line.type === "add" ? line.newLine : line.oldLine,
      segments: segments ?? [{ text: line.text, changed: line.type !== "context" }],
    };
}

/** Pair removals and additions so the split view has aligned columns. */
export function splitDiffHunk(hunk: TextDiffHunk): TextDiffRow[] {
  const rows: TextDiffRow[] = [];
  let index = 0;
  while (index < hunk.lines.length) {
    const line = hunk.lines[index];
    if (line.type === "context") {
      rows.push({
        type: "context",
        old: side(line, [{ text: line.text, changed: false }]),
        new: side(line, [{ text: line.text, changed: false }]),
      });
      index += 1;
      continue;
    }
    const removes: TextDiffLine[] = [];
    const adds: TextDiffLine[] = [];
    while (index < hunk.lines.length && hunk.lines[index].type !== "context") {
      const changedLine = hunk.lines[index];
      if (changedLine.type === "remove") removes.push(changedLine);
      else adds.push(changedLine);
      index += 1;
    }
    const count = Math.max(removes.length, adds.length);
    for (let pair = 0; pair < count; pair += 1) {
      const oldLine = removes[pair] ?? null;
      const newLine = adds[pair] ?? null;
      const highlighted = oldLine && newLine
        ? diffLineSegments(oldLine.text, newLine.text)
        : null;
      rows.push({
        type: "change",
        old: side(oldLine, highlighted?.old),
        new: side(newLine, highlighted?.new),
      });
    }
  }
  return rows;
}

type TextDiffOptions = {
  context?: number;
  maxLines?: number;
};

const MAX_LCS_CELLS = 1_500_000;

function splitLines(text: string): string[] {
  const normalized = text.replace(/\r\n?/g, "\n");
  return normalized === "" ? [] : normalized.split("\n");
}

function contextLine(text: string, oldLine: number, newLine: number): TextDiffLine {
  return { type: "context", text, oldLine, newLine };
}

function middleDiff(
  oldLines: readonly string[],
  newLines: readonly string[],
  oldOffset: number,
  newOffset: number,
): TextDiffLine[] {
  const n = oldLines.length;
  const m = newLines.length;
  if (n === 0 && m === 0) return [];
  if (n === 0) {
    return newLines.map((text, index) => ({
      type: "add",
      text,
      oldLine: null,
      newLine: newOffset + index,
    }));
  }
  if (m === 0) {
    return oldLines.map((text, index) => ({
      type: "remove",
      text,
      oldLine: oldOffset + index,
      newLine: null,
    }));
  }

  if (n * m > MAX_LCS_CELLS) {
    return [
      ...oldLines.map((text, index) => ({
        type: "remove" as const,
        text,
        oldLine: oldOffset + index,
        newLine: null,
      })),
      ...newLines.map((text, index) => ({
        type: "add" as const,
        text,
        oldLine: null,
        newLine: newOffset + index,
      })),
    ];
  }

  const width = m + 1;
  const table = new Uint32Array((n + 1) * width);
  for (let oldIndex = n - 1; oldIndex >= 0; oldIndex -= 1) {
    for (let newIndex = m - 1; newIndex >= 0; newIndex -= 1) {
      const cell = oldIndex * width + newIndex;
      table[cell] = oldLines[oldIndex] === newLines[newIndex]
        ? table[(oldIndex + 1) * width + newIndex + 1] + 1
        : Math.max(table[(oldIndex + 1) * width + newIndex], table[oldIndex * width + newIndex + 1]);
    }
  }

  const result: TextDiffLine[] = [];
  let oldIndex = 0;
  let newIndex = 0;
  while (oldIndex < n && newIndex < m) {
    if (oldLines[oldIndex] === newLines[newIndex]) {
      result.push(contextLine(
        oldLines[oldIndex],
        oldOffset + oldIndex,
        newOffset + newIndex,
      ));
      oldIndex += 1;
      newIndex += 1;
    } else if (
      table[(oldIndex + 1) * width + newIndex]
      >= table[oldIndex * width + newIndex + 1]
    ) {
      result.push({
        type: "remove",
        text: oldLines[oldIndex],
        oldLine: oldOffset + oldIndex,
        newLine: null,
      });
      oldIndex += 1;
    } else {
      result.push({
        type: "add",
        text: newLines[newIndex],
        oldLine: null,
        newLine: newOffset + newIndex,
      });
      newIndex += 1;
    }
  }
  while (oldIndex < n) {
    result.push({
      type: "remove",
      text: oldLines[oldIndex],
      oldLine: oldOffset + oldIndex,
      newLine: null,
    });
    oldIndex += 1;
  }
  while (newIndex < m) {
    result.push({
      type: "add",
      text: newLines[newIndex],
      oldLine: null,
      newLine: newOffset + newIndex,
    });
    newIndex += 1;
  }
  return result;
}

export function createUnifiedTextDiff(
  oldText: string,
  newText: string,
  options: TextDiffOptions = {},
): TextDiffResult {
  const context = Math.max(0, options.context ?? 3);
  const maxLines = Math.max(1, options.maxLines ?? 3_000);
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  const lineEndingOnly = oldText !== newText
    && oldLines.join("\n") === newLines.join("\n");

  let prefix = 0;
  while (
    prefix < oldLines.length
    && prefix < newLines.length
    && oldLines[prefix] === newLines[prefix]
  ) prefix += 1;

  let suffix = 0;
  while (
    suffix < oldLines.length - prefix
    && suffix < newLines.length - prefix
    && oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) suffix += 1;

  const ops: TextDiffLine[] = [];
  for (let index = 0; index < prefix; index += 1) {
    ops.push(contextLine(oldLines[index], index + 1, index + 1));
  }
  ops.push(...middleDiff(
    oldLines.slice(prefix, oldLines.length - suffix),
    newLines.slice(prefix, newLines.length - suffix),
    prefix + 1,
    prefix + 1,
  ));
  for (let index = suffix; index > 0; index -= 1) {
    const oldLine = oldLines.length - index + 1;
    const newLine = newLines.length - index + 1;
    ops.push(contextLine(oldLines[oldLine - 1], oldLine, newLine));
  }

  const changed = ops
    .map((line, index) => line.type === "context" ? -1 : index)
    .filter(index => index >= 0);
  if (changed.length === 0) {
    return {
      hunks: [],
      truncated: false,
      totalLines: 0,
      shownLines: 0,
      lineEndingOnly,
    };
  }

  const ranges: Array<{ start: number; end: number }> = [];
  for (const index of changed) {
    const start = Math.max(0, index - context);
    const end = Math.min(ops.length, index + context + 1);
    const last = ranges[ranges.length - 1];
    if (last && start <= last.end) {
      last.end = Math.max(last.end, end);
    } else {
      ranges.push({ start, end });
    }
  }

  const hunks: TextDiffHunk[] = [];
  let shownLines = 0;
  let totalLines = 0;
  let truncated = false;
  for (const range of ranges) {
    const lines = ops.slice(range.start, range.end);
    const oldBefore = ops.slice(0, range.start).filter(line => line.type !== "add").length;
    const newBefore = ops.slice(0, range.start).filter(line => line.type !== "remove").length;
    totalLines += lines.length;
    if (shownLines >= maxLines) {
      truncated = true;
      break;
    }
    const remaining = maxLines - shownLines;
    const visible = lines.length > remaining ? lines.slice(0, remaining) : lines;
    if (visible.length < lines.length) truncated = true;
    const oldCount = visible.filter(line => line.type !== "add").length;
    const newCount = visible.filter(line => line.type !== "remove").length;
    const oldStart = oldCount === 0 ? oldBefore : oldBefore + 1;
    const newStart = newCount === 0 ? newBefore : newBefore + 1;
    hunks.push({
      header: `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`,
      oldStart,
      oldCount,
      newStart,
      newCount,
      lines: visible,
    });
    shownLines += visible.length;
    if (truncated) break;
  }
  if (!truncated) truncated = shownLines < totalLines;

  return {
    hunks,
    truncated,
    totalLines,
    shownLines,
    lineEndingOnly,
  };
}
