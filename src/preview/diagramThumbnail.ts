const PADDING_RATIO = 0.15;
const MIN_PADDING = 8;
const MAX_PADDING = 32;

/**
 * Adds breathing room around a cached diagram SVG for the hover preview.
 *
 * Diagram measurements intentionally use the exact content bounds. Fletcher
 * arrowheads and labels can paint outside those bounds, so the hover preview
 * expands the SVG viewBox without changing the cached measurement.
 */
export function padDiagramThumbnailSvg(bytes: Uint8Array): Uint8Array {
  const text = new TextDecoder().decode(bytes);
  const rootMatch = /<svg\b[^>]*>/i.exec(text);
  if (!rootMatch) return bytes;
  const root = rootMatch[0];
  const viewBoxMatch = /\bviewBox=(["'])(.*?)\1/i.exec(root);
  if (!viewBoxMatch) return bytes;
  const values = viewBoxMatch[2].trim().split(/[\s,]+/).map(Number);
  if (values.length !== 4 || values.some(value => !Number.isFinite(value))) return bytes;
  const [minX, minY, width, height] = values;
  if (width <= 0 || height <= 0) return bytes;

  const padding = Math.min(
    MAX_PADDING,
    Math.max(MIN_PADDING, Math.min(width, height) * PADDING_RATIO)
  );
  const nextWidth = width + padding * 2;
  const nextHeight = height + padding * 2;
  const nextViewBox = [
    minX - padding,
    minY - padding,
    nextWidth,
    nextHeight
  ].map(formatNumber).join(" ");
  const nextRoot = root
    .replace(/\s+width=(["']).*?\1/gi, "")
    .replace(/\s+height=(["']).*?\1/gi, "")
    .replace(/\bviewBox=(["']).*?\1/i, `viewBox="${nextViewBox}"`)
    .replace(/\s*>$/, ` width="${formatNumber(nextWidth)}pt" height="${formatNumber(nextHeight)}pt">`);

  return new TextEncoder().encode(
    text.slice(0, rootMatch.index) + nextRoot + text.slice(rootMatch.index + root.length)
  );
}

function formatNumber(value: number): string {
  return Number(value.toFixed(4)).toString();
}
