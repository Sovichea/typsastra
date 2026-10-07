/**
 * Standalone documents compile a single file in isolation. A local `#import` or
 * `#include` means the file participates in a multi-file structure, so it must
 * be promoted to a project to render correctly.
 *
 * Package imports (`@preview/...`, `@local`) are resolved from Typst's package
 * cache, not the folder, so they are allowed.
 */
const LOCAL_DEPENDENCY = /#(?:import|include)\s*\(?\s*"([^"]+)"/gu;

export function standaloneLocalDependencies(text: string): string[] {
  const paths = new Set<string>();
  for (const match of text.matchAll(LOCAL_DEPENDENCY)) {
    const target = match[1].trim();
    if (!target || target.startsWith("@")) continue;
    paths.add(target);
  }
  return [...paths];
}
