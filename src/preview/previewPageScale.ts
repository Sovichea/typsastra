/** Apply the configured landscape width increase within the fit viewport. */
export function previewPageScale(
  pageWidth: number | undefined,
  availableWidth: number,
  fitToWidth: boolean,
  zoomPercent: number,
  pageHeight?: number,
  hasLandscapePages = false,
  landscapeScalePercent = 30,
): number {
  if (fitToWidth && pageWidth && pageWidth > 0 && availableWidth > 0) {
    const landscape = pageHeight !== undefined && pageWidth > pageHeight;
    const width = hasLandscapePages && !landscape ? availableWidth / (1 + landscapeScalePercent / 100) : availableWidth;
    return width / pageWidth;
  }
  return zoomPercent / 100;
}
