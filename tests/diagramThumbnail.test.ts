import { describe, expect, test } from "bun:test";
import { padDiagramThumbnailSvg } from "../src/preview/diagramThumbnail";

const encode = (value: string) => new TextEncoder().encode(value);
const decode = (value: Uint8Array) => new TextDecoder().decode(value);

describe("Draft diagram thumbnail padding", () => {
  test("expands the viewBox and intrinsic size", () => {
    const source =
      '<svg viewBox="0 0 100 50" width="100pt" height="50pt" xmlns="http://www.w3.org/2000/svg"><path d="M 0 0 L 100 50"/></svg>';
    const padded = decode(padDiagramThumbnailSvg(encode(source)));
    expect(padded).toContain('viewBox="-8 -8 116 66"');
    expect(padded).toContain('width="116pt"');
    expect(padded).toContain('height="66pt"');
    expect(padded).toContain('<path d="M 0 0 L 100 50"/>');
  });

  test("preserves an offset viewBox while adding padding", () => {
    const source =
      '<svg viewBox="-10 -5 100 50" width="100pt" height="50pt"><path d="M 0 0"/></svg>';
    const padded = decode(padDiagramThumbnailSvg(encode(source)));
    expect(padded).toContain('viewBox="-18 -13 116 66"');
  });

  test("adds intrinsic dimensions when the root only has a viewBox", () => {
    const source = '<svg viewBox="0 0 100 50"><path d="M 0 0"/></svg>';
    const padded = decode(padDiagramThumbnailSvg(encode(source)));
    expect(padded).toContain('viewBox="-8 -8 116 66"');
    expect(padded).toContain('width="116pt"');
    expect(padded).toContain('height="66pt"');
  });

  test("leaves SVG without a viewBox untouched", () => {
    const source = '<svg width="100" height="50"><path d="M 0 0"/></svg>';
    expect(decode(padDiagramThumbnailSvg(encode(source)))).toBe(source);
  });
});
