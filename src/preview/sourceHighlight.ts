export function findPreviewTextMatchInSourceLine(
  sourceLine: string,
  previewText: string,
  previewOffset: number
): { sourceOffset: number } | null {
  const text = previewText.replace(/\s+/g, " ");
  const offset = Math.max(0, Math.min(previewOffset, text.length));
  const sourceLineForSearch = sourceLine.replace(/\s+/g, " ");

  const direct = findPreviewSnippetInSourceLine(sourceLineForSearch, text, offset);
  if (direct) return direct;

  const before = text.slice(Math.max(0, offset - 24), offset).trimStart();
  const after = text.slice(offset, Math.min(text.length, offset + 48)).trimEnd();
  const around = `${before}${after}`;
  return findPreviewSnippetInSourceLine(sourceLineForSearch, around, Math.min(before.length, around.length));
}

function findPreviewSnippetInSourceLine(sourceLine: string, snippet: string, snippetOffset: number): { sourceOffset: number } | null {
  const trimmedSnippet = snippet.trim();
  if (trimmedSnippet.length < 2) return null;

  let index = sourceLine.indexOf(trimmedSnippet);
  if (index !== -1) {
    const leadingTrim = snippet.length - snippet.trimStart().length;
    return { sourceOffset: index + Math.max(0, snippetOffset - leadingTrim) };
  }

  for (let size = Math.min(32, trimmedSnippet.length); size >= 3; size--) {
    const start = Math.max(0, Math.min(snippetOffset, trimmedSnippet.length) - Math.floor(size / 2));
    const probe = trimmedSnippet.slice(start, start + size);
    if (probe.length < 3) continue;
    index = sourceLine.indexOf(probe);
    if (index !== -1) return { sourceOffset: index + Math.floor(probe.length / 2) };
  }

  return null;
}
