import { filePathKey } from "../platform/paths";
import {
  ProjectTextRequestCancelled,
  textRevisionToken,
  type ProjectTextService,
  type ProjectTextSkippedFile,
} from "../workspace/projectTextService";
import {
  PROJECT_SEARCH_DEBOUNCE_MS,
  PROJECT_SEARCH_MAX_RESULTS,
  PROJECT_SEARCH_REGEX_TIMEOUT_MS,
  parseProjectSearchGlobs,
  projectSearchFileMatchesFilters,
  type ProjectSearchFileInput,
  type ProjectSearchFileResult,
  type ProjectSearchLineMatch,
  type ProjectSearchMode,
  type ProjectSearchOptions,
  type ProjectSearchWorkerRequest,
  type ProjectSearchWorkerResponse,
} from "./projectSearch";

export type ProjectSearchNavigationTarget = {
  path: string;
  revision: string;
  textRevision: string;
  from: number;
  to: number;
  kind: "content" | "path";
};

export interface ProjectSearchControllerDependencies {
  workspaceRootPath(): string | null;
  projectText(): ProjectTextService;
  openResult(target: ProjectSearchNavigationTarget): Promise<void> | void;
}

type SearchState = {
  options: ProjectSearchOptions;
  searching: boolean;
  truncated: boolean;
  incomplete: boolean;
  error: string | null;
};

const DEFAULT_OPTIONS: ProjectSearchOptions = {
  query: "",
  mode: "literal",
  caseSensitive: false,
  wholeWord: false,
  matchDiacritics: true,
  includeIgnored: false,
  includeGlobs: [],
  excludeGlobs: [],
};

export class ProjectSearchController {
  private initialized = false;
  private worker: Worker | null = null;
  private debounceTimer: number | null = null;
  private watchdogTimer: number | null = null;
  private renderFrame: number | null = null;
  private generation = 0;
  private requestCounter = 0;
  private activeRequestId = 0;
  private readAbort: AbortController | null = null;
  private readonly fileResults = new Map<string, ProjectSearchFileResult>();
  private skippedFiles: readonly ProjectTextSkippedFile[] = [];
  private state: SearchState = {
    options: { ...DEFAULT_OPTIONS },
    searching: false,
    truncated: false,
    incomplete: false,
    error: null,
  };

  constructor(private readonly deps: ProjectSearchControllerDependencies) {}

  public show(): void {
    this.initialize();
    requestAnimationFrame(() => {
      const input = this.queryInput();
      input?.focus();
      input?.select();
    });
  }

  public reset(): void {
    this.cancelWork();
    this.generation += 1;
    this.fileResults.clear();
    this.skippedFiles = [];
    this.state = {
      options: { ...DEFAULT_OPTIONS },
      searching: false,
      truncated: false,
      incomplete: false,
      error: null,
    };
    const input = this.queryInput();
    if (input) input.value = "";
    this.resetOptionControls();
    this.scheduleRender();
  }

  public focusQuery(): void {
    this.initialize();
    this.queryInput()?.focus();
  }

  private initialize(): void {
    if (this.initialized) return;
    this.initialized = true;
    const input = this.queryInput();
    if (!input) return;
    input.addEventListener("input", () => this.scheduleSearch());
    input.addEventListener("keydown", event => {
      if (event.key === "Enter") {
        event.preventDefault();
        this.scheduleSearch(0);
      }
    });
    this.modeSelect()?.addEventListener("change", () => {
      this.updateModeControls();
      this.scheduleSearch(0);
    });
    for (const element of [
      this.caseCheckbox(),
      this.wholeWordCheckbox(),
      this.diacriticsCheckbox(),
      this.includeIgnoredCheckbox(),
    ]) {
      element?.addEventListener("change", () => this.scheduleSearch(0));
    }
    for (const element of [this.includeGlobsInput(), this.excludeGlobsInput()]) {
      element?.addEventListener("input", () => this.scheduleSearch());
    }
    document.getElementById("project-search-clear")?.addEventListener("click", () => {
      const field = this.queryInput();
      if (field) field.value = "";
      this.cancelWork();
      this.generation += 1;
      this.fileResults.clear();
      this.skippedFiles = [];
      this.state.searching = false;
      this.state.error = null;
      this.state.truncated = false;
      this.state.incomplete = false;
      this.scheduleRender();
      field?.focus();
    });
    this.resultsElement()?.addEventListener("click", event => {
      const button = (event.target as Element | null)?.closest<HTMLButtonElement>("button[data-search-path]");
      if (!button) return;
      void this.openResultButton(button);
    });
    this.updateModeControls();
    this.render();
  }

  private scheduleSearch(delay = PROJECT_SEARCH_DEBOUNCE_MS): void {
    this.initialize();
    if (this.debounceTimer !== null) window.clearTimeout(this.debounceTimer);
    this.cancelWork();
    this.generation += 1;
    const options = this.readOptions();
    this.state = {
      options,
      searching: options.query.trim().length > 0,
      truncated: false,
      incomplete: false,
      error: null,
    };
    this.fileResults.clear();
    this.skippedFiles = [];
    this.scheduleRender();
    if (!options.query.trim()) return;
    this.debounceTimer = window.setTimeout(() => {
      this.debounceTimer = null;
      void this.runSearch();
    }, Math.max(0, delay));
  }

  private async runSearch(): Promise<void> {
    const options = this.readOptions();
    if (!options.query.trim()) return;
    this.cancelWork();
    const generation = ++this.generation;
    this.fileResults.clear();
    this.skippedFiles = [];
    this.state = {
      options,
      searching: true,
      truncated: false,
      incomplete: false,
      error: null,
    };
    if (options.mode === "regex") {
      try {
        new RegExp(options.query, options.caseSensitive ? "" : "i");
      } catch (error) {
        this.state.searching = false;
        this.state.error = `Invalid regular expression: ${String(error)}`;
        this.scheduleRender();
        return;
      }
    }
    this.scheduleRender();
    const rootPath = this.deps.workspaceRootPath();
    if (!rootPath) {
      this.finishSearch(false);
      return;
    }
    const abort = new AbortController();
    this.readAbort = abort;
    try {
      const inventory = await this.deps.projectText().inventory({ includeIgnored: options.includeIgnored });
      if (generation !== this.generation || this.deps.workspaceRootPath() !== rootPath) return;
      const files = inventory.files.filter(file =>
        projectSearchFileMatchesFilters(file.relativePath, options.includeGlobs, options.excludeGlobs)
      );
      this.skippedFiles = inventory.skipped.filter(file =>
        projectSearchFileMatchesFilters(file.relativePath, options.includeGlobs, options.excludeGlobs)
      );
      if (files.length === 0) {
        this.finishSearch(false);
        return;
      }
      const batch = await this.deps.projectText().readFiles(files, { signal: abort.signal });
      if (generation !== this.generation || this.deps.workspaceRootPath() !== rootPath) return;
      this.skippedFiles = [...this.skippedFiles, ...batch.skipped];
      const inputs: ProjectSearchFileInput[] = batch.snapshots.map(snapshot => ({
        path: snapshot.file.path,
        relativePath: snapshot.file.relativePath,
        revision: snapshot.revision,
        textRevision: textRevisionToken(snapshot.text),
        text: snapshot.text,
      }));
      if (inputs.length === 0) {
        this.finishSearch(false);
        return;
      }
      this.startWorker(options, inputs, generation);
    } catch (error) {
      if (generation !== this.generation) return;
      if (error instanceof ProjectTextRequestCancelled) {
        this.finishSearch(false);
        return;
      }
      this.state.searching = false;
      this.state.error = String(error);
      this.scheduleRender();
    } finally {
      if (this.readAbort === abort) this.readAbort = null;
    }
  }

  private startWorker(
    options: ProjectSearchOptions,
    files: readonly ProjectSearchFileInput[],
    generation: number,
  ): void {
    const requestId = ++this.requestCounter;
    this.activeRequestId = requestId;
    let worker: Worker;
    try {
      worker = new Worker(new URL("./projectSearchWorker.ts", import.meta.url), { type: "module" });
    } catch (error) {
      this.state.searching = false;
      this.state.error = `Project search worker failed to start: ${String(error)}`;
      this.scheduleRender();
      return;
    }
    this.worker = worker;
    worker.onmessage = event => {
      if (generation !== this.generation || requestId !== this.activeRequestId) return;
      this.handleWorkerMessage(event.data as ProjectSearchWorkerResponse);
    };
    worker.onerror = event => {
      if (generation !== this.generation || requestId !== this.activeRequestId) return;
      this.state.error = event.message || "Project search worker failed.";
      this.finishSearch(false);
    };
    const request: ProjectSearchWorkerRequest = {
      type: "search",
      requestId,
      options,
      files,
      limit: PROJECT_SEARCH_MAX_RESULTS,
    };
    worker.postMessage(request);
  }

  private handleWorkerMessage(message: ProjectSearchWorkerResponse): void {
    if (message.requestId !== this.activeRequestId) return;
    if (message.type === "file-start") {
      if (this.state.options.mode === "regex") this.startRegexWatchdog(message.requestId);
      return;
    }
    if (message.type === "file-result") {
      this.fileResults.set(filePathKey(message.result.path), message.result);
      if (message.result.error) this.state.error = message.result.error;
      this.scheduleRender();
      return;
    }
    if (message.type === "error") {
      this.state.error = message.message;
      this.finishSearch(this.state.truncated);
      return;
    }
    this.finishSearch(message.truncated);
  }

  private startRegexWatchdog(requestId: number): void {
    this.clearWatchdog();
    this.watchdogTimer = window.setTimeout(() => {
      this.watchdogTimer = null;
      if (requestId !== this.activeRequestId || !this.worker) return;
      this.state.incomplete = true;
      this.state.error = "A regular expression exceeded the 1 second per-file limit. Results are incomplete.";
      const worker = this.worker;
      this.worker = null;
      this.activeRequestId = 0;
      worker.terminate();
      this.state.searching = false;
      this.scheduleRender();
    }, PROJECT_SEARCH_REGEX_TIMEOUT_MS + 100);
  }

  private finishSearch(truncated: boolean): void {
    this.state.searching = false;
    this.state.truncated = this.state.truncated || truncated;
    this.clearWatchdog();
    const worker = this.worker;
    this.worker = null;
    worker?.terminate();
    this.activeRequestId = 0;
    this.scheduleRender();
  }

  private cancelWork(): void {
    if (this.debounceTimer !== null) {
      window.clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.clearWatchdog();
    this.readAbort?.abort();
    this.readAbort = null;
    const worker = this.worker;
    this.worker = null;
    worker?.terminate();
    this.activeRequestId = 0;
    this.deps.projectText().cancel();
  }

  private clearWatchdog(): void {
    if (this.watchdogTimer !== null) {
      window.clearTimeout(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  private scheduleRender(): void {
    if (this.renderFrame !== null) return;
    this.renderFrame = requestAnimationFrame(() => {
      this.renderFrame = null;
      this.render();
    });
  }

  private render(): void {
    this.renderStatus();
    const results = this.resultsElement();
    if (!results) return;
    const files = [...this.fileResults.values()].sort((left, right) => {
      if (this.state.options.mode === "fuzzy") {
        const leftScore = left.pathMatch?.score ?? left.contentMatches[0]?.score ?? 0;
        const rightScore = right.pathMatch?.score ?? right.contentMatches[0]?.score ?? 0;
        if (leftScore !== rightScore) return rightScore - leftScore;
      }
      return left.relativePath.localeCompare(right.relativePath);
    });
    const pathMatches = files.filter(file => file.pathMatch);
    const contentFiles = files.filter(file => file.contentMatchCount > 0);
    const nodes: HTMLElement[] = [];
    if (this.state.error) nodes.push(this.notice(this.state.error, "error"));
    if (this.state.truncated) {
      nodes.push(this.notice(
        `Showing the first ${PROJECT_SEARCH_MAX_RESULTS.toLocaleString()} matches. Narrow the query to continue.`,
        "warning",
      ));
    }
    if (this.state.incomplete) {
      nodes.push(this.notice("Search results are incomplete.", "warning"));
    }
    if (this.skippedFiles.length > 0) {
      const counts = new Map<string, number>();
      for (const file of this.skippedFiles) counts.set(file.reason, (counts.get(file.reason) ?? 0) + 1);
      const detail = [...counts.entries()]
        .map(([reason, count]) => `${count} ${reason}`)
        .join(", ");
      nodes.push(this.notice(`${this.skippedFiles.length} file${this.skippedFiles.length === 1 ? "" : "s"} skipped (${detail}).`, "info"));
    }
    if (pathMatches.length > 0) {
      const section = document.createElement("section");
      section.className = "project-search-path-section";
      const heading = document.createElement("div");
      heading.className = "project-search-section-title";
      heading.textContent = `Path matches (${pathMatches.length})`;
      section.append(heading, ...pathMatches.map(file => this.renderPathMatch(file)));
      nodes.push(section);
    }
    for (const file of contentFiles) nodes.push(this.renderFile(file));
    if (!nodes.length && !this.state.searching) {
      const empty = document.createElement("div");
      empty.className = "project-search-empty";
      empty.textContent = this.state.options.query.trim() ? "No results." : "Type to search the project.";
      nodes.push(empty);
    }
    results.replaceChildren(...nodes);
  }

  private renderStatus(): void {
    const status = document.getElementById("project-search-status");
    if (!status) return;
    const total = [...this.fileResults.values()].reduce((sum, file) => sum + file.contentMatchCount, 0);
    const pathTotal = [...this.fileResults.values()].filter(file => file.pathMatch).length;
    if (!this.state.options.query.trim()) {
      status.textContent = "Type to search the project.";
      return;
    }
    if (this.state.searching) {
      status.textContent = total > 0
        ? `${total.toLocaleString()} match${total === 1 ? "" : "es"} · searching…`
        : "Searching…";
      return;
    }
    if (this.state.error && total === 0 && pathTotal === 0) {
      status.textContent = "Search failed.";
      return;
    }
    const files = [...this.fileResults.values()].filter(file => file.contentMatchCount > 0).length;
    const parts = [`${total.toLocaleString()} match${total === 1 ? "" : "es"} in ${files} file${files === 1 ? "" : "s"}`];
    if (pathTotal > 0) parts.push(`${pathTotal} path match${pathTotal === 1 ? "" : "es"}`);
    if (this.state.truncated) parts.push("truncated");
    if (this.state.incomplete) parts.push("incomplete");
    status.textContent = parts.join(" · ");
  }

  private renderFile(file: ProjectSearchFileResult): HTMLElement {
    const section = document.createElement("section");
    section.className = "project-search-file";
    const header = document.createElement("div");
    header.className = "project-search-file-header";
    const path = document.createElement("span");
    path.className = "project-search-file-path";
    path.textContent = file.relativePath;
    path.title = file.path;
    const count = document.createElement("span");
    count.className = "project-search-file-count";
    count.textContent = String(file.contentMatchCount);
    header.append(path, count);
    section.append(header);
    for (const match of file.contentMatches) {
      section.append(this.renderContentMatch(file, match));
    }
    return section;
  }

  private renderContentMatch(file: ProjectSearchFileResult, match: ProjectSearchLineMatch): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "project-search-match";
    button.dataset.searchPath = file.path;
    button.dataset.searchRevision = file.revision;
    button.dataset.searchTextRevision = file.textRevision;
    button.dataset.searchFrom = String(match.from);
    button.dataset.searchTo = String(match.to);
    button.dataset.searchKind = "content";
    button.title = `${file.relativePath}:${match.lineNumber}`;
    const lineNumber = document.createElement("span");
    lineNumber.className = "project-search-line-number";
    lineNumber.textContent = String(match.lineNumber);
    const excerpt = document.createElement("span");
    excerpt.className = "project-search-excerpt";
    this.appendHighlightedExcerpt(excerpt, match.lineText, match.ranges);
    button.append(lineNumber, excerpt);
    return button;
  }

  private renderPathMatch(file: ProjectSearchFileResult): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "project-search-path-match";
    button.dataset.searchPath = file.path;
    button.dataset.searchRevision = file.revision;
    button.dataset.searchTextRevision = file.textRevision;
    button.dataset.searchFrom = "0";
    button.dataset.searchTo = "0";
    button.dataset.searchKind = "path";
    button.title = file.path;
    const path = document.createElement("span");
    path.className = "project-search-path-text";
    appendHighlighted(path, file.relativePath, file.pathMatch?.ranges ?? [], 0, file.relativePath.length);
    button.append(path);
    return button;
  }

  private appendHighlightedExcerpt(
    container: HTMLElement,
    text: string,
    ranges: readonly { from: number; to: number }[],
  ): void {
    if (ranges.length === 0) {
      container.textContent = text;
      return;
    }
    const first = ranges[0]!;
    const last = ranges[ranges.length - 1]!;
    const from = Math.max(0, first.from - 60);
    const to = Math.min(text.length, last.to + 100);
    if (from > 0) container.append("…");
    appendHighlighted(container, text, ranges, from, to);
    if (to < text.length) container.append("…");
  }

  private notice(text: string, kind: "info" | "warning" | "error"): HTMLElement {
    const element = document.createElement("div");
    element.className = `project-search-notice ${kind}`;
    element.textContent = text;
    return element;
  }

  private async openResultButton(button: HTMLButtonElement): Promise<void> {
    const path = button.dataset.searchPath;
    const revision = button.dataset.searchRevision;
    const textRevision = button.dataset.searchTextRevision;
    if (!path || !revision || !textRevision) return;
    const target: ProjectSearchNavigationTarget = {
      path,
      revision,
      textRevision,
      from: Number(button.dataset.searchFrom ?? 0),
      to: Number(button.dataset.searchTo ?? 0),
      kind: button.dataset.searchKind === "path" ? "path" : "content",
    };
    try {
      const current = await this.deps.projectText().snapshot(path);
      if (current.kind !== "snapshot"
        || textRevisionToken(current.snapshot.text) !== target.textRevision) {
        this.state.error = "The file changed since these results were produced. Refreshing results.";
        this.scheduleRender();
        void this.runSearch();
        return;
      }
      await this.deps.openResult(target);
    } catch (error) {
      this.state.error = String(error);
      this.scheduleRender();
    }
  }

  private readOptions(): ProjectSearchOptions {
    const query = this.queryInput()?.value ?? "";
    return {
      query,
      mode: (this.modeSelect()?.value as ProjectSearchMode | undefined) ?? "literal",
      caseSensitive: this.caseCheckbox()?.checked ?? false,
      wholeWord: this.wholeWordCheckbox()?.checked ?? false,
      matchDiacritics: this.diacriticsCheckbox()?.checked ?? true,
      includeIgnored: this.includeIgnoredCheckbox()?.checked ?? false,
      includeGlobs: parseProjectSearchGlobs(this.includeGlobsInput()?.value ?? ""),
      excludeGlobs: parseProjectSearchGlobs(this.excludeGlobsInput()?.value ?? ""),
    };
  }

  private updateModeControls(): void {
    const mode = (this.modeSelect()?.value as ProjectSearchMode | undefined) ?? "literal";
    const fuzzy = mode === "fuzzy";
    const regex = mode === "regex";
    const wholeWord = this.wholeWordCheckbox();
    if (wholeWord) wholeWord.disabled = fuzzy;
    const diacritics = this.diacriticsCheckbox();
    if (diacritics) {
      diacritics.disabled = fuzzy || regex;
      if (regex) diacritics.checked = true;
    }
    const input = this.queryInput();
    if (input) input.placeholder = fuzzy ? "Fuzzy search project" : "Search project";
  }

  private resetOptionControls(): void {
    const mode = this.modeSelect();
    if (mode) mode.value = "literal";
    const caseField = this.caseCheckbox();
    if (caseField) caseField.checked = false;
    const wholeWord = this.wholeWordCheckbox();
    if (wholeWord) wholeWord.checked = false;
    const diacritics = this.diacriticsCheckbox();
    if (diacritics) diacritics.checked = true;
    const ignored = this.includeIgnoredCheckbox();
    if (ignored) ignored.checked = false;
    const include = this.includeGlobsInput();
    if (include) include.value = "";
    const exclude = this.excludeGlobsInput();
    if (exclude) exclude.value = "";
    this.updateModeControls();
  }

  private queryInput(): HTMLInputElement | null {
    return document.getElementById("project-search-input") as HTMLInputElement | null;
  }

  private modeSelect(): HTMLSelectElement | null {
    return document.getElementById("project-search-mode") as HTMLSelectElement | null;
  }

  private caseCheckbox(): HTMLInputElement | null {
    return document.getElementById("project-search-case") as HTMLInputElement | null;
  }

  private wholeWordCheckbox(): HTMLInputElement | null {
    return document.getElementById("project-search-whole-word") as HTMLInputElement | null;
  }

  private diacriticsCheckbox(): HTMLInputElement | null {
    return document.getElementById("project-search-diacritics") as HTMLInputElement | null;
  }

  private includeIgnoredCheckbox(): HTMLInputElement | null {
    return document.getElementById("project-search-include-ignored") as HTMLInputElement | null;
  }

  private includeGlobsInput(): HTMLInputElement | null {
    return document.getElementById("project-search-include") as HTMLInputElement | null;
  }

  private excludeGlobsInput(): HTMLInputElement | null {
    return document.getElementById("project-search-exclude") as HTMLInputElement | null;
  }

  private resultsElement(): HTMLElement | null {
    return document.getElementById("project-search-results");
  }
}

function appendHighlighted(
  container: HTMLElement,
  text: string,
  ranges: readonly { from: number; to: number }[],
  from: number,
  to: number,
): void {
  let cursor = Math.max(0, Math.min(from, text.length));
  const end = Math.max(cursor, Math.min(to, text.length));
  for (const range of ranges) {
    const rangeFrom = Math.max(cursor, Math.min(range.from, end));
    const rangeTo = Math.max(rangeFrom, Math.min(range.to, end));
    if (rangeTo <= rangeFrom) continue;
    if (rangeFrom > cursor) container.append(text.slice(cursor, rangeFrom));
    const mark = document.createElement("mark");
    mark.textContent = text.slice(rangeFrom, rangeTo);
    container.append(mark);
    cursor = rangeTo;
  }
  if (cursor < end) container.append(text.slice(cursor, end));
}
