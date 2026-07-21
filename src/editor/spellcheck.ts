import { StateEffect, StateField, type EditorState, type Extension, type Text } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { Decoration, EditorView, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { invoke } from "@tauri-apps/api/core";
import {
  parseLanguageProviderCapabilitiesList,
  type LanguageProviderCapabilities
} from "../languageSupport";
import { editingPolicyRegistry } from "./editingPolicies/registry";
import type { PerformanceMetric } from "../performance/diagnostics";
import { type DocumentScriptFont } from "./documentTypography";
import { selectDocumentLanguageProvider } from "./languageScopes/documentLanguage";
import type { LanguageTerminologyEntry, ScopedIgnoredWord, TerminologyEntry } from "../settings";

export type EditorToken = {
  provider: string;
  sourceFromUtf16: number;
  sourceToUtf16: number;
  sourceText: string;
  normalizedText: string;
  known: boolean;
  knownPrefix: boolean;
  hyphenated?: string;
};

export type AnalyzeResponse = {
  tokens: EditorToken[];
  failures: ProviderFailure[];
};

export type ProviderFailure = {
  provider: string;
  operation: string;
  sourceFromUtf16: number;
  sourceToUtf16: number;
  message: string;
};

export type ProviderCapabilities = LanguageProviderCapabilities;

type RoutedAnalyzeChunk = {
  text: string;
  startUtf16: number;
  provider?: string;
  contentMode: "plainText" | "typstSource";
};

export type SpellingIssue = {
  provider: string;
  documentKey: string;
  revision: number;
  docIdentity: Text;
  from: number;
  to: number;
  sourceText: string;
  word: string;
  knownPrefix: boolean;
  ignored: boolean;
  synthetic?: boolean;
  languageFamily?: string;
};

export type SpellcheckDebugEvent = {
  stage: string;
  documentKey: string;
  revision: number;
  detail: Record<string, unknown>;
};

const setSpellingIssues = StateEffect.define<SpellingIssue[]>();
const spellingField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, transaction) {
    value = value.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (!effect.is(setSpellingIssues)) continue;
      const decorations = effect.value.map(issue => Decoration.mark({
        class: issue.ignored ? "cm-spelling-ignored" : "cm-spelling-unknown",
        attributes: { title: issue.ignored
          ? `${issue.word} is ignored but is not in the selected language dictionary`
          : `${issue.word} is not in the selected language dictionary` }
      }).range(issue.from, issue.to));
      return Decoration.set(decorations, true);
    }
    return value;
  },
  provide: field => EditorView.decorations.from(field)
});

export function expandSpellcheckRange(doc: Text, from: number, to: number, patterns: RegExp[]): { from: number, to: number } {
  const matchesAny = (char: string) => patterns.some(pat => pat.test(char));
  let newFrom = from;
  while (newFrom > 0 && matchesAny(doc.sliceString(newFrom - 1, newFrom))) {
    newFrom--;
  }
  while (newFrom > 0 && !matchesAny(doc.sliceString(newFrom - 1, newFrom)) && doc.sliceString(newFrom - 1, newFrom) !== "\n") {
    newFrom--;
  }
  while (newFrom > 0 && matchesAny(doc.sliceString(newFrom - 1, newFrom))) {
    newFrom--;
  }
  
  let newTo = to;
  const docLength = doc.length;
  while (newTo < docLength && matchesAny(doc.sliceString(newTo, newTo + 1))) {
    newTo++;
  }
  while (newTo < docLength && !matchesAny(doc.sliceString(newTo, newTo + 1)) && doc.sliceString(newTo, newTo + 1) !== "\n") {
    newTo++;
  }
  while (newTo < docLength && matchesAny(doc.sliceString(newTo, newTo + 1))) {
    newTo++;
  }
  
  const lineStart = doc.lineAt(from).from;
  const lineEnd = doc.lineAt(to).to;
  return {
    from: Math.max(lineStart, newFrom),
    to: Math.min(lineEnd, newTo)
  };
}

function matchesTerminology(word: string, entries: readonly TerminologyEntry[]): boolean {
  return entries.some((entry) => entry.exactCase
    ? entry.term === word
    : entry.term.localeCompare(word, undefined, { sensitivity: "base" }) === 0);
}

function terminologyKeys(
  global: readonly TerminologyEntry[],
  project: readonly TerminologyEntry[],
  language: readonly LanguageTerminologyEntry[],
  ignored: readonly ScopedIgnoredWord[],
): Set<string> {
  return new Set([
    ...global.map((entry) => entry.term),
    ...project.map((entry) => entry.term),
    ...language.map((entry) => entry.term),
    ...ignored.map((entry) => entry.term),
  ]);
}

function symmetricDifference(left: Set<string>, right: Set<string>): string[] {
  return [...left].filter((value) => !right.has(value)).concat([...right].filter((value) => !left.has(value)));
}

function countValues(values: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

function findTermRanges(source: string, terms: readonly string[]): Array<{ from: number; to: number }> {
  const ranges: Array<{ from: number; to: number }> = [];
  for (const term of terms.slice(0, 128)) {
    if (!term) continue;
    let from = 0;
    while ((from = source.indexOf(term, from)) >= 0 && ranges.length < 2_000) {
      ranges.push({ from, to: from + term.length });
      from += Math.max(1, term.length);
    }
  }
  return ranges;
}

export function coalesceSpellcheckRanges(ranges: { from: number; to: number }[]): { from: number; to: number }[] {
  if (ranges.length === 0) return [];
  const sorted = [...ranges].sort((a, b) => a.from - b.from);
  const coalesced: { from: number; to: number }[] = [];
  for (const r of sorted) {
    if (coalesced.length === 0) {
      coalesced.push(r);
    } else {
      const last = coalesced[coalesced.length - 1];
      if (r.from <= last.to) {
        last.to = Math.max(last.to, r.to);
      } else {
        coalesced.push(r);
      }
    }
  }
  return coalesced;
}

export function isTypstProseRange(state: EditorState, from: number, to: number): boolean {
  if (from < 0 || to <= from || to > state.doc.length) return false;
  if (typeof (state as { field?: unknown }).field !== "function") return true;
  const tree = syntaxTree(state);
  const proseToken = (position: number, bias: -1 | 1): boolean => {
    const names = new Set(tree.resolveInner(position, bias).name.split(" "));
    return names.has("content") || names.has("heading") || names.has("term");
  };
  return proseToken(from, 1) && proseToken(to, -1);
}

export class SpellcheckController {
  private enabled = true;
  private timer: number | null = null;
  private revision = 0;
  private documentKey = "";
  private suggestionRequestGeneration = 0;
  private visibilityRefreshGeneration = 0;
  private completionActive = false;
  private activeTypingPosition: number | null = null;
  private readonly warnedFailures = new Set<string>();
  private userDictionary = new Set<string>();
  private ignoredWords = new Set<string>();
  private globalTerminology: TerminologyEntry[] = [];
  private projectTerminology: TerminologyEntry[] = [];
  private languageTerminology: LanguageTerminologyEntry[] = [];
  private scopedIgnoredWords: ScopedIgnoredWord[] = [];
  private terminologySignature = "";
  public issues: SpellingIssue[] = [];
  private suggestionCache = new Map<string, string[]>();
  private providers: ProviderCapabilities[] = [];
  private documentScriptFonts: DocumentScriptFont[] = [];
  private providerCatalogReady = false;
  
  private pendingRanges: { from: number; to: number }[] = [];
  private activeRequest: { documentKey: string; revision: number; docIdentity: Text } | null = null;
  private queuedRequest: { ranges: { from: number; to: number }[] } | null = null;

  constructor(
    private readonly getEditor: () => EditorView,
    private readonly onIssuesChanged?: (issues: readonly SpellingIssue[]) => void,
    private readonly onPerformance?: (metric: Omit<PerformanceMetric, "recordedAt">) => void,
    private readonly onDebug?: (event: SpellcheckDebugEvent) => void,
  ) {}

  public async initialize(): Promise<void> {
    const startedAt = performance.now();
    const providers = await Promise.allSettled([invoke<unknown>("get_provider_capabilities")]);
    if (providers[0].status === "fulfilled") {
      try {
        this.providers = parseLanguageProviderCapabilitiesList(providers[0].value);
      } catch (error) {
        console.error("Failed to parse provider capabilities:", error);
      }
    } else {
      console.error("Failed to fetch provider capabilities:", providers[0].reason);
    }
    this.providerCatalogReady = true;
    this.onPerformance?.({
      name: "startup.providers",
      milliseconds: performance.now() - startedAt,
      detail: { providerCount: this.providers.length }
    });
  }

  public getProviders(): ProviderCapabilities[] {
    return this.providers;
  }

  public getAllProviders(): ProviderCapabilities[] {
    return this.providers;
  }

  public setProviders(providers: unknown): void {
    this.providers = parseLanguageProviderCapabilitiesList(providers);
    this.providerCatalogReady = true;
    this.trace("providers-updated", {
      installedProviders: this.providers.map((provider) => provider.id),
      configuredScripts: this.documentScriptFonts.map((entry) => `${entry.script}:${entry.language ?? "off"}`),
    });
    this.invalidate(true);
    const doc = this.getEditor()?.state.doc;
    if (doc) {
      this.pendingRanges = [{ from: 0, to: doc.length }];
      this.schedule();
    }
  }

  private getPatterns(): RegExp[] {
    return this.configuredProviders()
      .filter(provider => provider.supportsSpellcheck !== false)
      .map(provider => new RegExp(provider.pattern, "u"));
  }

  public extension(): Extension {
    return spellingField;
  }

  public setDocumentScripts(entries: readonly DocumentScriptFont[]): void {
    const next = entries.map((entry) => ({ ...entry }));
    if (JSON.stringify(next) === JSON.stringify(this.documentScriptFonts)) return;
    this.documentScriptFonts = next;
    this.invalidateAndAnalyzeAll();
  }

  private configuredProviders(): ProviderCapabilities[] {
    return this.documentScriptFonts.flatMap((entry) => {
      const provider = selectDocumentLanguageProvider(this.providers, entry);
      return provider ? [provider] : [];
    }).filter((provider, index, all) => all.findIndex((candidate) => candidate.id === provider.id) === index);
  }

  public setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    this.invalidate(true);
    if (enabled) {
      const doc = this.getEditor()?.state.doc;
      if (doc) {
        this.pendingRanges = [{ from: 0, to: doc.length }];
        this.schedule();
      }
    }
  }

  public setUserDictionary(words: readonly string[]): void {
    const next = new Set(words);
    if (next.size === this.userDictionary.size
      && [...next].every(word => this.userDictionary.has(word))) return;
    this.userDictionary = next;
    this.invalidate(true);
    const doc = this.getEditor()?.state.doc;
    if (doc) {
      this.pendingRanges = [{ from: 0, to: doc.length }];
      this.schedule();
    }
  }

  public setTerminology(
    global: readonly TerminologyEntry[],
    project: readonly TerminologyEntry[],
    language: readonly LanguageTerminologyEntry[],
    ignored: readonly ScopedIgnoredWord[],
  ): void {
    const signature = JSON.stringify([global, project, language, ignored]);
    if (signature === this.terminologySignature) return;
    const changedTerms = symmetricDifference(
      terminologyKeys(this.globalTerminology, this.projectTerminology, this.languageTerminology, this.scopedIgnoredWords),
      terminologyKeys(global, project, language, ignored),
    );
    this.terminologySignature = signature;
    this.globalTerminology = [...global];
    this.projectTerminology = [...project];
    this.languageTerminology = [...language];
    this.scopedIgnoredWords = [...ignored];
    const editor = this.getEditor?.();
    if (!editor) return;
    this.invalidate(false);
    this.issues = this.issues
      .map((issue) => ({
        ...issue,
        revision: this.revision,
        docIdentity: editor.state.doc,
        ignored: this.ignoredWords.has(issue.word) || this.scopedIgnoredWords.some((entry) =>
          entry.term === issue.sourceText && (entry.scope !== "languageFamily"
            || entry.languageFamily === issue.languageFamily)),
      }))
      .filter((issue) => !this.acceptsIssueTerminology(issue));
    const affected = findTermRanges(editor.state.doc.toString(), changedTerms);
    this.pendingRanges = coalesceSpellcheckRanges([...this.pendingRanges, ...affected]);
    this.applyVisibleIssues();
    this.schedule();
  }

  public setIgnoredWords(words: readonly string[]): void {
    const next = new Set(words.map(word => word.trim()).filter(Boolean));
    if (next.size === this.ignoredWords.size
      && [...next].every(word => this.ignoredWords.has(word))) return;
    this.ignoredWords = next;
    this.issues = this.issues.map(issue => ({ ...issue, ignored: next.has(issue.word) }));
    this.queueVisibilityRefresh();
  }

  /** Must be called before replacing the editor state for another document. */
  public activateDocument(documentKey: string): void {
    this.documentKey = documentKey;
    this.invalidate(true);
    this.trace("document-activated", { documentUtf16: this.getEditor?.()?.state.doc.length ?? 0 });
    const editor = this.getEditor?.();
    const doc = editor?.state.doc;
    if (doc) {
      this.pendingRanges = [{ from: 0, to: doc.length }];
      this.schedule();
    }
  }

  /** Invalidates async work immediately; debounce scheduling happens afterwards. */
  public documentChanged(update: ViewUpdate): void {
    if (!this.enabled || !this.documentKey) return;
    this.revision++;
    this.suggestionRequestGeneration++;
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = null;
    if (update.transactions?.some(transaction =>
      transaction.isUserEvent("input.type")
      || transaction.isUserEvent("delete.backward")
      || transaction.isUserEvent("delete.forward"))) {
      this.typingStarted(update.state.selection.main.head);
    }

    // Map existing issues offsets through the changes
    this.issues = this.issues.map(issue => {
      const from = update.changes.mapPos(issue.from, -1);
      const to = update.changes.mapPos(issue.to, 1);
      return {
        ...issue,
        revision: this.revision,
        from,
        to,
        docIdentity: update.state.doc
      };
    });
    this.emitVisibleIssues(update.state.selection.main.head);

    // Map existing pending ranges through the changes
    this.pendingRanges = this.pendingRanges.map(r => ({
      from: update.changes.mapPos(r.from, -1),
      to: update.changes.mapPos(r.to, 1)
    }));

    // Extract new changed ranges and expand them
    const patterns = this.getPatterns();
    let newRanges: { from: number; to: number }[] = [];
    update.changes.iterChanges((_fromA, _toA, fromB, toB) => {
      newRanges.push({ from: fromB, to: toB });
    });

    newRanges = newRanges.map(r => expandSpellcheckRange(update.state.doc, r.from, r.to, patterns));
    this.pendingRanges = coalesceSpellcheckRanges([...this.pendingRanges, ...newRanges]);

    this.schedule();
  }

  public selectionChanged(preserveActiveTyping = false): void {
    this.suggestionRequestGeneration++;
    if (!preserveActiveTyping) this.activeTypingPosition = null;
    this.queueVisibilityRefresh();
  }

  public dismissActiveTyping(): void {
    if (this.activeTypingPosition === null) return;
    this.activeTypingPosition = null;
    this.queueVisibilityRefresh();
  }

  public typingStarted(position: number): void {
    this.activeTypingPosition = position;
    this.queueVisibilityRefresh();
  }

  public completionStateChanged(active: boolean): void {
    if (this.completionActive === active) return;
    this.completionActive = active;
    this.queueVisibilityRefresh();
  }

  private queueVisibilityRefresh(): void {
    const generation = ++this.visibilityRefreshGeneration;
    queueMicrotask(() => {
      if (generation === this.visibilityRefreshGeneration) this.applyVisibleIssues();
    });
  }

  public schedule(): void {
    if (!this.enabled || !this.documentKey) return;
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => {
      this.timer = null;
      void this.runAnalysis();
    }, 160);
  }

  private invalidateAndAnalyzeAll(): void {
    this.invalidate(true);
    const doc = this.getEditor?.()?.state.doc;
    if (!doc) return;
    this.pendingRanges = [{ from: 0, to: doc.length }];
    this.schedule();
  }

  public issueAt(position: number): SpellingIssue | null {
    // Incomplete-composition issues are informational editor state, not
    // dictionary entries, so they deliberately do not open spelling actions.
    return this.issues
      .filter(issue => position >= issue.from && position < issue.to && this.isCurrentIssue(issue, false))
      .sort((a, b) => (a.to - a.from) - (b.to - b.from))[0] ?? null;
  }

  public async suggestions(issue: SpellingIssue): Promise<string[]> {
    if (!this.isCurrentIssue(issue)) return [];
    // TODO: Re-enable correction menus for segmented scripts when providers can
    // identify the user's complete intended word instead of an unknown fragment.
    const provider = this.providers.find(candidate => candidate.id === issue.provider);
    if (provider?.supportsCorrections !== true) return [];
    const request = ++this.suggestionRequestGeneration;
    const cached = this.suggestionCache.get(issue.word);
    if (cached) return this.suggestionRequestIsCurrent(request, issue) ? cached : [];
    try {
      const response = await invoke<{ suggestions: string[] }>("language_suggestions", {
        request: {
          provider: issue.provider,
          word: issue.word,
          limit: 5
        }
      });
      const suggestions = response.suggestions;
      if (!this.suggestionRequestIsCurrent(request, issue)) return [];
      this.suggestionCache.set(issue.word, suggestions);
      return suggestions;
    } catch (error) {
      this.warnOnce("language_suggestions", error);
      return [];
    }
  }

  public replace(issue: SpellingIssue, replacement: string): void {
    if (!this.isCurrentIssue(issue)) {
      this.schedule();
      return;
    }
    const editor = this.getEditor();
    editor.dispatch({
      changes: { from: issue.from, to: issue.to, insert: replacement },
      selection: { anchor: issue.from + replacement.length },
      userEvent: "input.complete"
    });
    editor.focus();
  }

  public clear(): void {
    this.invalidate(true);
  }

  private invalidate(clearIssues: boolean): void {
    this.revision++;
    this.suggestionRequestGeneration++;
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = null;
    this.pendingRanges = [];
    this.queuedRequest = null;
    if (!clearIssues) return;
    this.issues = [];
    this.onIssuesChanged?.([]);
    const editor = this.getEditor();
    if (editor) editor.dispatch({ effects: setSpellingIssues.of([]) });
  }

  private async runAnalysis(): Promise<void> {
    if (!this.providerCatalogReady) return;
    if (this.activeRequest !== null) {
      if (!this.queuedRequest) {
        this.queuedRequest = { ranges: [...this.pendingRanges] };
      } else {
        this.queuedRequest.ranges = coalesceSpellcheckRanges([...this.queuedRequest.ranges, ...this.pendingRanges]);
      }
      this.pendingRanges = [];
      return;
    }

    const rangesToAnalyze = [...this.pendingRanges];
    this.pendingRanges = [];
    if (rangesToAnalyze.length === 0) return;

    const editor = this.getEditor();
    if (!editor) return;

    const docIdentity = editor.state.doc;
    const documentKey = this.documentKey;
    const revision = this.revision;

    this.activeRequest = { documentKey, revision, docIdentity };

    const routingStartedAt = performance.now();
    const chunks = this.buildAnalysisChunks(rangesToAnalyze, docIdentity);
    this.trace("analysis-routed", {
      pendingRanges: rangesToAnalyze,
      chunks: chunks.slice(0, 128).map((chunk) => ({
        from: chunk.startUtf16,
        to: chunk.startUtf16 + chunk.text.length,
        provider: chunk.provider ?? "compatibility",
        utf16: chunk.text.length,
      })),
    });
    this.onPerformance?.({
      name: "language.providerResolution",
      milliseconds: performance.now() - routingStartedAt,
      detail: { chunkCount: chunks.length, rangeCount: rangesToAnalyze.length },
    });

    if (chunks.length === 0) {
      this.activeRequest = null;
      this.applyAnalysisResponse({ tokens: [], failures: [] }, rangesToAnalyze);
      this.checkQueuedRequest();
      return;
    }

    const startTime = performance.now();
    let response: AnalyzeResponse | null = null;
    try {
      response = await invoke<AnalyzeResponse>("analyze_language_ranges", {
        request: { chunks }
      });
      response = { tokens: response.tokens, failures: response.failures ?? [] };
      for (const failure of response.failures) {
        this.warnOnce(`${failure.operation}:${failure.provider}`, failure.message);
      }
    } catch (error) {
      this.warnOnce("analyze_language_ranges", error);
    } finally {
      const duration = performance.now() - startTime;
      console.log(`[Spellcheck] Range-based analysis completed in ${duration.toFixed(2)}ms for ${chunks.length} chunk(s)`);
      this.onPerformance?.({
        name: "language.analysis",
        milliseconds: duration,
        detail: {
          chunkCount: chunks.length,
          submittedUtf16: chunks.reduce((total, chunk) => total + chunk.text.length, 0),
          documentUtf16: docIdentity.length,
          queuedRequests: this.queuedRequest ? 1 : 0
        }
      });

      this.activeRequest = null;

      if (response && this.analysisIsCurrent(documentKey, revision, docIdentity)) {
        this.applyAnalysisResponse(response, rangesToAnalyze);
      }

      this.checkQueuedRequest();
    }
  }

  private buildAnalysisChunks(ranges: readonly { from: number; to: number }[], doc: Text): RoutedAnalyzeChunk[] {
    const chunks = new Map<string, RoutedAnalyzeChunk>();
    for (const pending of ranges) {
      const text = doc.sliceString(pending.from, pending.to);
      for (const provider of this.configuredProviders()) {
        if (provider.supportsSpellcheck === false || !new RegExp(provider.pattern, "u").test(text)) continue;
        const key = `${provider.id}:${pending.from}:${pending.to}`;
        chunks.set(key, {
          text,
          startUtf16: pending.from,
          provider: provider.id,
          contentMode: "typstSource",
        });
      }
    }
    return [...chunks.values()];
  }

  private checkQueuedRequest(): void {
    if (this.queuedRequest) {
      const queued = this.queuedRequest;
      this.queuedRequest = null;
      this.pendingRanges = queued.ranges;
      void this.runAnalysis();
    }
  }

  private applyAnalysisResponse(response: AnalyzeResponse, analyzedRanges: { from: number, to: number }[]): void {
    const editor = this.getEditor();
    if (!editor) return;

    const docIdentity = editor.state.doc;
    const documentKey = this.documentKey;
    const revision = this.revision;

    const failedRanges = response.failures ?? [];
    // Remove successful providers' existing issues inside analyzed ranges, but
    // retain a provider's last valid issues where its new analysis failed.
    let nextIssues = this.issues.filter(issue => {
      const wasAnalyzed = analyzedRanges.some(range => {
        return !(issue.to <= range.from || issue.from >= range.to);
      });
      if (!wasAnalyzed) return true;
      return failedRanges.some(failure => failure.provider === issue.provider
        && issue.from < failure.sourceToUtf16
        && failure.sourceFromUtf16 < issue.to);
    });

    // Map new tokens to SpellingIssues
    const cursor = editor.state.selection.main.head;
    const rejectedByScope = response.tokens.filter((token) => !this.providerMatchesDocumentScripts(
      token.provider,
      token.sourceFromUtf16,
      token.sourceToUtf16,
    ));
    this.trace("analysis-response", {
      tokens: response.tokens.length,
      failures: response.failures?.length ?? 0,
      providers: countValues(response.tokens.map((token) => token.provider)),
      rejectedByScope: rejectedByScope.slice(0, 64).map((token) => ({
        provider: token.provider,
        from: token.sourceFromUtf16,
        to: token.sourceToUtf16,
      })),
    });
    const newIssues = response.tokens
      .filter(token => !token.known
        && !this.userDictionary.has(token.normalizedText)
        && !this.acceptsTerminology(token)
        && this.providerMatchesDocumentScripts(
          token.provider,
          token.sourceFromUtf16,
          token.sourceToUtf16,
        )
        && this.isProvenProse(editor.state, token.sourceFromUtf16, token.sourceToUtf16))
      .map(token => ({
        provider: token.provider,
        documentKey,
        revision,
        docIdentity,
        from: token.sourceFromUtf16,
        to: token.sourceToUtf16,
        sourceText: token.sourceText,
        word: token.normalizedText,
        knownPrefix: token.knownPrefix,
        ignored: this.isIgnoredTerm(token),
        languageFamily: this.providerLanguageFamily(token.provider) ?? undefined,
      }));

    const deduplicated = new Map<string, SpellingIssue>();
    for (const issue of [...nextIssues, ...newIssues]) {
      deduplicated.set(`${issue.provider}:${issue.from}:${issue.to}`, issue);
    }
    nextIssues = [...deduplicated.values()];
    nextIssues.sort((a, b) => a.from - b.from);
    this.issues = nextIssues;

    const visible = this.visibleIssues(editor, cursor);
    editor.dispatch({ effects: setSpellingIssues.of(visible) });
    this.onIssuesChanged?.(visible);

  }

  private isProvenProse(state: EditorState, from: number, to: number): boolean {
    return isTypstProseRange(state, from, to);
  }

  private acceptsTerminology(token: EditorToken): boolean {
    if (matchesTerminology(token.sourceText, this.globalTerminology)
      || matchesTerminology(token.sourceText, this.projectTerminology)) return true;
    const family = this.providerLanguageFamily(token.provider);
    return family !== null && matchesTerminology(
      token.sourceText,
      this.languageTerminology.filter((entry) => entry.languageFamily === family),
    );
  }

  private acceptsIssueTerminology(issue: SpellingIssue): boolean {
    return matchesTerminology(issue.sourceText, this.globalTerminology)
      || matchesTerminology(issue.sourceText, this.projectTerminology)
      || Boolean(issue.languageFamily && matchesTerminology(
        issue.sourceText,
        this.languageTerminology.filter((entry) => entry.languageFamily === issue.languageFamily),
      ));
  }

  private isIgnoredTerm(token: EditorToken): boolean {
    if (this.ignoredWords.has(token.normalizedText)) return true;
    const family = this.providerLanguageFamily(token.provider);
    return this.scopedIgnoredWords.some((entry) => entry.term === token.sourceText
      && (entry.scope === "global" || entry.scope === "project"
        || (entry.scope === "languageFamily" && entry.languageFamily === family)));
  }

  private providerLanguageFamily(providerId: string): string | null {
    const tag = this.providers.find((provider) => provider.id === providerId)?.languageTag;
    const family = tag?.split(/[-_]/)[0]?.toLowerCase();
    return family && /^[a-z]{2,3}$/.test(family) ? family : null;
  }

  private emitVisibleIssues(cursor = this.getEditor().state.selection.main.head): void {
    const editor = this.getEditor();
    const visible = this.visibleIssues(editor, cursor);
    this.onIssuesChanged?.(visible);
  }

  private applyVisibleIssues(cursor = this.getEditor().state.selection.main.head): void {
    const editor = this.getEditor();
    const visible = this.visibleIssues(editor, cursor);
    editor.dispatch({ effects: setSpellingIssues.of(visible) });
    this.onIssuesChanged?.(visible);
  }

  private visibleIssues(editor: EditorView, cursor: number): SpellingIssue[] {
    const visible = this.issues.filter(issue => issue.revision === this.revision
      && issue.docIdentity === editor.state.doc
      && this.providerMatchesDocumentScripts(issue.provider, issue.from, issue.to)
      && !this.shouldHideKnownPrefix(issue, cursor));
    const incomplete = this.incompleteCompositionIssue(editor);
    if (incomplete && !this.shouldHideKnownPrefix(incomplete, cursor)) visible.push(incomplete);
    return visible;
  }

  private providerMatchesDocumentScripts(providerId: string, from: number, to: number): boolean {
    const provider = this.configuredProviders().find((candidate) => candidate.id === providerId);
    if (!provider) return false;
    const source = this.getEditor().state.doc.sliceString(from, to);
    return new RegExp(provider.pattern, "u").test(source);
  }

  private trace(stage: string, detail: Record<string, unknown>): void {
    this.onDebug?.({ stage, documentKey: this.documentKey, revision: this.revision, detail });
  }

  private incompleteCompositionIssue(editor: EditorView): SpellingIssue | null {
    if (typeof (editor.state as { field?: unknown }).field !== "function") return null;
    const incomplete = editingPolicyRegistry.incompleteComposition(editor.state);
    if (!incomplete) return null;
    const sourceText = editor.state.doc.sliceString(incomplete.range.from, incomplete.range.to);
    return {
      provider: `${incomplete.policyId}-editing-policy`,
      documentKey: this.documentKey,
      revision: this.revision,
      docIdentity: editor.state.doc,
      from: incomplete.range.from,
      to: incomplete.range.to,
      sourceText,
      word: sourceText,
      knownPrefix: true,
      ignored: false,
      synthetic: true
    };
  }

  private shouldHideKnownPrefix(issue: SpellingIssue, cursor: number): boolean {
    return cursor === issue.to && (
      this.activeTypingPosition === cursor
      || (issue.knownPrefix && this.completionActive)
    );
  }

  private analysisIsCurrent(documentKey: string, revision: number, docIdentity: Text): boolean {
    const editor = this.getEditor();
    return this.enabled && this.documentKey === documentKey && this.revision === revision
      && editor.state.doc === docIdentity;
  }

  private suggestionRequestIsCurrent(request: number, issue: SpellingIssue): boolean {
    return request === this.suggestionRequestGeneration && this.isCurrentIssue(issue);
  }

  private isCurrentIssue(issue: SpellingIssue, verifyText = true): boolean {
    const editor = this.getEditor();
    return this.enabled && issue.documentKey === this.documentKey && issue.revision === this.revision
      && issue.docIdentity === editor.state.doc
      && (!verifyText || editor.state.doc.sliceString(issue.from, issue.to) === issue.sourceText);
  }


  private warnOnce(command: string, error: unknown): void {
    const key = `${command}:${String(error)}`;
    if (this.warnedFailures.has(key)) return;
    this.warnedFailures.add(key);
    console.warn(`Spellcheck ${command} failed:`, error);
  }
}
