export function pagesToEvict(
  renderedPages: readonly number[],
  focusPage: number,
  maximumResidentPages: number
): number[] {
  if (maximumResidentPages < 1) return [...renderedPages];
  const excess = renderedPages.length - maximumResidentPages;
  if (excess <= 0) return [];
  return [...renderedPages]
    .sort((left, right) =>
      Math.abs(right - focusPage) - Math.abs(left - focusPage)
      || right - left
    )
    .slice(0, excess);
}
