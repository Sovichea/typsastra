/**
 * Extracts cell contents from a managed table block that our generator emitted.
 * This is intentionally scoped to our own shape (`#table(columns: …, …)` with
 * `[…]` cells, `table.header/footer/cell` containers and `table.hline/vline`
 * lines); it never tries to understand arbitrary user Typst.
 */

function skipString(text: string, index: number): number {
  for (let i = index + 1; i < text.length; i += 1) {
    if (text[i] === "\\") {
      i += 1;
      continue;
    }
    if (text[i] === '"') return i + 1;
  }
  return text.length;
}

function skipRaw(text: string, index: number): number {
  let run = 0;
  while (text[index + run] === "`") run += 1;
  const closer = "`".repeat(run);
  const end = text.indexOf(closer, index + run);
  return end === -1 ? text.length : end + run;
}

function skipMath(text: string, index: number): number {
  let run = 0;
  while (text[index + run] === "$") run += 1;
  const closer = "$".repeat(run);
  for (let i = index + run; i < text.length; i += 1) {
    if (text[i] === "\\") {
      i += 1;
      continue;
    }
    if (text.startsWith(closer, i)) return i + run;
  }
  return text.length;
}

function skipLineComment(text: string, index: number): number {
  const end = text.indexOf("\n", index);
  return end === -1 ? text.length : end + 1;
}

/** Skips strings, raw spans, math, escapes, and comments; -1 when not one. */
function skipInstrument(text: string, index: number): number {
  const character = text[index];
  if (character === "\\") return Math.min(index + 2, text.length);
  if (character === '"') return skipString(text, index);
  if (character === "`") return skipRaw(text, index);
  if (character === "$") return skipMath(text, index);
  if (character === "/" && text[index + 1] === "/") return skipLineComment(text, index);
  return -1;
}

/** Index of the `]` matching the `[` at `openIndex`, or -1. */
function matchBracket(text: string, openIndex: number): number {
  let depth = 0;
  for (let i = openIndex; i < text.length;) {
    const skip = skipInstrument(text, i);
    if (skip !== -1) {
      i = skip;
      continue;
    }
    const character = text[i];
    if (character === "[") depth += 1;
    else if (character === "]") {
      depth -= 1;
      if (depth === 0) return i;
    }
    i += 1;
  }
  return -1;
}

/** Index of the `)` matching the `(` at `openIndex`, skipping `[…]` blocks. */
function matchParen(text: string, openIndex: number): number {
  let depth = 0;
  for (let i = openIndex; i < text.length;) {
    const skip = skipInstrument(text, i);
    if (skip !== -1) {
      i = skip;
      continue;
    }
    const character = text[i];
    if (character === "(") depth += 1;
    else if (character === ")") {
      depth -= 1;
      if (depth === 0) return i;
    } else if (character === "[") {
      const end = matchBracket(text, i);
      if (end === -1) return -1;
      i = end + 1;
      continue;
    }
    i += 1;
  }
  return -1;
}

function nextNonSpace(text: string, index: number, limit: number): number {
  for (let i = index; i < limit; i += 1) {
    if (!/\s/u.test(text[i])) return i;
  }
  return -1;
}

/** Splits `[start, end)` on top-level commas (ignoring nested constructs). */
function splitTopLevel(text: string, start: number, end: number): Array<[number, number]> {
  const items: Array<[number, number]> = [];
  let itemStart = start;
  for (let i = start; i < end;) {
    const skip = skipInstrument(text, i);
    if (skip !== -1) {
      i = skip;
      continue;
    }
    const character = text[i];
    if (character === "[") {
      const close = matchBracket(text, i);
      if (close === -1) return [];
      i = close + 1;
      continue;
    }
    if (character === "(") {
      const close = matchParen(text, i);
      if (close === -1) return [];
      i = close + 1;
      continue;
    }
    if (character === ",") {
      items.push([itemStart, i]);
      itemStart = i + 1;
    }
    i += 1;
  }
  if (itemStart < end) items.push([itemStart, end]);
  return items;
}

function collectCells(text: string, start: number, end: number, out: string[]): boolean {
  for (const [from, to] of splitTopLevel(text, start, end)) {
    const item = text.slice(from, to).trim();
    if (item === "") continue;
    if (item.startsWith("..")) return false; // data-driven body: not editable here
    if (item.startsWith("table.hline") || item.startsWith("table.vline")) continue;
    if (item.startsWith("table.header") || item.startsWith("table.footer")) {
      const open = text.indexOf("(", from);
      if (open === -1 || open >= to) return false;
      const close = matchParen(text, open);
      if (close === -1 || close > to) return false;
      if (!collectCells(text, open + 1, close, out)) return false;
      continue;
    }
    if (item.startsWith("table.cell")) {
      const open = text.indexOf("(", from);
      if (open === -1 || open >= to) return false;
      const close = matchParen(text, open);
      if (close === -1 || close > to) return false;
      const bracket = nextNonSpace(text, close + 1, to);
      if (bracket === -1 || text[bracket] !== "[") return false;
      const end_ = matchBracket(text, bracket);
      if (end_ === -1 || end_ > to) return false;
      out.push(text.slice(bracket + 1, end_).trim());
      continue;
    }
    if (item.startsWith("[")) {
      const bracket = nextNonSpace(text, from, to);
      const close = matchBracket(text, bracket);
      if (close === -1) return false;
      out.push(text.slice(bracket + 1, close).trim());
      continue;
    }
    // Named arguments (columns:, stroke:, …) are ignored.
  }
  return true;
}

/**
 * Cell contents of a generated table, in emission order (header rows, body
 * rows, footer). Returns null when the source is not a recognisable table or
 * uses a data-driven body.
 */
export function extractTableCells(code: string): string[] | null {
  const match = /(^|[^\w.])table\s*\(/u.exec(code);
  if (!match) return null;
  const open = match.index + match[0].length - 1;
  const close = matchParen(code, open);
  if (close === -1) return null;
  const cells: string[] = [];
  if (!collectCells(code, open + 1, close, cells)) return null;
  return cells;
}
