export type PreviewPageViewportRect = {
  pageNo: number;
  left: number;
  top: number;
  width: number;
  height: number;
};

export type PreviewViewportAnchor = {
  pageNo: number;
  pageXRatio: number;
  pageYRatio: number;
  viewportXRatio: number;
  viewportYRatio: number;
};

export type PreviewViewportDelta = {
  left: number;
  top: number;
};

const clampUnit = (value: number): number => Math.max(0, Math.min(1, value));

function verticalDistance(rect: PreviewPageViewportRect, y: number): number {
  if (y < rect.top) return rect.top - y;
  if (y > rect.top + rect.height) return y - (rect.top + rect.height);
  return 0;
}

export function capturePreviewViewportAnchor(
  pages: readonly PreviewPageViewportRect[],
  viewportWidth: number,
  viewportHeight: number,
  point?: { x: number; y: number },
): PreviewViewportAnchor | null {
  if (pages.length === 0 || viewportWidth <= 0 || viewportHeight <= 0) return null;
  const viewportXRatio = point ? clampUnit(point.x / viewportWidth) : 0.5;
  const viewportYRatio = point ? clampUnit(point.y / viewportHeight) : 0.5;
  const referenceX = viewportWidth * viewportXRatio;
  const referenceY = viewportHeight * viewportYRatio;
  const page = pages
    .filter(candidate => candidate.width > 0 && candidate.height > 0)
    .reduce<PreviewPageViewportRect | null>((closest, candidate) => {
      if (!closest) return candidate;
      return verticalDistance(candidate, referenceY) < verticalDistance(closest, referenceY)
        ? candidate
        : closest;
    }, null);
  if (!page) return null;
  return {
    pageNo: page.pageNo,
    pageXRatio: clampUnit((referenceX - page.left) / page.width),
    pageYRatio: clampUnit((referenceY - page.top) / page.height),
    viewportXRatio,
    viewportYRatio,
  };
}

export function previewViewportAnchorDelta(
  anchor: PreviewViewportAnchor,
  page: PreviewPageViewportRect,
  viewportWidth: number,
  viewportHeight: number,
): PreviewViewportDelta {
  return {
    left: page.left + (page.width * anchor.pageXRatio)
      - (viewportWidth * anchor.viewportXRatio),
    top: page.top + (page.height * anchor.pageYRatio)
      - (viewportHeight * anchor.viewportYRatio),
  };
}
