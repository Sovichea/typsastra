export type PreviewLinkTarget =
  | { kind: "external"; url: string }
  | { kind: "destination"; destination: string | unknown[] };

export function previewLinkTarget(annotation: unknown): PreviewLinkTarget | null {
  if (!annotation || typeof annotation !== "object") return null;
  const candidate = annotation as { subtype?: unknown; url?: unknown; dest?: unknown };
  if (candidate.subtype !== "Link") return null;
  if (typeof candidate.url === "string" && candidate.url.length > 0) {
    return { kind: "external", url: candidate.url };
  }
  if (typeof candidate.dest === "string" || Array.isArray(candidate.dest)) {
    return { kind: "destination", destination: candidate.dest };
  }
  return null;
}

export function previewLinkModifierPressed(event: Pick<MouseEvent | KeyboardEvent, "ctrlKey" | "metaKey">): boolean {
  return event.ctrlKey || event.metaKey;
}
