import { RangeSet, RangeSetBuilder, StateEffect, StateField } from "@codemirror/state";
import type { Extension, EditorState } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { Decoration, EditorView, GutterMarker, ViewPlugin } from "@codemirror/view";
import type { DecorationSet } from "@codemirror/view";
import type { LspLocation, TinymistLspClient } from "../compiler/lsp";
import { createAppIcon } from "../ui/icons";

export type LetBindingDeclaration = {
  name: string;
  from: number;
  to: number;
  line: number;
  character: number;
  kind: "function" | "variable";
};

const bindingIdentifier = /^\s+([\p{L}_][\p{L}\p{N}_-]*)(?=\s*(?:\(|=|:))/u;

export function findLetBindingDeclarations(state: EditorState): LetBindingDeclaration[] {
  const declarations: LetBindingDeclaration[] = [];
  const cursor = syntaxTree(state).cursor();
  do {
    if (cursor.name !== "keyword" || cursor.node.type.isAnonymous || state.doc.sliceString(cursor.from, cursor.to) !== "let") {
      continue;
    }

    const rest = state.doc.sliceString(cursor.to, Math.min(state.doc.length, cursor.to + 1024));
    const match = bindingIdentifier.exec(rest);
    if (!match) continue;
    const name = match[1];
    const from = cursor.to + match.index + match[0].indexOf(name);
    const line = state.doc.lineAt(from);
    const afterName = rest.slice(match.index + match[0].indexOf(name) + name.length);
    declarations.push({
      name,
      from,
      to: from + name.length,
      line: line.number - 1,
      character: from - line.from,
      kind: /^\s*\(/u.test(afterName) ? "function" : "variable",
    });
  } while (cursor.next());
  return declarations;
}

export function hasOtherWorkspaceReferences(
  locations: readonly LspLocation[],
  uri: string,
  declaration: Pick<LetBindingDeclaration, "line" | "character">,
): boolean | null {
  const normalizeUri = (value: string | undefined) => value?.replace(/\\/gu, "/").toLowerCase();
  const normalizedUri = normalizeUri(uri);
  const isDeclarationLocation = (location: LspLocation) => {
    const locationUri = normalizeUri(location.uri ?? location.targetUri);
    const range = location.range ?? location.targetRange;
    return locationUri === normalizedUri
      && range?.start.line === declaration.line
      && range.start.character === declaration.character;
  };
  const hasDeclaration = locations.some(isDeclarationLocation);
  if (!hasDeclaration) return null;
  return locations.some(location => !isDeclarationLocation(location));
}

const unusedBindingDecorations = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, transaction) {
    let decorations = transaction.docChanged ? Decoration.none : value.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (effect.is(setUnusedBindingPresentationEffect)) decorations = effect.value.decorations;
    }
    return decorations;
  },
  provide: field => EditorView.decorations.from(field),
});

export class UnusedBindingMarker extends GutterMarker {
  constructor(readonly message: string, readonly name: string) {
    super();
  }

  eq(other: GutterMarker): boolean {
    return other instanceof UnusedBindingMarker
      && other.message === this.message
      && other.name === this.name;
  }

  toDOM(): HTMLElement {
    const marker = document.createElement("span");
    marker.className = "cm-unused-binding-marker";
    marker.appendChild(createAppIcon("triangleAlert", { size: 17 }));
    marker.title = this.message;
    marker.setAttribute("aria-label", this.message);
    return marker;
  }
}

export type UnusedBindingPresentation = {
  decorations: DecorationSet;
  markers: RangeSet<GutterMarker>;
};

export const setUnusedBindingPresentationEffect = StateEffect.define<UnusedBindingPresentation>({
  map: (presentation, changes) => ({
    decorations: presentation.decorations.map(changes),
    markers: presentation.markers.map(changes),
  }),
});

const unusedBindingMarkerField = StateField.define<RangeSet<GutterMarker>>({
  create: () => RangeSet.empty,
  update(value, transaction) {
    let markers = transaction.docChanged ? value.map(transaction.changes) : value;
    for (const effect of transaction.effects) {
      if (effect.is(setUnusedBindingPresentationEffect)) markers = effect.value.markers;
    }
    return markers;
  },
});

export { unusedBindingMarkerField };

const UNUSED_BINDING_TITLE = "No references found in this workspace. This symbol may still be used by an external project.";
const MAX_BINDINGS_TO_CHECK = 128;
const REFERENCE_CONCURRENCY = 2;
const UNUSED_ANALYSIS_DELAY_MS = 1_500;

export function identifierOccurrenceCount(source: string, name: string): number {
  const identifier = /[\p{L}_][\p{L}\p{N}_-]*/gu;
  let count = 0;
  for (const match of source.matchAll(identifier)) {
    if (match[0] === name) count += 1;
  }
  return count;
}

export function buildUnusedBindingPresentation(
  declarations: readonly LetBindingDeclaration[],
  unused: ReadonlySet<LetBindingDeclaration>,
  docLength: number,
): UnusedBindingPresentation {
  const decorationBuilder = new RangeSetBuilder<Decoration>();
  const markerBuilder = new RangeSetBuilder<GutterMarker>();
  const sorted = declarations
    .filter(declaration => unused.has(declaration))
    .sort((left, right) => left.from - right.from);
  for (const declaration of sorted) {
    if (declaration.from < 0 || declaration.to > docLength || declaration.to <= declaration.from) continue;
    const message = `${declaration.name} (${declaration.kind}) is not used in this workspace. ${UNUSED_BINDING_TITLE}`;
    decorationBuilder.add(declaration.from, declaration.to, Decoration.mark({
      class: "cm-unused-binding",
      attributes: { title: UNUSED_BINDING_TITLE },
    }));
    markerBuilder.add(declaration.from, declaration.from, new UnusedBindingMarker(message, declaration.name));
  }
  return {
    decorations: decorationBuilder.finish(),
    markers: markerBuilder.finish(),
  };
}

const emptyUnusedBindingPresentation: UnusedBindingPresentation = {
  decorations: Decoration.none,
  markers: RangeSet.empty,
};

export function unusedBindingsExtension(
  getClient: () => TinymistLspClient | undefined,
  getUri: () => string,
  flushLspSync: () => void | Promise<void>,
): Extension {
  return [unusedBindingDecorations, unusedBindingMarkerField, ViewPlugin.fromClass(class {
    private timer: number | null = null;
    private generation = 0;
    private clientRetries = 0;

    constructor(private readonly view: EditorView) {
      this.schedule();
    }

    update(update: import("@codemirror/view").ViewUpdate): void {
      if (update.docChanged) this.schedule();
    }

    destroy(): void {
      this.generation += 1;
      if (this.timer !== null) window.clearTimeout(this.timer);
      this.timer = null;
    }

    private schedule(delay = UNUSED_ANALYSIS_DELAY_MS): void {
      this.generation += 1;
      const generation = this.generation;
      if (this.timer !== null) window.clearTimeout(this.timer);
      this.timer = window.setTimeout(() => {
        this.timer = null;
        void this.refresh(generation);
      }, delay);
    }

    private async refresh(generation: number): Promise<void> {
      const client = getClient();
      if (!client) {
        if (this.clientRetries++ < 8 && generation === this.generation) this.schedule(500);
        return;
      }
      this.clientRetries = 0;
      const state = this.view.state;
      const doc = state.doc;
      const uri = getUri();
      if (!uri.toLowerCase().endsWith(".typ")) {
        this.view.dispatch({ effects: setUnusedBindingPresentationEffect.of(emptyUnusedBindingPresentation) });
        return;
      }
      const declarations = findLetBindingDeclarations(state);
      if (declarations.length === 0 || !uri) {
        this.view.dispatch({ effects: setUnusedBindingPresentationEffect.of(emptyUnusedBindingPresentation) });
        return;
      }

      try {
        await flushLspSync();
      } catch {
        return;
      }
      if (generation !== this.generation || this.view.state.doc !== doc || getUri() !== uri) return;

      const source = doc.toString();
      const candidates = declarations.filter(declaration =>
        identifierOccurrenceCount(source, declaration.name) === 1
      );
      if (candidates.length > MAX_BINDINGS_TO_CHECK) return;
      const unused = new Set<LetBindingDeclaration>();
      for (let offset = 0; offset < candidates.length; offset += REFERENCE_CONCURRENCY) {
        const batch = candidates.slice(offset, offset + REFERENCE_CONCURRENCY);
        const results = await Promise.all(batch.map(async declaration => {
          const locations = await client.getReferences(uri, {
            line: declaration.line,
            character: declaration.character,
          });
          return { declaration, locations };
        }));
        if (generation !== this.generation || this.view.state.doc !== doc || getUri() !== uri) return;
        for (const { declaration, locations } of results) {
          if (hasOtherWorkspaceReferences(locations, uri, declaration) === false) unused.add(declaration);
        }
      }
      if (generation !== this.generation || this.view.state.doc !== doc || getUri() !== uri) return;
      this.view.dispatch({
        effects: setUnusedBindingPresentationEffect.of(
          buildUnusedBindingPresentation(declarations, unused, doc.length),
        ),
      });
    }
  })];
}
