const LINES_PER_BLOCK = 10;

export const TYPST_SCALE_LINE_COUNT = 20_000;

export function buildTypstScaleDocument(): string {
  const lines: string[] = [];
  const blocks = TYPST_SCALE_LINE_COUNT / LINES_PER_BLOCK;

  for (let index = 0; index < blocks; index += 1) {
    lines.push(
      `= Section ${index}`,
      `Paragraph ${index} with អត្ថបទខ្មែរ, *strong text*, and _emphasis_.`,
      `#let value${index} = (${index} + 2) * 3`,
      `#text(size: 10pt)[Rendered content ${index}]`,
      `$ sum_(k=1)^n k + #value${index} $`,
      `- Bullet item ${index}`,
      `+ Enumerated item ${index}`,
      `/ Term ${index}: Definition ${index}`,
      `See https://example.com/section/${index} and @ref-${index} <label-${index}>.`,
      `\`raw ${index}\``,
    );
  }

  if (lines.length !== TYPST_SCALE_LINE_COUNT) {
    throw new Error(`Expected ${TYPST_SCALE_LINE_COUNT} lines, got ${lines.length}.`);
  }

  return lines.join("\n");
}
